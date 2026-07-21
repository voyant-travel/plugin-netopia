import {
  PAYMENT_ADAPTER_CONTRACT_VERSION,
  type PaymentAdapter,
  type PaymentAdapterDiagnostics,
  type PaymentAdapterMode,
  type PaymentCallbackRequest,
  type PaymentInitiationInput,
  type PaymentInitiationResult,
  type PaymentMoney,
  type PaymentSessionState,
  type PaymentStatusResult,
} from "@voyant-travel/payments"

import { createNetopiaClient, resolveNetopiaRuntimeOptions } from "./client.js"
import { verifyNetopiaIpnToken } from "./ipn.js"
import {
  amountToCents,
  centsToAmount,
  mapNetopiaPaymentStatus,
  normalizeCurrency,
} from "./service-shared.js"
import type {
  NetopiaBillingAddress,
  NetopiaRuntimeOptions,
  NetopiaStartPaymentRequest,
  NetopiaWebhookPayload,
  ResolvedNetopiaRuntimeOptions,
} from "./types.js"
import { netopiaWebhookPayloadSchema } from "./validation.js"

export const NETOPIA_PAYMENT_ADAPTER_ID = "netopia"

export interface NetopiaPaymentAdapterOptions extends NetopiaRuntimeOptions {
  replayWindowSeconds?: number
  /**
   * Confirm callbacks via NETOPIA's authenticated status API when the IPN JWT
   * signature can't be verified, instead of rejecting. Required where NETOPIA
   * doesn't expose a verification key matching its IPN signing key (its sandbox
   * ships a 1024-bit "Cheie publică" but signs IPNs with a 2048-bit key). When
   * off (default) the adapter is strictly signature-verified.
   */
  confirmViaStatusApi?: boolean
}

type CachedInitiation = {
  result: PaymentInitiationResult
}

