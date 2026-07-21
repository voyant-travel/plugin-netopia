/**
 * Netopia processor worker (Cloudflare Worker).
 *
 * The deployable form of this adapter: a first-party worker that implements the
 * Voyant payments processor-worker RPC protocol for Netopia. It ships in this
 * repo (next to the adapter it wraps) rather than in voyant-cloud, so the
 * managed control plane carries none of Netopia's SDK — it only calls this
 * worker's URL over a trust-signed RPC. This is the per-processor isolation of
 * ADR 0015 taken to the repo/deploy level.
 *
 * The worker is stateless: it receives decrypted credentials from the control
 * plane per request, runs the operation, and returns a verdict. It never stores
 * or logs credentials. It implements `health` (connect-time validation) plus
 * the checkout ops `initiate` / `status` / `verifyCallback` (Phase 2B).
 */

import { Hono } from "hono"
import { z } from "zod"

import { createNetopiaPaymentAdapter } from "../src/adapter.js"

type RuntimeEnv = Cloudflare.StagingEnv | Cloudflare.ProductionEnv

/** Header carrying the trust secret (mirrors the dispatcher origin convention). */
const TRUST_HEADER = "x-voyant-origin-trust"
const MAX_RPC_BODY_BYTES = 256 * 1024

const modeSchema = z.enum(["sandbox", "test", "live"])
const credentialsSchema = z.record(z.string(), z.unknown())

const moneySchema = z.object({
  amountMinor: z.number(),
  currency: z.string().min(1),
})

const healthRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("health"),
  providerId: z.literal("netopia"),
  mode: modeSchema,
  credentials: credentialsSchema,
})

const initiateRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("initiate"),
  providerId: z.literal("netopia"),
  mode: modeSchema,
  credentials: credentialsSchema,
  input: z.object({
    paymentSessionId: z.string().min(1),
    money: moneySchema,
    description: z.string().optional(),
    returnUrl: z.string().optional(),
    captureMode: z.enum(["automatic", "manual"]).optional(),
    idempotencyKey: z.string().min(1),
    customer: z
      .object({
        email: z.string().nullish(),
        phone: z.string().nullish(),
        firstName: z.string().nullish(),
        lastName: z.string().nullish(),
      })
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
})

const statusRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("status"),
  providerId: z.literal("netopia"),
  mode: modeSchema,
  credentials: credentialsSchema,
  input: z.object({
    paymentSessionId: z.string().min(1),
    processorSessionId: z.string().nullish(),
    processorPaymentId: z.string().nullish(),
  }),
})

const verifyCallbackRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("verifyCallback"),
  providerId: z.literal("netopia"),
  mode: modeSchema,
  credentials: credentialsSchema,
  callback: z.object({
    headers: z.record(z.string(), z.string()),
    rawBody: z.string(),
    receivedAt: z.string(),
  }),
})

const rpcRequestSchema = z.discriminatedUnion("op", [
  healthRequestSchema,
  initiateRequestSchema,
  statusRequestSchema,
  verifyCallbackRequestSchema,
])

/**
 * Map the operator-supplied credentials onto the adapter's env surface. Notify
 * / redirect URLs are injected per operation (real ones for `initiate`,
 * placeholders where they don't matter).
 */
function credentialsToEnv(
  mode: z.infer<typeof modeSchema>,
  credentials: Record<string, unknown>,
  urls: { notifyUrl?: string; redirectUrl?: string },
): Record<string, unknown> {
  const cred = (key: string): string | undefined => {
    const value = credentials[key]
    return typeof value === "string" ? value : undefined
  }
  return {
    NETOPIA_MODE: mode === "live" ? "live" : "sandbox",
    NETOPIA_MERCHANT_ID: cred("merchantId"),
    NETOPIA_API_KEY: cred("apiKey"),
    NETOPIA_POS_SIGNATURE: cred("posSignature"),
    NETOPIA_IPN_PUBLIC_KEY: cred("ipnPublicKey"),
    NETOPIA_NOTIFY_URL: urls.notifyUrl ?? "https://payments.invalid/notify",
    NETOPIA_REDIRECT_URL: urls.redirectUrl ?? "https://payments.invalid/return",
  }
}

const app = new Hono<{ Bindings: RuntimeEnv; Variables: { requestId: string } }>()

app.use("*", async (c, next) => {
  const requestId = c.req.header("x-request-id")?.trim() || crypto.randomUUID()
  c.set("requestId", requestId)
  c.header("x-request-id", requestId)
  await next()
})

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "voyant-netopia-worker",
    environment: c.env.VOYANT_ENVIRONMENT,
  }),
)

app.get("/readyz", (c) => {
  const ready = Boolean(c.env.ORIGIN_TRUST_SECRET?.trim())
  return c.json(
    {
      status: ready ? "ready" : "not_ready",
      checks: { originTrustSecret: ready },
      environment: c.env.VOYANT_ENVIRONMENT,
    },
    ready ? 200 : 503,
  )
})

