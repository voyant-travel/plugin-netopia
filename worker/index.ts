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

interface Env {
  /** Shared trust secret; must match the control plane's per-worker secret. */
  ORIGIN_TRUST_SECRET: string
}

/** Header carrying the trust secret (mirrors the dispatcher origin convention). */
const TRUST_HEADER = "x-voyant-origin-trust"

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

const app = new Hono<{ Bindings: Env }>()

app.get("/health", (c) => c.json({ ok: true }))

app.post("/rpc", async (c) => {
  const trust = c.req.header(TRUST_HEADER)
  if (!c.env.ORIGIN_TRUST_SECRET || trust !== c.env.ORIGIN_TRUST_SECRET) {
    return c.json({ ok: false, error: "Unauthorized." }, 401)
  }

  const parsed = rpcRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ ok: false, error: "Malformed request." }, 400)
  }

  const req = parsed.data
  const adapter = createNetopiaPaymentAdapter()

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
    return c.json({
      ok: false,
      error: error instanceof Error ? error.message : "Netopia RPC failed.",
    })
  }
})

export default app
