import type { Context } from "hono"
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  startPaymentSession: vi.fn(),
}))

vi.mock("../../src/service-start.js", () => ({
  startPaymentSession: mocks.startPaymentSession,
}))

import { netopiaCardPaymentStarter } from "../../src/card-payment-starter.js"
import { NETOPIA_RUNTIME_CONTAINER_KEY } from "../../src/plugin.js"

const billing = {
  email: "traveler@example.com",
  phone: "0712345678",
  firstName: "Ana",
  lastName: "Ionescu",
  city: "Bucharest",
  country: 642,
  state: "B",
  postalCode: "010101",
  details: "Main street 1",
}

function makeContext(runtime: unknown): Context {
  return {
    var: {
      container: {
        resolve: (key: string) => (key === NETOPIA_RUNTIME_CONTAINER_KEY ? runtime : undefined),
      },
    },
  } as Context
}

describe("netopiaCardPaymentStarter", () => {
  it("returns null when the container has no Netopia runtime", async () => {
    const starter = netopiaCardPaymentStarter()
    const result = await starter(makeContext(undefined), {
      db: {} as never,
      sessionId: "pmss_123",
      billing,
    })

    expect(result).toBeNull()
    expect(mocks.startPaymentSession).not.toHaveBeenCalled()
  })

  it("starts the Netopia payment and returns the redirect url when configured", async () => {
    mocks.startPaymentSession.mockResolvedValue({
      orderId: "order_123",
      session: { id: "pmss_123", redirectUrl: "https://secure.netopia.example/pay" },
      providerResponse: { payment: { paymentURL: "https://secure.netopia.example/pay" } },
    })

    const runtime = { posSignature: "POS" }
    const db = {} as never
    const starter = netopiaCardPaymentStarter()
    const result = await starter(makeContext(runtime), {
      db,
      sessionId: "pmss_123",
      billing,
      description: "Flight pmss_123",
      returnUrl: "https://checkout.example/return",
    })

    expect(mocks.startPaymentSession).toHaveBeenCalledWith(
      db,
      "pmss_123",
      {
        billing,
        description: "Flight pmss_123",
        returnUrl: "https://checkout.example/return",
      },
      runtime,
    )
    expect(result).toEqual({ redirectUrl: "https://secure.netopia.example/pay" })
  })

  it("maps a missing redirect url to null", async () => {
    mocks.startPaymentSession.mockResolvedValue({
      orderId: "order_123",
      session: { id: "pmss_123", redirectUrl: null },
      providerResponse: { payment: {} },
    })

    const starter = netopiaCardPaymentStarter()
    const result = await starter(makeContext({ posSignature: "POS" }), {
      db: {} as never,
      sessionId: "pmss_123",
      billing,
    })

    expect(result).toEqual({ redirectUrl: null })
  })
})