export function createNetopiaPaymentAdapter(
  options: NetopiaPaymentAdapterOptions = {},
): PaymentAdapter {
  const initiationsByKey = new Map<string, CachedInitiation>()
  const callbackBodiesByEventId = new Map<string, string>()

  return {
    id: NETOPIA_PAYMENT_ADAPTER_ID,
    label: "Netopia",
    contractVersion: PAYMENT_ADAPTER_CONTRACT_VERSION,
    mode: resolveAdapterMode(options),
    capabilities: {
      hostedCheckout: true,
      redirectCheckout: true,
      authorize: false,
      capture: false,
      void: false,
      refund: false,
      status: true,
      callbackSignatureVerification: true,
      idempotencyKeys: true,
      retrySafeInitiation: true,
    },

    async initiate(context, input) {
      const cached = initiationsByKey.get(input.idempotencyKey)
      if (cached) return cached.result

      assertMoney(input.money)
      const runtime = resolveNetopiaRuntimeOptions(context.env, options)
      const client = createNetopiaClient(runtime)
      const request = buildStartPaymentRequest(runtime, input, context.now?.() ?? new Date())
      const providerResponse = await client.startCardPayment(request)
      const payment = providerResponse.payment

      const result: PaymentInitiationResult = {
        processorSessionId: payment?.ntpID ?? null,
        processorPaymentId: payment?.ntpID ?? null,
        checkout: payment?.paymentURL
          ? {
              kind: "redirect",
              url: payment.paymentURL,
              expiresAt: null,
            }
          : null,
        nextState: payment?.paymentURL ? "requires_redirect" : "processing",
        idempotencyKey: input.idempotencyKey,
        raw: {
          request,
          response: providerResponse,
        },
      }
      initiationsByKey.set(input.idempotencyKey, { result })
      return result
    },

    async verifyCallback(context, request) {
      const parsed = parseCallbackBody(request)
      if (!parsed.ok) return { verified: false, reason: "malformed" }

      const runtime = resolveNetopiaRuntimeOptions(context.env, options)

      if (isStaleCallback(request.receivedAt, context.now?.() ?? new Date(), options)) {
        return { verified: false, reason: "replay" }
      }

      const eventId = canonicalCallbackEventId(parsed.payload)
      const previousBody = callbackBodiesByEventId.get(eventId)
      if (previousBody !== undefined && previousBody !== parsed.rawBody) {
        return { verified: false, reason: "replay" }
      }

      // Fast path: if the IPN JWT signature verifies against the configured
      // NETOPIA public key, the callback body can be trusted directly.
      const token = callbackHeader(request.headers, "verification-token")
      const signatureVerified =
        runtime.ipnPublicKey && token
          ? (
              await verifyNetopiaIpnToken({
                token,
                rawBody: parsed.rawBody,
                posSignature: runtime.posSignature,
                publicKeyPem: runtime.ipnPublicKey,
              })
            ).ok
          : false

      if (signatureVerified) {
        callbackBodiesByEventId.set(eventId, parsed.rawBody)
        return {
          verified: true,
          event: {
            eventId,
            paymentSessionId: parsed.payload.order.orderID,
            nextState: mapCanonicalState(parsed.payload.payment.status, runtime),
            occurredAt: request.receivedAt,
            processorSessionId: parsed.payload.payment.ntpID,
            processorPaymentId: parsed.payload.payment.ntpID,
            money: netopiaPaymentMoney(parsed.payload),
            idempotencyKey: eventId,
            raw: parsed.payload,
          },
        }
      }

      // Without a verified signature, reject unless this adapter is explicitly
      // configured to confirm out-of-band via the status API — the payments
      // contract requires signature-verified callbacks by default.
      if (!options.confirmViaStatusApi) {
        return {
          verified: false,
          reason: runtime.ipnPublicKey && token ? "invalid_signature" : "missing_signature",
        }
      }

      // Authenticated fallback (and current sandbox reality): NETOPIA signs the
      // IPN JWT with a 2048-bit key but only exposes a 1024-bit "Cheie publică",
      // so the signature can't be verified. Treat the callback purely as a
      // trigger and confirm the outcome against NETOPIA's authenticated status
      // API (`/operation/status`, authorized by the API key) — the source of
      // truth — never trusting the unsigned body's status.
      const orderID = parsed.payload.order?.orderID
      if (!orderID) return { verified: false, reason: "malformed" }

      const statusResponse = await createNetopiaClient(runtime).getPaymentStatus({
        posID: runtime.posSignature,
        ntpID: parsed.payload.payment?.ntpID,
        orderID,
      })
      const status = statusResponse.payment?.status
      if (typeof status !== "number") {
        return { verified: false, reason: "invalid_signature" }
      }

      callbackBodiesByEventId.set(eventId, parsed.rawBody)
      const ntpID = statusResponse.payment?.ntpID ?? parsed.payload.payment?.ntpID
      return {
        verified: true,
        event: {
          eventId,
          paymentSessionId: orderID,
          nextState: mapCanonicalState(status, runtime),
          occurredAt: request.receivedAt,
          processorSessionId: ntpID,
          processorPaymentId: ntpID,
          money:
            typeof statusResponse.payment?.amount === "number" &&
            typeof statusResponse.payment.currency === "string"
              ? {
                  amountMinor: amountToCents(statusResponse.payment.amount),
                  currency: normalizeCurrency(statusResponse.payment.currency),
                }
              : netopiaPaymentMoney(parsed.payload),
          idempotencyKey: eventId,
          raw: statusResponse,
        },
      }
    },

    async health(context) {
      const checkedAt = (context.now?.() ?? new Date()).toISOString()
      try {
        const runtime = resolveNetopiaRuntimeOptions(context.env, options)
        const missing = [
          !runtime.posSignature ? "NETOPIA_MERCHANT_ID" : null,
          !runtime.apiKey ? "NETOPIA_PRIVATE_KEY" : null,
          !runtime.ipnPublicKey ? "NETOPIA_PUBLIC_KEY" : null,
        ].filter((value): value is string => value !== null)

        if (missing.length > 0) {
          return {
            status: "degraded",
            checkedAt,
            message: "Netopia callback verification is not fully configured.",
            details: { missing },
          } satisfies PaymentAdapterDiagnostics
        }

        return {
          status: "ok",
          checkedAt,
          details: {
            provider: NETOPIA_PAYMENT_ADAPTER_ID,
            mode: runtime.apiUrl.includes("sandbox") ? "sandbox" : "live",
            callbackSignatureVerification: true,
          },
        }
      } catch (error) {
        return {
          status: "down",
          checkedAt,
          message: error instanceof Error ? error.message : "Invalid Netopia configuration.",
        }
      }
    },

    async status(context, input) {
      const runtime = resolveNetopiaRuntimeOptions(context.env, options)
      const ntpID = input.processorPaymentId ?? input.processorSessionId
      if (!ntpID) {
        return {
          nextState: "pending",
          processorSessionId: null,
          processorPaymentId: null,
        }
      }

      const statusResponse = await createNetopiaClient(runtime).getPaymentStatus({
        posID: runtime.posSignature,
        ntpID,
        orderID: input.paymentSessionId,
      })
      const status = statusResponse.payment?.status
      return {
        nextState: typeof status === "number" ? mapCanonicalState(status, runtime) : "processing",
        processorSessionId: statusResponse.payment?.ntpID ?? ntpID,
        processorPaymentId: statusResponse.payment?.ntpID ?? ntpID,
        money:
          typeof statusResponse.payment?.amount === "number" &&
          typeof statusResponse.payment.currency === "string"
            ? {
                amountMinor: amountToCents(statusResponse.payment.amount),
                currency: normalizeCurrency(statusResponse.payment.currency),
              }
            : undefined,
        raw: statusResponse,
      } satisfies PaymentStatusResult
    },
  }
}

export const netopiaPaymentAdapter = createNetopiaPaymentAdapter()

function resolveAdapterMode(options: NetopiaPaymentAdapterOptions): PaymentAdapterMode {
  if (options.mode === "live") return "live"
  return "sandbox"
}