app.post("/rpc", async (c) => {
  const trust = c.req.header(TRUST_HEADER)
  if (!trust || !(await secretsMatch(trust, c.env.ORIGIN_TRUST_SECRET))) {
    logError(c, "netopia_rpc.unauthorized")
    return c.json({ ok: false, error: "Unauthorized." }, 401)
  }

  const body = await readBoundedJson(c.req.raw, MAX_RPC_BODY_BYTES)
  if (!body.ok) {
    logError(c, "netopia_rpc.invalid_body", { reason: body.reason })
    return c.json(
      {
        ok: false,
        error: body.reason === "too_large" ? "Request too large." : "Malformed request.",
      },
      body.reason === "too_large" ? 413 : 400,
    )
  }
  const parsed = rpcRequestSchema.safeParse(body.value)
  if (!parsed.success) {
    logError(c, "netopia_rpc.invalid_envelope")
    return c.json({ ok: false, error: "Malformed request." }, 400)
  }

  const req = parsed.data
  // NETOPIA's sandbox signs IPNs with a 2048-bit key but only publishes a
  // 1024-bit "Cheie publică", so the JWT signature can't be verified. Confirm
  // callbacks against NETOPIA's authenticated status API instead.
  const adapter = createNetopiaPaymentAdapter({ confirmViaStatusApi: true })

  try {
    switch (req.op) {
      case "health": {
        const env = credentialsToEnv(req.mode, req.credentials, {})
        const diagnostics = await adapter.health({ env })
        if (diagnostics.status === "ok") {
          return c.json({ ok: true, details: diagnostics.details })
        }
        return c.json({
          ok: false,
          error: diagnostics.message ?? `Netopia health is ${diagnostics.status}.`,
          details: diagnostics.details,
        })
      }

      case "initiate": {
        const notifyUrl =
          typeof req.input.metadata?.notifyUrl === "string"
            ? req.input.metadata.notifyUrl
            : undefined
        const env = credentialsToEnv(req.mode, req.credentials, {
          notifyUrl,
          redirectUrl: req.input.returnUrl,
        })
        const result = await adapter.initiate({ env }, req.input)
        return c.json({
          processorSessionId: result.processorSessionId ?? null,
          processorPaymentId: result.processorPaymentId ?? null,
          checkout: result.checkout
            ? {
                kind: result.checkout.kind,
                url: result.checkout.url,
                expiresAt: result.checkout.expiresAt ?? null,
              }
            : null,
          nextState: result.nextState,
          idempotencyKey: result.idempotencyKey,
        })
      }

      case "status": {
        if (!adapter.status) {
          return c.json({ ok: false, error: "status unsupported." }, 400)
        }
        const env = credentialsToEnv(req.mode, req.credentials, {})
        const result = await adapter.status({ env }, req.input)
        return c.json({
          nextState: result.nextState,
          processorSessionId: result.processorSessionId ?? null,
          processorPaymentId: result.processorPaymentId ?? null,
          money: result.money,
        })
      }

      case "verifyCallback": {
        const env = credentialsToEnv(req.mode, req.credentials, {})
        const verification = await adapter.verifyCallback(
          { env },
          {
            headers: req.callback.headers,
            rawBody: req.callback.rawBody,
            receivedAt: req.callback.receivedAt,
          },
        )
        if (!verification.verified) {
          return c.json({ verified: false, reason: verification.reason })
        }
        const e = verification.event
        return c.json({
          verified: true,
          event: {
            eventId: e.eventId,
            paymentSessionId: e.paymentSessionId,
            nextState: e.nextState,
            occurredAt: e.occurredAt,
            processorSessionId: e.processorSessionId ?? null,
            processorPaymentId: e.processorPaymentId ?? null,
            money: e.money,
            idempotencyKey: e.idempotencyKey,
          },
        })
      }
    }
  } catch (error) {
    logError(c, "netopia_rpc.failed", {
      operation: req.op,
      errorType: error instanceof Error ? error.name : "UnknownError",
    })
    return c.json({
      ok: false,
      error: "Netopia RPC failed.",
    })
  }
})

export default app

async function secretsMatch(provided: string, expected: string | undefined): Promise<boolean> {
  if (!expected) return false
  const encoder = new TextEncoder()
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ])
  return fixedTimeEqual(providedHash, expectedHash)
}

function fixedTimeEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  const leftBytes = new Uint8Array(left)
  const rightBytes = new Uint8Array(right)
  let mismatch = leftBytes.byteLength ^ rightBytes.byteLength
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength)
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0)
  }
  return mismatch === 0
}

async function readBoundedJson(
  request: Request,
  limit: number,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: "too_large" | "invalid_body" }> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return { ok: false, reason: "invalid_body" }
  }
  const declared = request.headers.get("content-length")
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    return { ok: false, reason: "too_large" }
  }
  if (!request.body) return { ok: false, reason: "invalid_body" }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > limit) {
        await reader.cancel()
        return { ok: false, reason: "too_large" }
      }
      chunks.push(next.value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }
  } catch {
    return { ok: false, reason: "invalid_body" }
  }
}

function logError(
  c: { get(key: "requestId"): string },
  event: string,
  details: Record<string, string> = {},
) {
  console.error(
    JSON.stringify({ level: "error", event, requestId: c.get("requestId"), ...details }),
  )
}
