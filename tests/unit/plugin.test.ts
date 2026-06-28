// agent-quality: file-size exception -- owner: plugins; existing coverage file stays co-located until a dedicated split preserves behavior and tests.
import { createContainer, createEventBus } from "@voyant-travel/core"
import { financeService, type PaymentSession } from "@voyant-travel/finance"
import { notificationsService } from "@voyant-travel/notifications"
import { Hono } from "hono"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { NetopiaClientApi } from "../../src/client.js"
import {
  NETOPIA_RUNTIME_CONTAINER_KEY,
  netopiaHonoBundle,
  netopiaHonoPlugin,
} from "../../src/plugin.js"
import { deriveNetopiaOrderId, mapNetopiaPaymentStatus, netopiaService } from "../../src/service.js"
import * as startService from "../../src/service-start.js"

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
  provider: null,
  providerSessionId: null,
  providerPaymentId: null,
  externalReference: null,
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
  notes: "Tour deposit",
  providerPayload: null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as const

const runtimeOptions = {
  apiUrl: "https://secure.mobilpay.ro/pay",
  apiKey: "api-key",
  posSignature: "pos-signature",
  notifyUrl: "https://api.example.com/netopia/callback",
  redirectUrl: "https://app.example.com/checkout/return",
  trustUnverifiedCallbacks: true,
} as const

const billingInput = {
  email: "traveler@example.com",
  phone: "0712345678",
  firstName: "Ana",
  lastName: "Popescu",
  city: "Bucharest",
  country: 40,
  state: "B",
  postalCode: "010101",
  details: "Str. Exemplu 1",
} as const

afterEach(() => {
  vi.restoreAllMocks()
})

describe("netopiaHonoPlugin.bootstrap", () => {
  it("exposes the bundle alias", () => {
    const bundle = netopiaHonoBundle()
    expect(bundle.name).toBe("netopia")
  })

  it("validates and registers the resolved runtime once", async () => {
    const plugin = netopiaHonoPlugin({
      apiUrl: "https://secure.mobilpay.ro/pay",
      apiKey: "api-key",
      posSignature: "pos-signature",
      notifyUrl: "https://api.example.com/netopia/callback",
      redirectUrl: "https://app.example.com/checkout/return",
    })
    const container = createContainer()

    await plugin.bootstrap?.({
      bindings: {},
      container,
      eventBus: createEventBus(),
    })

    expect(container.resolve(NETOPIA_RUNTIME_CONTAINER_KEY)).toMatchObject({
      apiUrl: "https://secure.mobilpay.ro/pay",
      apiKey: "api-key",
      posSignature: "pos-signature",
      notifyUrl: "https://api.example.com/netopia/callback",
      redirectUrl: "https://app.example.com/checkout/return",
      emailTemplate: "confirm",
      language: "ro",
      successStatuses: [3, 5],
      processingStatuses: [1, 15],
    })
  })

  it("defers resolution and logs a warning when runtime config is missing", async () => {
    const plugin = netopiaHonoPlugin()
    const container = createContainer()
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    await plugin.bootstrap?.({
      bindings: {},
      container,
      eventBus: createEventBus(),
    })

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/NETOPIA_API_KEY/))
    expect(() => container.resolve(NETOPIA_RUNTIME_CONTAINER_KEY)).toThrow()
  })

  it("still fails Netopia-owned routes when runtime config is missing", async () => {
    const bundle = netopiaHonoPlugin()
    const container = createContainer()
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await bundle.bootstrap?.({
      bindings: {},
      container,
      eventBus: createEventBus(),
    })

    const [extension] = bundle.extensions ?? []
    expect(extension).toBeDefined()

    // The config route resolves runtime per-request; without config, it returns 500.
    const app = new Hono().use("*", async (c, next) => {
      c.set("container", container)
      await next()
    })
    app.route("/", extension!.adminRoutes)

    const res = await app.request("/providers/netopia/config", { method: "GET" })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/NETOPIA_API_KEY/)
  })
})

