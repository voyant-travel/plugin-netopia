import {
  type CircuitBreaker,
  createCircuitBreaker,
  resilientFetch,
} from "@voyant-travel/utils/resilience"
import { ZodError } from "zod"
import type {
  NetopiaFetch,
  NetopiaMode,
  NetopiaRuntimeOptions,
  NetopiaStartPaymentRequest,
  NetopiaStartPaymentResponse,
  NetopiaStatusRequest,
  NetopiaStatusResponse,
  ResolvedNetopiaRuntimeOptions,
} from "./types.js"
import { resolvedNetopiaRuntimeOptionsSchema } from "./validation.js"

/**
 * Known Netopia API base URLs. The client appends `/payment/card/start`
 * (and any future paths) to whichever value is selected via `mode`. To
 * point at a staging proxy or test mock — or if your tenant is provisioned
 * on a non-default host — set `NETOPIA_URL` (or pass `apiUrl`) to override.
 *
 * The two hosts use *different* path conventions:
 *   - live host has a `/pay` prefix on every endpoint
 *   - sandbox host serves endpoints from the root
 * Sourced from the protravel-v3 reference implementation.
 */
export const NETOPIA_API_BASES: Record<NetopiaMode, string> = {
  live: "https://secure.mobilpay.ro/pay",
  sandbox: "https://secure.sandbox.netopia-payments.com",
}

export interface NetopiaClientApi {
  startCardPayment(request: NetopiaStartPaymentRequest): Promise<NetopiaStartPaymentResponse>
  /**
   * Authoritative payment-status lookup (`POST /operation/status`,
   * merchant-authenticated via the API key). This is the server-to-server
   * source of truth the callback handler verifies inbound IPNs against —
   * the IPN body itself is never trusted for state transitions.
   */
  getPaymentStatus(request: NetopiaStatusRequest): Promise<NetopiaStatusResponse>
}

export interface NetopiaClientOptions
  extends Pick<ResolvedNetopiaRuntimeOptions, "apiUrl" | "apiKey" | "resilience"> {
  fetch?: NetopiaFetch
}

/**
 * One circuit breaker per Netopia base URL, module-level because clients
 * are constructed per payment-start request and the breaker must outlive
 * them to be useful (state is per-isolate, which is the right scope on
 * edge runtimes).
 */
const breakersByBaseUrl = new Map<string, CircuitBreaker>()

function breakerFor(apiUrl: string): CircuitBreaker {
  let breaker = breakersByBaseUrl.get(apiUrl)
  if (!breaker) {
    breaker = createCircuitBreaker()
    breakersByBaseUrl.set(apiUrl, breaker)
  }
  return breaker
}

function createGlobalNetopiaFetch(): NetopiaFetch | undefined {
  if (typeof globalThis.fetch !== "function") return undefined
  return (input, init) => globalThis.fetch(input, init)
}

function headersForPluginFetch(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers || Array.isArray(headers)) {
    return Object.fromEntries(new Headers(headers).entries())
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) out[key] = String(value)
  return out
}

function asResilientFetch(fetchImpl: NetopiaFetch): typeof fetch {
  return async (input, init = {}) => {
    const response = await fetchImpl(input instanceof Request ? input.url : String(input), {
      method: init.method ?? "GET",
      headers: headersForPluginFetch(init.headers),
      ...(typeof init.body === "string" ? { body: init.body } : {}),
    })
    if (response instanceof Response) return response
    return new Response(await response.text(), { status: response.status })
  }
}

export function resolveNetopiaRuntimeOptions(
  bindings: Record<string, unknown> | undefined,
  options: NetopiaRuntimeOptions = {},
): ResolvedNetopiaRuntimeOptions {
  const env = bindings ?? {}
  const apiUrlOverride = options.apiUrl ?? coerceString(env.NETOPIA_URL)
  const mode = resolveMode(options.mode ?? coerceString(env.NETOPIA_MODE))
  const apiUrl = apiUrlOverride ?? NETOPIA_API_BASES[mode]
  const apiKey = options.apiKey ?? coerceString(env.NETOPIA_API_KEY)
  const posSignature = options.posSignature ?? coerceString(env.NETOPIA_POS_SIGNATURE)
  const notifyUrl = options.notifyUrl ?? coerceString(env.NETOPIA_NOTIFY_URL)
  const redirectUrl = options.redirectUrl ?? coerceString(env.NETOPIA_REDIRECT_URL)
  // PEM material is often stored as a single-line env var with literal `\n`
  // escapes — normalize those back into real newlines.
  const ipnPublicKey = (
    options.ipnPublicKey ?? coerceString(env.NETOPIA_IPN_PUBLIC_KEY)
  )?.replaceAll("\\n", "\n")
  const trustUnverifiedCallbacks =
    options.trustUnverifiedCallbacks ?? coerceBoolean(env.NETOPIA_TRUST_UNVERIFIED_CALLBACKS)

  if (!apiKey) throw new Error("Missing Netopia config: NETOPIA_API_KEY")
  if (!posSignature) throw new Error("Missing Netopia config: NETOPIA_POS_SIGNATURE")
  if (!notifyUrl) throw new Error("Missing Netopia config: NETOPIA_NOTIFY_URL")
  if (!redirectUrl) throw new Error("Missing Netopia config: NETOPIA_REDIRECT_URL")

  try {
    return resolvedNetopiaRuntimeOptionsSchema.parse({
      apiUrl,
      apiKey,
      posSignature,
      notifyUrl,
      redirectUrl,
      emailTemplate: options.emailTemplate,
      language: options.language,
      successStatuses: options.successStatuses,
      processingStatuses: options.processingStatuses,
      ipnPublicKey,
      trustUnverifiedCallbacks,
      fetch: options.fetch,
      resilience: options.resilience,
    })
  } catch (error) {
    if (error instanceof ZodError) {
      const detail = error.issues
        .map((issue) => {
          const path = issue.path.join(".") || "runtimeOptions"
          return `${path}: ${issue.message}`
        })
        .join("; ")
      throw new Error(`Invalid Netopia runtime options: ${detail}`)
    }
    throw error
  }
}

