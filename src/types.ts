import type { NotificationProvider } from "@voyant-travel/notifications"
import type { CircuitBreaker } from "@voyant-travel/utils/resilience"

export type NetopiaFetch = (
  input: string,
  init: {
    method: string
    headers: Record<string, string>
    body?: string
  },
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}>

export interface NetopiaBillingAddress {
  email: string
  phone: string
  firstName: string
  lastName: string
  city: string
  country: number
  state: string
  postalCode: string
  details: string
}

export interface NetopiaProductLine {
  name?: string
  code?: string
  category?: string
  price?: number
  vat?: number
}

export interface NetopiaInstallments {
  selected: number
  available: number[]
}

export interface NetopiaPaymentOptions {
  installments: number
  bonus?: number
}

export interface NetopiaPaymentInstrument {
  type: string
  account: string
  expMonth: number
  expYear: number
  secretCode: string
  token?: string
}

export interface NetopiaBrowserData {
  [key: string]: string | undefined
}

export interface NetopiaStartPaymentRequest {
  config: {
    emailTemplate: string
    notifyUrl: string
    redirectUrl: string
    language: string
  }
  payment: {
    options: NetopiaPaymentOptions
    instrument?: NetopiaPaymentInstrument
    data?: NetopiaBrowserData
  }
  order: {
    ntpID?: string
    posSignature: string
    dateTime: string
    description: string
    orderID: string
    amount: number
    currency: string
    billing: NetopiaBillingAddress
    shipping: NetopiaBillingAddress
    products: NetopiaProductLine[]
    installments: NetopiaInstallments
    data?: Record<string, string>
  }
}

/**
 * Request body for Netopia v2 `POST /operation/status` — the authoritative,
 * merchant-authenticated payment status lookup. Field names mirror the
 * official SDKs (e.g. github.com/netopiapayments/go-sdk `requests.StatusRequest`).
 */
export interface NetopiaStatusRequest {
  /** The merchant POS signature (same value as the start payload's `posSignature`). */
  posID: string
  /** The Netopia transaction id. */
  ntpID: string
  /** The merchant order id submitted at payment start. */
  orderID: string
}

/**
 * Response of Netopia v2 `POST /operation/status`. `order` echoes the order
 * we submitted at start (amount/currency exactly as we sent them); `payment`
 * carries the processed transaction (which may be RON-converted for non-RON
 * orders).
 */
export interface NetopiaStatusResponse {
  code?: string
  message?: string
  error?: {
    code?: string | number
    message?: string
  }
  order?: {
    ntpID?: string
    orderID?: string
    amount?: number
    currency?: string
    description?: string
    [key: string]: unknown
  }
  payment?: {
    ntpID?: string
    status?: number
    amount?: number
    currency?: string
    rrn?: string
    token?: string
    operationDate?: string
    data?: Record<string, unknown>
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface NetopiaStartPaymentResponse {
  code?: string
  message?: string
  error?: {
    code?: string | number
    message?: string
  }
  payment?: {
    paymentURL?: string
    ntpID?: string
    status?: number
    amount?: number
    currency?: string
  }
}

export interface NetopiaWebhookPayload {
  order: {
    orderID: string
  }
  payment: {
    amount: number
    currency: string
    ntpID: string
    status: number
    code?: string
    message?: string
    data?: {
      AuthCode?: string
      RRN?: string
      [key: string]: unknown
    }
    instrument?: {
      country?: number
      panMasked?: string
      [key: string]: unknown
    }
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface NetopiaStartPaymentInput {
  description?: string
  notifyUrl?: string
  returnUrl?: string
  cancelUrl?: string
  callbackUrl?: string
  emailTemplate?: string
  language?: string
  options?: NetopiaPaymentOptions
  instrument?: NetopiaPaymentInstrument
  browserData?: NetopiaBrowserData
  billing: NetopiaBillingAddress
  shipping?: NetopiaBillingAddress
  products?: NetopiaProductLine[]
  installments?: NetopiaInstallments
  orderData?: Record<string, string>
  metadata?: Record<string, unknown>
  notes?: string | null
}

export type NetopiaMode = "sandbox" | "live"

/**
 * Outbound-HTTP resilience knobs for the Netopia client. Payment initiation
 * is money movement, so it is NEVER auto-retried — these only tune the
 * per-attempt timeout and the circuit breaker that fails fast when Netopia
 * is down instead of burning the request's CPU/subrequest budget.
 */
export interface NetopiaResilienceOptions {
  /**
   * Per-attempt timeout. Defaults to 15s — payment initiation gets a longer
   * ceiling than the 10s used for non-payment upstreams.
   */
  timeoutMs?: number
  /**
   * Override/share the circuit breaker. Defaults to one module-level
   * breaker per Netopia base URL (clients are created per request, so the
   * breaker must outlive them).
   */
  breaker?: CircuitBreaker
}

export interface NetopiaRuntimeOptions {
  /**
   * Selects the Netopia environment. Resolves to a known base URL via
   * `NETOPIA_API_BASES`. Pass `apiUrl` to override (e.g. for tests or a
   * private staging proxy). Defaults to `"sandbox"` when neither `mode`
   * nor `apiUrl` is set, so a misconfigured production deploy fails into
   * the safer mode rather than charging real cards.
   */
  mode?: NetopiaMode
  apiUrl?: string
  apiKey?: string
  posSignature?: string
  notifyUrl?: string
  redirectUrl?: string
  emailTemplate?: string
  language?: string
  successStatuses?: number[]
  processingStatuses?: number[]
  /**
   * PEM of the NETOPIA platform certificate (or its public key) used to
   * verify the `Verification-token` JWT that Netopia v2 attaches to every
   * IPN callback. When set, callbacks with a missing/invalid token are
   * rejected before any verification or state transition. Env:
   * `NETOPIA_IPN_PUBLIC_KEY` (literal `\n` sequences are unescaped).
   */
  ipnPublicKey?: string
  /**
   * DANGEROUS — local sandbox/dev escape hatch only. When `true`, the
   * callback handler trusts the inbound `payment.status` without the
   * server-side `/operation/status` verification. Defaults to `false`.
   * Env: `NETOPIA_TRUST_UNVERIFIED_CALLBACKS=1`.
   */
  trustUnverifiedCallbacks?: boolean
  fetch?: NetopiaFetch
  /** Timeout/circuit-breaker tuning. See {@link NetopiaResilienceOptions}. */
  resilience?: NetopiaResilienceOptions
  resolveNotificationProviders?: (
    bindings: Record<string, unknown>,
  ) => ReadonlyArray<NotificationProvider>
}

export interface ResolvedNetopiaRuntimeOptions {
  apiUrl: string
  apiKey: string
  posSignature: string
  notifyUrl: string
  redirectUrl: string
  emailTemplate: string
  language: string
  successStatuses: number[]
  processingStatuses: number[]
  /** See {@link NetopiaRuntimeOptions.ipnPublicKey}. */
  ipnPublicKey?: string
  /** See {@link NetopiaRuntimeOptions.trustUnverifiedCallbacks}. */
  trustUnverifiedCallbacks: boolean
  fetch?: NetopiaFetch
  /** Timeout/circuit-breaker tuning. See {@link NetopiaResilienceOptions}. */
  resilience?: NetopiaResilienceOptions
}
