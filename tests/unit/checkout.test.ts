import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  startPaymentSession: vi.fn(),
}))

vi.mock("../../src/service-start.js", () => ({
  startPaymentSession: mocks.startPaymentSession,
}))

import { createNetopiaCheckoutStarter } from "../../src/checkout.js"

describe("createNetopiaCheckoutStarter", () => {
  it("normalizes the Netopia start result into the checkout starter contract", async () => {
    mocks.startPaymentSession.mockResolvedValue({
      orderId: "order_123",
      session: {
        id: "pmss_123",
        redirectUrl: "https://secure.netopia.example/pay",
        externalReference: "order_123",
        providerSessionId: "ntp_123",
        providerPaymentId: "ntp_123",
      },
      providerResponse: {
        payment: {
          paymentURL: "https://secure.netopia.example/pay",
          ntpID: "ntp_123",
        },
      },
    })

    const starter = createNetopiaCheckoutStarter()
    const result = await starter({
      db: {} as never,
      bookingId: "book_123",
      plan: {
        bookingId: "book_123",
        method: "card",
        stage: "initial",
        paymentSessionTarget: "invoice",
        documentType: "invoice",
        willCreateDefaultPaymentPlan: false,
        selectedSchedule: null,
        selectedInvoice: null,
        amountCents: 10000,
        currency: "EUR",
        recommendedAction: "create_invoice_then_payment_session",
      },
      invoice: null,
      paymentSession: {
        id: "pmss_123",
      } as never,
      input: {
        method: "card",
        stage: "initial",
        ensureDefaultPaymentPlan: true,
      },
      startProvider: {
        provider: "netopia",
        payload: {
          billing: {
            email: "traveler@example.com",
            phone: "0712345678",
            firstName: "Ana",
            lastName: "Ionescu",
            city: "Bucharest",
            country: 642,
            state: "B",
            postalCode: "010101",
            details: "Main street 1",
          },
        },
      },
      bindings: {},
    })

    expect(mocks.startPaymentSession).toHaveBeenCalledWith(
      {} as never,
      "pmss_123",
      expect.objectContaining({
        billing: expect.objectContaining({
          email: "traveler@example.com",
        }),
      }),
      {},
      undefined,
      {},
    )
    expect(result).toEqual({
      provider: "netopia",
      paymentSessionId: "pmss_123",
      redirectUrl: "https://secure.netopia.example/pay",
      externalReference: "order_123",
      providerSessionId: "ntp_123",
      providerPaymentId: "ntp_123",
      response: {
        orderId: "order_123",
        providerResponse: {
          payment: {
            paymentURL: "https://secure.netopia.example/pay",
            ntpID: "ntp_123",
          },
        },
      },
    })
  })
})