function buildStartPaymentRequest(
  runtime: ResolvedNetopiaRuntimeOptions,
  input: PaymentInitiationInput,
  date: Date,
): NetopiaStartPaymentRequest {
  const billing = resolveBillingAddress(input)
  const description = input.description ?? `Payment ${input.paymentSessionId}`
  return {
    config: {
      emailTemplate: runtime.emailTemplate,
      notifyUrl: runtime.notifyUrl,
      redirectUrl: input.returnUrl ?? runtime.redirectUrl,
      language: runtime.language,
    },
    payment: {
      options: { installments: 1 },
    },
    order: {
      ntpID: "",
      posSignature: runtime.posSignature,
      dateTime: date.toISOString(),
      description,
      orderID: input.paymentSessionId,
      amount: centsToAmount(input.money.amountMinor),
      currency: normalizeCurrency(input.money.currency),
      billing,
      shipping: billing,
      products: [
        {
          name: description,
          price: centsToAmount(input.money.amountMinor),
          vat: 0,
        },
      ],
      installments: { selected: 1, available: [0] },
      data: stringifyMetadata(input.metadata),
    },
  }
}

function resolveBillingAddress(input: PaymentInitiationInput): NetopiaBillingAddress {
  const metadataBilling = readBillingFromMetadata(input.metadata)
  return {
    email: metadataBilling.email ?? input.customer?.email ?? "billing@example.invalid",
    phone: metadataBilling.phone ?? input.customer?.phone ?? "0000000000",
    firstName: metadataBilling.firstName ?? input.customer?.firstName ?? "Voyant",
    lastName: metadataBilling.lastName ?? input.customer?.lastName ?? "Traveler",
    city: metadataBilling.city ?? "Bucharest",
    country: metadataBilling.country ?? 40,
    state: metadataBilling.state ?? "B",
    postalCode: metadataBilling.postalCode ?? "000000",
    details: metadataBilling.details ?? "Netopia hosted checkout",
  }
}

function readBillingFromMetadata(
  metadata: Record<string, unknown> | undefined,
): Partial<NetopiaBillingAddress> {
  const candidate = metadata?.netopiaBilling ?? metadata?.billing
  if (!candidate || typeof candidate !== "object") return {}
  const record = candidate as Record<string, unknown>
  return {
    email: readString(record.email),
    phone: readString(record.phone),
    firstName: readString(record.firstName),
    lastName: readString(record.lastName),
    city: readString(record.city),
    country: typeof record.country === "number" ? record.country : undefined,
    state: readString(record.state),
    postalCode: readString(record.postalCode),
    details: readString(record.details),
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function stringifyMetadata(metadata: Record<string, unknown> | undefined): Record<string, string> {
  const data: Record<string, string> = {}
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (typeof value === "string") data[key] = value
  }
  return data
}

function parseCallbackBody(
  request: PaymentCallbackRequest,
): { ok: true; rawBody: string; payload: NetopiaWebhookPayload } | { ok: false } {
  const rawBody =
    typeof request.rawBody === "string"
      ? request.rawBody
      : new TextDecoder().decode(request.rawBody)
  const parsed = request.parsedBody ?? parseJson(rawBody)
  if (!parsed) return { ok: false }
  const result = netopiaWebhookPayloadSchema.safeParse(parsed)
  if (!result.success) return { ok: false }
  return { ok: true, rawBody, payload: result.data }
}

function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody)
  } catch {
    return undefined
  }
}

function callbackHeader(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue
    return Array.isArray(value) ? value[0] : value
  }
  return undefined
}

function isStaleCallback(
  receivedAt: string,
  now: Date,
  options: NetopiaPaymentAdapterOptions,
): boolean {
  const replayWindowSeconds = options.replayWindowSeconds ?? 15 * 60
  const received = Date.parse(receivedAt)
  if (Number.isNaN(received)) return true
  return now.getTime() - received > replayWindowSeconds * 1000
}

function canonicalCallbackEventId(payload: NetopiaWebhookPayload) {
  return `netopia:${payload.payment.ntpID}:${payload.payment.status}`
}

function mapCanonicalState(
  status: number,
  runtime: Pick<ResolvedNetopiaRuntimeOptions, "successStatuses" | "processingStatuses">,
): PaymentSessionState {
  const mapped = mapNetopiaPaymentStatus(status, runtime)
  if (mapped === "completed") return "paid"
  if (mapped === "processing") return "processing"
  return "failed"
}

function netopiaPaymentMoney(payload: NetopiaWebhookPayload): PaymentMoney {
  return {
    amountMinor: amountToCents(payload.payment.amount),
    currency: normalizeCurrency(payload.payment.currency),
  }
}

function assertMoney(money: PaymentMoney) {
  if (!Number.isInteger(money.amountMinor) || money.amountMinor <= 0) {
    throw new Error("Money amount must be a positive integer minor-unit value.")
  }
  if (!/^[A-Z]{3}$/.test(money.currency)) {
    throw new Error("Money currency must be an ISO 4217 uppercase code.")
  }
}
