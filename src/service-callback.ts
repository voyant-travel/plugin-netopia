import type { EventBus } from "@voyant-travel/core"
import type { PaymentSession } from "@voyant-travel/finance"
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js"

import { createNetopiaClient, resolveNetopiaRuntimeOptions } from "./client.js"
import {
  financeService,
  mapNetopiaPaymentStatus,
  mergeRecord,
  type NetopiaCallbackResult,
} from "./service-shared.js"
import type { NetopiaRuntimeOptions, NetopiaWebhookPayload } from "./types.js"

export async function handleCallback(
  db: PostgresJsDatabase,
  payload: NetopiaWebhookPayload,
  runtimeOptions: NetopiaRuntimeOptions = {},
  bindings?: Record<string, unknown>,
  financeRuntime: { eventBus?: EventBus } = {},
): Promise<NetopiaCallbackResult> {
  const runtime = resolveNetopiaRuntimeOptions(bindings, runtimeOptions)
  const orderId = payload.order.orderID
  const lookup = await financeService.listPaymentSessions(db, {
    provider: "netopia",
    externalReference: orderId,
    limit: 1,
    offset: 0,
  })

  let session: PaymentSession | null = lookup.data[0] ?? null
  if (!session) {
    session = await financeService.getPaymentSessionById(db, orderId)
  }

  if (!session) {
    return {
      action: "ignored",
      reason: "payment_session_not_found",
      session: null,
      orderId,
    }
  }

  let verifiedStatus = payload.payment.status
  let verification: NetopiaCallbackResult["verification"] = {
    outcome: runtime.trustUnverifiedCallbacks ? "trusted_unverified" : "verified",
    claimedStatus: payload.payment.status,
  }

  if (!runtime.trustUnverifiedCallbacks) {
    try {
      const statusResponse = await createNetopiaClient(runtime).getPaymentStatus({
        posID: runtime.posSignature,
        ntpID: payload.payment.ntpID,
        orderID: orderId,
      })
      if (statusResponse.order?.orderID && statusResponse.order.orderID !== orderId) {
        return {
          action: "rejected",
          reason: "status_order_mismatch",
          session,
          orderId,
          verification: {
            outcome: "rejected",
            claimedStatus: payload.payment.status,
            reason: "status_order_mismatch",
          },
        }
      }
      if (statusResponse.payment?.ntpID && statusResponse.payment.ntpID !== payload.payment.ntpID) {
        return {
          action: "rejected",
          reason: "status_transaction_mismatch",
          session,
          orderId,
          verification: {
            outcome: "rejected",
            claimedStatus: payload.payment.status,
            reason: "status_transaction_mismatch",
          },
        }
      }
      if (typeof statusResponse.payment?.status !== "number") {
        return {
          action: "deferred",
          reason: "status_lookup_missing_payment_status",
          session,
          orderId,
          verification: {
            outcome: "unavailable",
            claimedStatus: payload.payment.status,
            reason: "status_lookup_missing_payment_status",
          },
        }
      }
      verifiedStatus = statusResponse.payment.status
      verification = {
        outcome: "verified",
        claimedStatus: payload.payment.status,
        verifiedStatus,
      }
    } catch (error) {
      return {
        action: "deferred",
        reason: error instanceof Error ? error.message : "status_lookup_failed",
        session,
        orderId,
        verification: {
          outcome: "unavailable",
          claimedStatus: payload.payment.status,
          reason: "status_lookup_failed",
        },
      }
    }
  }

  const verifiedPayload: NetopiaWebhookPayload = {
    ...payload,
    payment: {
      ...payload.payment,
      status: verifiedStatus,
    },
  }
  const callbackState = mapNetopiaPaymentStatus(verifiedPayload.payment.status, runtime)
  const providerPayload = mergeRecord(session.providerPayload, {
    netopiaCallback: payload,
    netopiaCallbackVerification: verification,
  })

  // Note: we intentionally don't validate `payment.amount` / `payment.currency`
  // against the session. Netopia auto-converts non-RON orders into RON for
  // processing (so an EUR session always callbacks with `currency: "RON"` and
  // a converted amount). Any strict equality check here would reject every
  // legitimate cross-currency payment. The trustworthy field is
  // `payment.status` — the orderID is the unguessable secret that ties the
  // callback to the session, and Netopia is the only party that knows it.
  // For tamper detection beyond that, wrap this handler at the route layer
  // and verify the processed amount via your own FX source.

  if (callbackState === "processing") {
    const updated = await financeService.updatePaymentSession(db, session.id, {
      status: "processing",
      provider: "netopia",
      providerSessionId: verifiedPayload.payment.ntpID,
      providerPaymentId: verifiedPayload.payment.ntpID,
      externalReference: orderId,
      providerPayload,
    })

    return {
      action: "processing",
      session: updated,
      orderId,
      verification,
    }
  }

  if (callbackState === "completed") {
    if (session.status === "paid" || session.status === "authorized") {
      const current = await financeService.updatePaymentSession(db, session.id, {
        provider: "netopia",
        providerSessionId: verifiedPayload.payment.ntpID,
        providerPaymentId: verifiedPayload.payment.ntpID,
        externalReference: orderId,
        providerPayload,
      })

      return {
        action: "ignored",
        reason: "already_completed",
        session: current,
        orderId,
        verification,
      }
    }

    const completed = await financeService.completePaymentSession(
      db,
      session.id,
      {
        status: "paid",
        captureMode: "manual",
        paymentMethod: "credit_card",
        providerSessionId: verifiedPayload.payment.ntpID,
        providerPaymentId: verifiedPayload.payment.ntpID,
        externalReference: orderId,
        externalAuthorizationId:
          typeof verifiedPayload.payment.data?.AuthCode === "string"
            ? verifiedPayload.payment.data.AuthCode
            : verifiedPayload.payment.ntpID,
        externalCaptureId:
          typeof verifiedPayload.payment.data?.RRN === "string"
            ? verifiedPayload.payment.data.RRN
            : verifiedPayload.payment.ntpID,
        approvalCode:
          typeof verifiedPayload.payment.data?.AuthCode === "string"
            ? verifiedPayload.payment.data.AuthCode
            : undefined,
        referenceNumber:
          typeof verifiedPayload.payment.data?.RRN === "string"
            ? verifiedPayload.payment.data.RRN
            : undefined,
        authorizedAt: new Date().toISOString(),
        capturedAt: new Date().toISOString(),
        paymentDate: new Date().toISOString(),
        providerPayload,
      },
      { eventBus: financeRuntime.eventBus },
    )

    return {
      action: "completed",
      session: completed,
      orderId,
      verification,
    }
  }

  const failed = await financeService.failPaymentSession(db, session.id, {
    providerSessionId: verifiedPayload.payment.ntpID,
    providerPaymentId: verifiedPayload.payment.ntpID,
    externalReference: orderId,
    failureCode:
      typeof verifiedPayload.payment.code === "string" && verifiedPayload.payment.code.length > 0
        ? verifiedPayload.payment.code
        : `netopia_status_${verifiedPayload.payment.status}`,
    failureMessage:
      typeof verifiedPayload.payment.message === "string" &&
      verifiedPayload.payment.message.length > 0
        ? verifiedPayload.payment.message
        : "Netopia payment was not approved",
    providerPayload,
  })

  return {
    action: "failed",
    session: failed,
    orderId,
    verification,
  }
}