function coerceString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (normalized === "1" || normalized === "true") return true
    if (normalized === "0" || normalized === "false" || normalized === "") return false
  }
  return undefined
}

function resolveMode(raw: string | undefined): NetopiaMode {
  if (raw === "live" || raw === "sandbox") return raw
  if (raw !== undefined) {
    throw new Error(`Invalid NETOPIA_MODE: ${raw} (expected "sandbox" or "live")`)
  }
  // Default to sandbox so a half-configured production deploy fails into
  // the safer environment instead of charging real cards.
  return "sandbox"
}

export function createNetopiaClient(options: NetopiaClientOptions): NetopiaClientApi {
  const apiUrl = options.apiUrl.replace(/\/$/, "")
  const fetchImpl = options.fetch ?? createGlobalNetopiaFetch()
  const breaker = options.resilience?.breaker ?? breakerFor(apiUrl)
  // Payments get a longer per-attempt ceiling than the 10s default used for
  // non-payment upstreams; no stricter timeout existed before this.
  const timeoutMs = options.resilience?.timeoutMs ?? 15_000

  async function request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
    if (!fetchImpl) {
      throw new Error("Netopia client requires a fetch implementation")
    }

    const response = await resilientFetch(
      `${apiUrl}${path}`,
      {
        method,
        headers: {
          Authorization: options.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      {
        timeoutMs,
        breaker,
        // NEVER retry: payment initiation moves money and Netopia exposes no
        // idempotency keys — a duplicate charge is worse than a failed
        // checkout the customer can retry. `retryOn: () => false` also
        // surfaces 5xx responses so the rich error mapping below keeps the
        // upstream status + body (the breaker still records the failure).
        retry: { retryOn: () => false },
        fetchImpl: asResilientFetch(fetchImpl),
      },
    )

    let text = ""
    let json: unknown = null
    try {
      text = await response.text()
      json = text ? JSON.parse(text) : null
    } catch {
      // Surface raw text in the thrown error below.
    }

    return { ok: response.ok, status: response.status, json, text }
  }

  return {
    async startCardPayment(requestBody: NetopiaStartPaymentRequest) {
      const res = await request("POST", "/payment/card/start", requestBody)
      const json = (res.json ?? {}) as NetopiaStartPaymentResponse
      // Netopia quirk (per protravel-v3 reference): error code 101 means
      // "redirect customer to payment page" — it's success-with-redirect,
      // not a failure. The API sometimes omits `paymentURL` in this case;
      // upstream callers fall back to other fields on the session.
      if (json.error && String(json.error.code) === "101") {
        return json
      }
      if (!res.ok || json.error) {
        const detail =
          json.error?.message ??
          (res.status === 404
            ? `Endpoint not found at ${apiUrl}/payment/card/start. Verify NETOPIA_MODE/NETOPIA_URL.`
            : stripHtml(res.text).slice(0, 200))
        throw new Error(
          `Netopia start payment failed (${json.error?.code ?? res.status}): ${detail}`,
        )
      }
      return json
    },

    async getPaymentStatus(requestBody: NetopiaStatusRequest) {
      // Read-only verification call. Still a single attempt — the IPN
      // retry loop (we answer the callback with a retryable error when
      // this fails) is the recovery mechanism, not client-side retries.
      const res = await request("POST", "/operation/status", requestBody)
      const json = (res.json ?? {}) as NetopiaStatusResponse
      if (!res.ok || json.error) {
        const detail =
          json.error?.message ??
          (res.status === 404
            ? `Endpoint not found at ${apiUrl}/operation/status. Verify NETOPIA_MODE/NETOPIA_URL.`
            : stripHtml(res.text).slice(0, 200))
        throw new Error(
          `Netopia status lookup failed (${json.error?.code ?? res.status}): ${detail}`,
        )
      }
      return json
    },
  }
}

function stripHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
}
