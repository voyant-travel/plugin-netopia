import type { PaymentCallbackRequest, PaymentInitiationInput } from "@voyant-travel/payments"
import { runPaymentAdapterConformance } from "@voyant-travel/payments/conformance"
import { describe, expect, it, vi } from "vitest"

import { createNetopiaPaymentAdapter } from "../../src/adapter.js"
import type { NetopiaFetch } from "../../src/types.js"

const now = new Date("2026-01-01T12:00:00.000Z")

async function sha512Base64(value: string) {
  const digest = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(value))
  return bytesToBase64(new Uint8Array(digest))
}

async function createJwtSigner() {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )
  const spki = await crypto.subtle.exportKey("spki", keyPair.publicKey)
  const publicKeyPem = wrapPem("PUBLIC KEY", bytesToBase64(new Uint8Array(spki)))

  return {
    publicKeyPem,
    async sign(rawBody: string) {
      const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }))
      const payload = base64UrlEncode(
        JSON.stringify({
          iss: "NETOPIA Payments",
          aud: "merchant-123",
          sub: await sha512Base64(rawBody),
          exp: Math.floor(Date.now() / 1000) + 600,
        }),
      )
      const signature = await crypto.subtle.sign(
        { name: "RSASSA-PKCS1-v1_5" },
        keyPair.privateKey,
        new TextEncoder().encode(`${header}.${payload}`),
      )
      return `${header}.${payload}.${base64UrlEncodeBytes(new Uint8Array(signature))}`
    },
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64UrlEncode(value: string) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value))
}

function base64UrlEncodeBytes(bytes: Uint8Array) {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

function wrapPem(label: string, body: string) {
  return `-----BEGIN ${label}-----\n${body.match(/.{1,64}/g)?.join("\n")}\n-----END ${label}-----`
}

function jsonResponse(status: number, body: unknown) {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
  }
}

function callback(
  rawBody: string,
  token: string | undefined,
  receivedAt = now,
): PaymentCallbackRequest {
  return {
    headers: token ? { "Verification-token": token } : {},
    rawBody,
    parsedBody: JSON.parse(rawBody),
    receivedAt: receivedAt.toISOString(),
  }
}

describe("Netopia canonical payment adapter", () => {
  it("passes the payments conformance kit", async () => {
    const signer = await createJwtSigner()
    const rawBody = JSON.stringify({
      order: { orderID: "pmss_123" },
      payment: {
        amount: 125,
        currency: "RON",
        ntpID: "ntp_123",
        status: 3,
        data: { AuthCode: "AUTH1", RRN: "RRN1" },
      },
    })
    const signedToken = await signer.sign(rawBody)
    const fetchMock = vi.fn<NetopiaFetch>(async (_input, init) => {
      const body = init.body ? (JSON.parse(init.body) as { order?: { orderID?: string } }) : {}
      return jsonResponse(200, {
        payment: {
          paymentURL: `https://secure.example.com/pay/${body.order?.orderID ?? "unknown"}`,
          ntpID: "ntp_123",
          status: 1,
        },
      })
    })
    const adapter = createNetopiaPaymentAdapter({ fetch: fetchMock })
    const initiation: PaymentInitiationInput = {
      paymentSessionId: "pmss_123",
      money: { amountMinor: 12500, currency: "RON" },
      description: "Tour deposit",
      returnUrl: "https://app.example.com/return",
      idempotencyKey: "start-once",
      customer: {
        email: "traveler@example.com",
        phone: "0712345678",
        firstName: "Ana",
        lastName: "Popescu",
      },
    }

    const results = await runPaymentAdapterConformance({
      adapter,
      context: {
        env: {
          NETOPIA_PRIVATE_KEY: "api-key",
          NETOPIA_MERCHANT_ID: "merchant-123",
          NETOPIA_PUBLIC_KEY: signer.publicKeyPem,
          NETOPIA_NOTIFY_URL: "https://api.example.com/netopia/callback",
          NETOPIA_REDIRECT_URL: "https://app.example.com/checkout/return",
          NETOPIA_SANDBOX: "true",
        },
        now: () => now,
      },
      initiation,
      signedCallback: callback(rawBody, signedToken),
      duplicateCallback: callback(rawBody, signedToken),
      replayCallback: callback(rawBody, signedToken, new Date(now.getTime() - 16 * 60 * 1000)),
      unsignedCallback: callback(rawBody, undefined),
    })

    expect(results).toEqual(results.map((result) => ({ ...result, passed: true })))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
