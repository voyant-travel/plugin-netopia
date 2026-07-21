import { describe, expect, it } from "vitest"

import app from "./index.js"

const ENV = {
  ORIGIN_TRUST_SECRET: "s3cr3t",
  VOYANT_ENVIRONMENT: "staging" as const,
}

function rpc(body: unknown, trust: string | null = "s3cr3t") {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (trust !== null) headers["x-voyant-origin-trust"] = trust
  return app.request("/rpc", { method: "POST", headers, body: JSON.stringify(body) }, ENV)
}

const validHealth = {
  v: 1,
  op: "health",
  providerId: "netopia",
  mode: "sandbox",
  credentials: {
    merchantId: "M1",
    apiKey: "test-key",
    posSignature: "sig",
    ipnPublicKey: "-----BEGIN PUBLIC KEY-----",
  },
}

describe("netopia worker", () => {
  it("exposes an unauthenticated liveness endpoint", async () => {
    const res = await app.request("/health", {}, ENV)
    expect(res.status).toBe(200)
  })

  it("exposes readiness without returning the trust secret", async () => {
    const res = await app.request("/readyz", {}, ENV)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: "ready",
      checks: { originTrustSecret: true },
      environment: "staging",
    })
  })

  it("rejects a request without the trust secret", async () => {
    const res = await rpc(validHealth, null)
    expect(res.status).toBe(401)
  })

  it("rejects a request with the wrong trust secret", async () => {
    const res = await rpc(validHealth, "wrong")
    expect(res.status).toBe(401)
  })

  it("rejects a malformed request", async () => {
    const res = await rpc({ v: 1, op: "health" })
    expect(res.status).toBe(400)
  })

  it("rejects an oversized request before parsing it", async () => {
    const res = await app.request(
      "/rpc",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(256 * 1024 + 1),
          "x-voyant-origin-trust": "s3cr3t",
        },
        body: "{}",
      },
      ENV,
    )
    expect(res.status).toBe(413)
  })

  it("runs the health op for a well-formed request", async () => {
    const res = await rpc(validHealth)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(typeof body.ok).toBe("boolean")
  })
})
