import { createContainer } from "@voyant-travel/core"
import { financeService } from "@voyant-travel/finance"
import { Hono } from "hono"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createNetopiaFinanceRoutes, createNetopiaFinanceWebhookRoutes } from "../../src/plugin.js"
import { netopiaService } from "../../src/service.js"

const runtimeOptions = {
  apiUrl: "https://secure.mobilpay.ro/pay",
  apiKey: "api-key",
  posSignature: "pos-signature",
  notifyUrl: "https://api.example.com/netopia/callback",
  redirectUrl: "https://app.example.com/checkout/return",
  trustUnverifiedCallbacks: true,
} as const

const baseSession = {
  id: "pmss_123",
  targetType: "booking",
  targetId: "book_123",
  bookingId: "book_123",
  orderId: null,
  invoiceId: null,
  bookingPaymentScheduleId: null,
  bookingGuaranteeId: null,
  paymentInstrumentId: null,
  paymentAuthorizationId: null,
  paymentCaptureId: null,
  paymentId: null,
  status: "pending",
  provider: "netopia",
  providerSessionId: null,
  providerPaymentId: null,
  externalReference: "client_ref_123",
  idempotencyKey: null,
  clientReference: "client_ref_123",
  currency: "RON",
  amountCents: 12500,
  paymentMethod: null,
  payerPersonId: null,
  payerOrganizationId: null,
  payerEmail: "traveler@example.com",
  payerName: "Ana Popescu",
  redirectUrl: null,
  returnUrl: null,
  cancelUrl: null,
  callbackUrl: null,
  expiresAt: null,
  completedAt: null,
  failedAt: null,
  cancelledAt: null,
  expiredAt: null,
  failureCode: null,
  failureMessage: null,
  notes: null,
  providerPayload: null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as const

/**
 * In-memory fake implementing only the drizzle chain surface the
 * `idempotencyKey` middleware touches. Predicates are ignored — each test
 * uses a single (scope, key) pair, so "first stored row" is exactly the
 * row the middleware would have matched.
 */
function createIdempotencyDbFake() {
  // biome-ignore lint/suspicious/noExplicitAny: structural fake of drizzle's chain -- owner: plugins; existing suppression is intentional pending typed cleanup.
  const rows: any[] = []
  return {
    rows,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => rows.slice(0, 1),
        }),
      }),
    }),
    insert: () => ({
      // biome-ignore lint/suspicious/noExplicitAny: structural fake of drizzle's chain -- owner: plugins; existing suppression is intentional pending typed cleanup.
      values: (value: any) => ({
        onConflictDoNothing: async () => {
          rows.push(value)
        },
      }),
    }),
    delete: () => ({
      where: async () => {
        rows.length = 0
      },
    }),
  }
}

function buildApp(options = runtimeOptions) {
  const db = createIdempotencyDbFake()
  const container = createContainer()
  const app = new Hono().use("*", async (c, next) => {
    c.set("db", db as never)
    c.set("container", container as never)
    await next()
  })
  app.route("/", createNetopiaFinanceRoutes(options))
  app.route("/", createNetopiaFinanceWebhookRoutes(options))
  return { app, db }
}

const callbackPayload = {
  order: { orderID: "client_ref_123" },
  payment: {
    amount: 125,
    currency: "RON",
    ntpID: "ntp_123",
    status: 3,
    data: { AuthCode: "AUTH1", RRN: "RRN1" },
  },
}