describe("deriveNetopiaOrderId", () => {
  it("prefers externalReference, then clientReference, then session id", () => {
    expect(deriveNetopiaOrderId({ ...baseSession, externalReference: "external_1" })).toBe(
      "external_1",
    )
    expect(deriveNetopiaOrderId(baseSession)).toBe("client_ref_123")
    expect(deriveNetopiaOrderId({ ...baseSession, clientReference: null })).toBe("pmss_123")
  })
})

describe("mapNetopiaPaymentStatus", () => {
  const config = { successStatuses: [3, 5], processingStatuses: [1, 15] }

  it("maps success statuses", () => {
    expect(mapNetopiaPaymentStatus(3, config)).toBe("completed")
    expect(mapNetopiaPaymentStatus(5, config)).toBe("completed")
  })

  it("maps in-flight statuses", () => {
    expect(mapNetopiaPaymentStatus(1, config)).toBe("processing")
    expect(mapNetopiaPaymentStatus(15, config)).toBe("processing")
  })

  it("treats everything else as failed", () => {
    expect(mapNetopiaPaymentStatus(12, config)).toBe("failed")
  })
})

describe("netopiaService.startPaymentSession", () => {
  it("starts a hosted payment and persists redirect state", async () => {
    vi.spyOn(financeService, "getPaymentSessionById").mockResolvedValue(baseSession)
    const updated: PaymentSession = {
      ...baseSession,
      provider: "netopia",
      status: "requires_redirect",
      externalReference: "client_ref_123",
      providerSessionId: "ntp_123",
      redirectUrl: "https://secure.example.com/pay",
    }
    const markSpy = vi
      .spyOn(financeService, "markPaymentSessionRequiresRedirect")
      .mockResolvedValue(updated)
    const client: NetopiaClientApi = {
      startCardPayment: vi.fn(async () => ({
        payment: {
          paymentURL: "https://secure.example.com/pay",
          ntpID: "ntp_123",
          status: 1,
          amount: 125,
          currency: "RON",
        },
      })),
    }

    const result = await netopiaService.startPaymentSession(
      {} as never,
      baseSession.id,
      {
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
      {
        ...runtimeOptions,
      },
      client,
    )

    expect(result.orderId).toBe("client_ref_123")
    expect(markSpy).toHaveBeenCalledWith(
      {} as never,
      baseSession.id,
      expect.objectContaining({
        provider: "netopia",
        providerSessionId: "ntp_123",
        redirectUrl: "https://secure.example.com/pay",
      }),
    )
  })
})

describe("netopiaService.collect flows", () => {
  it("creates, starts, and notifies for a booking schedule collection", async () => {
    const createdSession: PaymentSession = {
      ...baseSession,
      targetType: "booking_payment_schedule",
      targetId: "bpms_123",
      bookingPaymentScheduleId: "bpms_123",
      provider: "netopia",
    }
    vi.spyOn(financeService, "createPaymentSessionFromBookingSchedule").mockResolvedValue(
      createdSession,
    )
    const started = {
      session: {
        ...createdSession,
        status: "requires_redirect" as const,
        redirectUrl: "https://pay.example",
      },
      providerResponse: { payment: { paymentURL: "https://pay.example", ntpID: "ntp_123" } },
      orderId: "order_123",
    }
    vi.spyOn(startService, "startPaymentSession").mockResolvedValue(started)
    const notifySpy = vi
      .spyOn(notificationsService, "sendPaymentSessionNotification")
      .mockResolvedValue({ id: "ntdl_123" } as never)

    const result = await netopiaService.collectBookingSchedule(
      {} as never,
      "bpms_123",
      {
        paymentSession: { payerEmail: "traveler@example.com" },
        netopia: { billing: billingInput },
        notification: {
          channel: "email",
          templateSlug: "payment-link",
          subject: "Pay now",
        },
      },
      runtimeOptions,
      undefined,
      {} as never,
    )

    expect(financeService.createPaymentSessionFromBookingSchedule).toHaveBeenCalledWith(
      {} as never,
      "bpms_123",
      expect.objectContaining({
        provider: "netopia",
        payerEmail: "traveler@example.com",
      }),
    )
    expect(notifySpy).toHaveBeenCalledWith(
      {} as never,
      {} as never,
      started.session.id,
      expect.objectContaining({
        templateSlug: "payment-link",
      }),
    )
    expect(result.paymentSessionNotification?.id).toBe("ntdl_123")
  })

  it("creates, starts, and can send both invoice and payment-session notifications", async () => {
    const createdSession: PaymentSession = {
      ...baseSession,
      targetType: "invoice",
      targetId: "inv_123",
      invoiceId: "inv_123",
      provider: "netopia",
    }
    vi.spyOn(financeService, "createPaymentSessionFromInvoice").mockResolvedValue(createdSession)
    const started = {
      session: {
        ...createdSession,
        status: "requires_redirect" as const,
        redirectUrl: "https://pay.example",
        externalReference: "INV-123",
        providerSessionId: "ntp_123",
        providerPaymentId: "ntp_123",
      },
      providerResponse: { payment: { paymentURL: "https://pay.example", ntpID: "ntp_123" } },
      orderId: "INV-123",
    }
    vi.spyOn(financeService, "getPaymentSessionById").mockResolvedValue(createdSession)
    vi.spyOn(financeService, "markPaymentSessionRequiresRedirect").mockResolvedValue(
      started.session,
    )
    const paymentNotifySpy = vi
      .spyOn(notificationsService, "sendPaymentSessionNotification")
      .mockResolvedValue({ id: "ntdl_pay_123" } as never)
    const invoiceNotifySpy = vi
      .spyOn(notificationsService, "sendInvoiceNotification")
      .mockResolvedValue({ id: "ntdl_inv_123" } as never)
    const client: NetopiaClientApi = {
      startCardPayment: vi.fn(async () => ({
        payment: {
          paymentURL: "https://pay.example",
          ntpID: "ntp_123",
          status: 1,
          amount: 125,
          currency: "RON",
        },
      })),
    }

    const result = await netopiaService.collectInvoice(
      {} as never,
      "inv_123",
      {
        paymentSession: { payerEmail: "traveler@example.com" },
        netopia: { billing: billingInput },
        paymentSessionNotification: {
          channel: "email",
          templateSlug: "payment-link",
          subject: "Complete payment",
        },
        invoiceNotification: {
          channel: "email",
          templateSlug: "invoice-issued",
          subject: "Invoice ready",
        },
      },
      runtimeOptions,
      client,
      {} as never,
    )

    expect(financeService.createPaymentSessionFromInvoice).toHaveBeenCalledWith(
      {} as never,
      "inv_123",
      expect.objectContaining({
        provider: "netopia",
      }),
    )
    expect(paymentNotifySpy).toHaveBeenCalledTimes(1)
    expect(invoiceNotifySpy).toHaveBeenCalledWith(
      {} as never,
      {} as never,
      "inv_123",
      expect.objectContaining({
        templateSlug: "invoice-issued",
      }),
    )
    expect(result.paymentSessionNotification?.id).toBe("ntdl_pay_123")
    expect(result.invoiceNotification?.id).toBe("ntdl_inv_123")
  })
})

describe("netopiaService.handleCallback", () => {
  it("defers callbacks when server-side status verification is unavailable", async () => {
    vi.spyOn(financeService, "listPaymentSessions").mockResolvedValue({
      data: [{ ...baseSession, provider: "netopia", externalReference: "client_ref_123" }],
      total: 1,
      limit: 1,
      offset: 0,
    })
    const completeSpy = vi.spyOn(financeService, "completePaymentSession")

    const result = await netopiaService.handleCallback(
      {} as never,
      {
        order: { orderID: "client_ref_123" },
        payment: {
          amount: 125,
          currency: "RON",
          ntpID: "ntp_123",
          status: 3,
        },
      },
      {
        ...runtimeOptions,
        trustUnverifiedCallbacks: false,
        fetch: async () => {
          throw new Error("network unavailable")
        },
      },
    )

    expect(result.action).toBe("deferred")
    expect(result.verification?.outcome).toBe("unavailable")
    expect(completeSpy).not.toHaveBeenCalled()
  })

  it("completes a successful callback exactly once", async () => {
    vi.spyOn(financeService, "listPaymentSessions").mockResolvedValue({
      data: [{ ...baseSession, provider: "netopia", externalReference: "client_ref_123" }],
      total: 1,
      limit: 1,
      offset: 0,
    })
    const completeSpy = vi.spyOn(financeService, "completePaymentSession").mockResolvedValue({
      ...baseSession,
      provider: "netopia",
      status: "paid",
      externalReference: "client_ref_123",
      providerSessionId: "ntp_123",
      providerPaymentId: "ntp_123",
    })

    const result = await netopiaService.handleCallback(
      {} as never,
      {
        order: { orderID: "client_ref_123" },
        payment: {
          amount: 125,
          currency: "RON",
          ntpID: "ntp_123",
          status: 3,
          data: { AuthCode: "AUTH1", RRN: "RRN1" },
        },
      },
      runtimeOptions,
    )

    expect(result.action).toBe("completed")
    expect(completeSpy).toHaveBeenCalledTimes(1)
  })

  it("marks in-flight statuses as processing", async () => {
    vi.spyOn(financeService, "listPaymentSessions").mockResolvedValue({
      data: [{ ...baseSession, provider: "netopia", externalReference: "client_ref_123" }],
      total: 1,
      limit: 1,
      offset: 0,
    })
    const updateSpy = vi.spyOn(financeService, "updatePaymentSession").mockResolvedValue({
      ...baseSession,
      provider: "netopia",
      status: "processing",
      externalReference: "client_ref_123",
    })

    const result = await netopiaService.handleCallback(
      {} as never,
      {
        order: { orderID: "client_ref_123" },
        payment: {
          amount: 125,
          currency: "RON",
          ntpID: "ntp_123",
          status: 1,
        },
      },
      runtimeOptions,
    )

    expect(result.action).toBe("processing")
    expect(updateSpy).toHaveBeenCalledTimes(1)
  })

  it("completes the session even when the callback currency differs from the order", async () => {
    // Netopia auto-converts non-RON orders into RON for processing — an
    // EUR session legitimately receives a RON-denominated callback. The
    // handler trusts the status (orderID is the unguessable bearer), not
    // the converted amount/currency. See `service-callback.ts` comment.
    vi.spyOn(financeService, "listPaymentSessions").mockResolvedValue({
      data: [
        {
          ...baseSession,
          currency: "EUR",
          provider: "netopia",
          externalReference: "client_ref_123",
        },
      ],
      total: 1,
      limit: 1,
      offset: 0,
    })
    const completeSpy = vi.spyOn(financeService, "completePaymentSession").mockResolvedValue({
      ...baseSession,
      currency: "EUR",
      provider: "netopia",
      status: "paid",
      externalReference: "client_ref_123",
    })

    const result = await netopiaService.handleCallback(
      {} as never,
      {
        order: { orderID: "client_ref_123" },
        payment: {
          amount: 999,
          currency: "RON",
          ntpID: "ntp_123",
          status: 3,
        },
      },
      runtimeOptions,
    )

    expect(result.action).toBe("completed")
    expect(completeSpy).toHaveBeenCalledTimes(1)
  })

  it("treats duplicate success callbacks as idempotent", async () => {
    vi.spyOn(financeService, "listPaymentSessions").mockResolvedValue({
      data: [
        {
          ...baseSession,
          provider: "netopia",
          status: "paid",
          externalReference: "client_ref_123",
        },
      ],
      total: 1,
      limit: 1,
      offset: 0,
    })
    const updateSpy = vi.spyOn(financeService, "updatePaymentSession").mockResolvedValue({
      ...baseSession,
      provider: "netopia",
      status: "paid",
      externalReference: "client_ref_123",
    })
    const completeSpy = vi.spyOn(financeService, "completePaymentSession")

    const result = await netopiaService.handleCallback(
      {} as never,
      {
        order: { orderID: "client_ref_123" },
        payment: {
          amount: 125,
          currency: "RON",
          ntpID: "ntp_123",
          status: 5,
        },
      },
      runtimeOptions,
    )

    expect(result.action).toBe("ignored")
    expect(result.reason).toBe("already_completed")
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(completeSpy).not.toHaveBeenCalled()
  })
})
