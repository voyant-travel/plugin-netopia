import type { PostgresJsDatabase } from "drizzle-orm/postgres-js"

import {
  createNetopiaClient,
  type NetopiaClientApi,
  resolveNetopiaRuntimeOptions,
} from "./client.js"
import {
  buildDefaultProducts,
  centsToAmount,
  deriveNetopiaOrderId,
  financeService,
  mergeRecord,
  type NetopiaStartPaymentResult,
  normalizeCurrency,
} from "./service-shared.js"
import type {
  NetopiaRuntimeOptions,
  NetopiaStartPaymentInput,
  NetopiaStartPaymentRequest,
} from "./types.js"

export async function startPaymentSession(
  db: PostgresJsDatabase,
  sessionId: string,
  input: NetopiaStartPaymentInput,
  runtimeOptions: NetopiaRuntimeOptions = {},
  clientOverride?: NetopiaClientApi,
  bindings?: Record<string, unknown>,
): Promise<NetopiaStartPaymentResult> {
  const session = await financeService.getPaymentSessionById(db, sessionId)
  if (!session) {
    throw new Error("Payment session not found")
  }

  if (session.provider && session.provider !== "netopia") {
    throw new Error(
      `Payment session ${sessionId} is already assigned to provider "${session.provider}"`,
    )
  }

  if (["paid", "authorized", "cancelled", "expired"].includes(session.status)) {
    throw new Error(`Payment session ${sessionId} is not startable from status "${session.status}"`)
  }

  const runtime = resolveNetopiaRuntimeOptions(bindings, runtimeOptions)
  const client =
    clientOverride ??
    createNetopiaClient({
      apiUrl: runtime.apiUrl,
      apiKey: runtime.apiKey,
      fetch: runtime.fetch,
      resilience: runtime.resilience,
    })

  const description = input.description ?? session.notes ?? `Payment ${session.id}`
  const orderId = deriveNetopiaOrderId(session)
  const request: NetopiaStartPaymentRequest = {
    config: {
      emailTemplate: input.emailTemplate ?? runtime.emailTemplate,
      notifyUrl: input.notifyUrl ?? runtime.notifyUrl,
      redirectUrl: input.returnUrl ?? runtime.redirectUrl,
      language: input.language ?? runtime.language,
    },
    payment: {
      options: input.options ?? { installments: 1 },
      instrument: input.instrument,
      data: input.browserData,
    },
    order: {
      ntpID: "",
      posSignature: runtime.posSignature,
      dateTime: new Date().toISOString(),
      description,
      orderID: orderId,
      amount: centsToAmount(session.amountCents),
      currency: normalizeCurrency(session.currency),
      billing: input.billing,
      shipping: input.shipping ?? input.billing,
      products:
        input.products && input.products.length > 0
          ? input.products
          : buildDefaultProducts(session, description),
      installments: input.installments ?? { selected: 1, available: [0] },
      data: input.orderData,
    },
  }

  const providerResponse = await client.startCardPayment(request)
  const payment = providerResponse.payment
  if (!payment?.paymentURL) {
    throw new Error("Netopia start payment succeeded without paymentURL")
  }

  const updated = await financeService.markPaymentSessionRequiresRedirect(db, session.id, {
    provider: "netopia",
    providerSessionId: payment.ntpID ?? null,
    providerPaymentId: payment.ntpID ?? null,
    externalReference: orderId,
    redirectUrl: payment.paymentURL,
    returnUrl: input.returnUrl ?? runtime.redirectUrl,
    cancelUrl: input.cancelUrl ?? null,
    callbackUrl: input.callbackUrl ?? input.notifyUrl ?? runtime.notifyUrl,
    providerPayload: mergeRecord(session.providerPayload, {
      netopiaStartRequest: request,
      netopiaStartResponse: providerResponse,
    }),
    metadata: input.metadata ?? undefined,
    notes: input.notes ?? session.notes ?? undefined,
  })

  if (!updated) {
    throw new Error("Payment session disappeared while saving Netopia redirect state")
  }

  return {
    session: updated,
    providerResponse,
    orderId,
  }
}