function postCallback(app: Hono) {
  return app.request("/providers/netopia/callback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(callbackPayload),
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("netopia callback — provider-event dedup", () => {
  it("rejects unsigned callbacks before they can mutate payment sessions", async () => {
    const completeSpy = vi.spyOn(financeService, "completePaymentSession")
    const { app, db } = buildApp({
      ...runtimeOptions,
      trustUnverifiedCallbacks: false,
      ipnPublicKey: "public-key",
    })

    const res = await postCallback(app)

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({
      error: "Netopia callback verification failed",
      code: "missing_verification_token",
    })
    expect(completeSpy).not.toHaveBeenCalled()
    expect(db.rows).toHaveLength(0)
  })

  it("processes a duplicate callback (same ntpID + status) exactly once and replays the stored response", async () => {
    vi.spyOn(financeService, "listPaymentSessions").mockResolvedValue({
      data: [{ ...baseSession }],
      total: 1,
      limit: 1,
      offset: 0,
    })
    const completeSpy = vi.spyOn(financeService, "completePaymentSession").mockResolvedValue({
      ...baseSession,
      status: "paid",
      providerSessionId: "ntp_123",
      providerPaymentId: "ntp_123",
    })

    const { app, db } = buildApp()

    const first = await postCallback(app)
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as { data: { action: string } }
    expect(firstBody.data.action).toBe("completed")
    expect(completeSpy).toHaveBeenCalledTimes(1)

    // The synthetic key derived from the provider event id was stored.
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0]?.key).toBe("netopia:ntp_123:3")

    const second = await postCallback(app)
    expect(second.status).toBe(200)
    expect(second.headers.get("Idempotency-Replayed")).toBe("true")
    const secondBody = (await second.json()) as { data: { action: string } }
    expect(secondBody).toEqual(firstBody)

    // The handler did NOT run again — no second completion.
    expect(completeSpy).toHaveBeenCalledTimes(1)
  })

  it("treats distinct provider events (different status) for the same transaction as distinct keys", async () => {
    vi.spyOn(financeService, "listPaymentSessions").mockResolvedValue({
      data: [{ ...baseSession }],
      total: 1,
      limit: 1,
      offset: 0,
    })
    vi.spyOn(financeService, "updatePaymentSession").mockResolvedValue({
      ...baseSession,
      status: "processing",
    })

    const { app, db } = buildApp()

    // status 15 maps to "processing" by default — a different provider
    // event than the paid callback, so it must be keyed differently.
    const res = await app.request("/providers/netopia/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...callbackPayload,
        payment: { ...callbackPayload.payment, status: 15 },
      }),
    })

    expect(res.status).toBe(200)
    expect(db.rows[0]?.key).toBe("netopia:ntp_123:15")
  })

  it("returns a retryable response for deferred callbacks without storing an idempotency replay", async () => {
    const handleCallbackSpy = vi.spyOn(netopiaService, "handleCallback").mockResolvedValue({
      action: "deferred",
      reason: "status_lookup_failed",
      session: { ...baseSession },
      orderId: "client_ref_123",
      verification: {
        outcome: "unavailable",
        claimedStatus: 3,
        reason: "status_lookup_failed",
      },
    } as never)

    const { app, db } = buildApp()

    const first = await postCallback(app)
    expect(first.status).toBe(503)
    const firstBody = (await first.json()) as { data: { action: string } }
    expect(firstBody.data.action).toBe("deferred")
    expect(db.rows).toHaveLength(0)

    const second = await postCallback(app)
    expect(second.status).toBe(503)
    expect(second.headers.get("Idempotency-Replayed")).not.toBe("true")
    expect(handleCallbackSpy).toHaveBeenCalledTimes(2)
  })

  it("passes unparseable payloads through unkeyed (rejected by validation, nothing stored)", async () => {
    const { app, db } = buildApp()

    const res = await app.request("/providers/netopia/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    })

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(db.rows).toHaveLength(0)
  })
})

describe("netopia collect routes — Idempotency-Key support", () => {
  it("replays a duplicate invoice collect instead of collecting twice", async () => {
    const { netopiaService } = await import("../../src/service.js")
    const collectInvoiceSpy = vi
      .spyOn(netopiaService, "collectInvoice")
      .mockResolvedValue({ ok: true } as never)

    const { app } = buildApp()

    const request = () =>
      app.request("/providers/netopia/invoices/inv_123/collect", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "collect-once",
        },
        body: JSON.stringify({
          netopia: {
            billing: {
              email: "traveler@example.com",
              phone: "0712345678",
              firstName: "Ana",
              lastName: "Popescu",
              city: "Bucharest",
              country: 40,
              state: "B",
              postalCode: "010101",
              details: "Str. Exemplu 1",
            },
          },
        }),
      })

    const first = await request()
    expect(first.status).toBe(201)
    expect(collectInvoiceSpy).toHaveBeenCalledTimes(1)

    const second = await request()
    expect(second.status).toBe(201)
    expect(second.headers.get("Idempotency-Replayed")).toBe("true")
    expect(collectInvoiceSpy).toHaveBeenCalledTimes(1)
  })
})
