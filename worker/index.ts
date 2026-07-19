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
 * or logs credentials. Phase 2A implements `health` (connect-time validation);
 * `initiate`/`verifyCallback`/… are added additively as checkout routing lands.
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

const healthRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("health"),
  providerId: z.literal("netopia"),
  mode: z.enum(["sandbox", "test", "live"]),
  credentials: z.record(z.string(), z.unknown()),
})

const app = new Hono<{ Bindings: Env }>()

app.get("/health", (c) => c.json({ ok: true }))

app.post("/rpc", async (c) => {
  const trust = c.req.header(TRUST_HEADER)
  if (!c.env.ORIGIN_TRUST_SECRET || trust !== c.env.ORIGIN_TRUST_SECRET) {
    return c.json({ ok: false, error: "Unauthorized." }, 401)
  }

  const parsed = healthRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ ok: false, error: "Malformed request." }, 400)
  }

  const { mode, credentials } = parsed.data
  const cred = (key: string): string | undefined => {
    const value = credentials[key]
    return typeof value === "string" ? value : undefined
  }

  // Map operator-supplied credentials onto the adapter's env surface. Notify /
  // redirect URLs are placeholders for the health probe (they matter only when
  // initiating a real payment, brokered per-request in Phase 2B).
  const env: Record<string, unknown> = {
    NETOPIA_MODE: mode === "live" ? "live" : "sandbox",
    NETOPIA_MERCHANT_ID: cred("merchantId"),
    NETOPIA_API_KEY: cred("apiKey"),
    NETOPIA_POS_SIGNATURE: cred("posSignature"),
    NETOPIA_IPN_PUBLIC_KEY: cred("ipnPublicKey"),
    NETOPIA_NOTIFY_URL: "https://payments.invalid/notify",
    NETOPIA_REDIRECT_URL: "https://payments.invalid/return",
  }

  try {
    const adapter = createNetopiaPaymentAdapter()
    const diagnostics = await adapter.health({ env })
    if (diagnostics.status === "ok") {
      return c.json({ ok: true, details: diagnostics.details })
    }
    return c.json({
      ok: false,
      error: diagnostics.message ?? `Netopia health is ${diagnostics.status}.`,
      details: diagnostics.details,
    })
  } catch (error) {
    return c.json({
      ok: false,
      error: error instanceof Error ? error.message : "Netopia health check failed.",
    })
  }
})

export default app
