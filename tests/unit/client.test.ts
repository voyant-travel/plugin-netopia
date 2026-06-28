import { CircuitOpenError, createCircuitBreaker } from "@voyant-travel/utils/resilience"
import { describe, expect, it, vi } from "vitest"

import { createNetopiaClient, resolveNetopiaRuntimeOptions } from "../../src/client.js"
import type { NetopiaFetch, NetopiaStartPaymentRequest } from "../../src/types.js"

function makeStartRequest(): NetopiaStartPaymentRequest {
  const address = {
    email: "traveler@example.com",
    phone: "0712345678",
    firstName: "Ana",
    lastName: "Popescu",
    city: "Bucharest",
    country: 40,
    state: "B",
    postalCode: "010101",
    details: "Str. Exemplu 1",
  }
  return {
    config: {
      emailTemplate: "confirm",
      notifyUrl: "https://api.example.com/callback",
      redirectUrl: "https://app.example.com/return",
      language: "ro",
    },
    payment: {
      options: { installments: 1 },
    },
    order: {
      posSignature: "pos-signature",
      dateTime: new Date().toISOString(),
      description: "Tour deposit",
      orderID: "pmss_123",
      amount: 125,
      currency: "RON",
      billing: address,
      shipping: address,
      products: [{ name: "Tour deposit", price: 125, vat: 0 }],
      installments: { selected: 1, available: [0] },
    },
  }
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

function textResponse(status: number, text: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error("not json")
    },
    text: async () => text,
  }
}

describe("resolveNetopiaRuntimeOptions", () => {
  it("merges env bindings with defaults", () => {
    const options = resolveNetopiaRuntimeOptions({
      NETOPIA_URL: "https://secure.mobilpay.ro/pay",
      NETOPIA_API_KEY: "api-key",
      NETOPIA_POS_SIGNATURE: "pos-signature",
      NETOPIA_NOTIFY_URL: "https://api.example.com/netopia/callback",
      NETOPIA_REDIRECT_URL: "https://app.example.com/checkout/return",
    })
    expect(options.language).toBe("ro")
    expect(options.emailTemplate).toBe("confirm")
    expect(options.successStatuses).toEqual([3, 5])
  })

  it("throws when required config is missing", () => {
    // apiUrl is no longer required — `mode` defaults to `sandbox` and resolves
    // to a known base. The first credential check now fires on `NETOPIA_API_KEY`.
    expect(() => resolveNetopiaRuntimeOptions({})).toThrow(/NETOPIA_API_KEY/)
  })

  it("rejects an invalid NETOPIA_MODE", () => {
    expect(() => resolveNetopiaRuntimeOptions({ NETOPIA_MODE: "test" })).toThrow(/NETOPIA_MODE/)
  })

  it("resolves the live base URL when NETOPIA_MODE=live", () => {
    const options = resolveNetopiaRuntimeOptions({
      NETOPIA_MODE: "live",
      NETOPIA_API_KEY: "api-key",
      NETOPIA_POS_SIGNATURE: "pos-signature",
      NETOPIA_NOTIFY_URL: "https://api.example.com/netopia/callback",
      NETOPIA_REDIRECT_URL: "https://app.example.com/checkout/return",
    })
    expect(options.apiUrl).toBe("https://secure.mobilpay.ro/pay")
  })

  it("NETOPIA_URL overrides the mode-resolved base", () => {
    const options = resolveNetopiaRuntimeOptions({
      NETOPIA_MODE: "live",
      NETOPIA_URL: "https://staging-proxy.internal/pay",
      NETOPIA_API_KEY: "api-key",
      NETOPIA_POS_SIGNATURE: "pos-signature",
      NETOPIA_NOTIFY_URL: "https://api.example.com/netopia/callback",
      NETOPIA_REDIRECT_URL: "https://app.example.com/checkout/return",
    })
    expect(options.apiUrl).toBe("https://staging-proxy.internal/pay")
  })

  it("throws when configured runtime values are invalid", () => {
    expect(() =>
      resolveNetopiaRuntimeOptions(
        {
          NETOPIA_URL: "https://secure.mobilpay.ro/pay",
          NETOPIA_API_KEY: "api-key",
          NETOPIA_POS_SIGNATURE: "pos-signature",
          NETOPIA_NOTIFY_URL: "https://api.example.com/netopia/callback",
          NETOPIA_REDIRECT_URL: "https://app.example.com/checkout/return",
        },
        {
          successStatuses: [3.5],
        },
      ),
    ).toThrow(/Invalid Netopia runtime options/)
  })
})

describe("createNetopiaClient.startCardPayment", () => {
  it("posts to /payment/card/start with Authorization header", async () => {
    const fetchMock = vi.fn<NetopiaFetch>(async () =>
      jsonResponse(200, {
        payment: { paymentURL: "https://secure.example.com/pay", ntpID: "ntp_123", status: 1 },
      }),
    )

    const client = createNetopiaClient({
      apiUrl: "https://secure.mobilpay.ro/pay/",
      apiKey: "api-key",
      fetch: fetchMock,
    })

    const response = await client.startCardPayment({
      config: {
        emailTemplate: "confirm",
        notifyUrl: "https://api.example.com/callback",
        redirectUrl: "https://app.example.com/return",
        language: "ro",
      },
      payment: {
        options: { installments: 1 },
      },
      order: {
        posSignature: "pos-signature",
        dateTime: new Date().toISOString(),
        description: "Tour deposit",
        orderID: "pmss_123",
        amount: 125,
        currency: "RON",
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
        shipping: {
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
        products: [{ name: "Tour deposit", price: 125, vat: 0 }],
        installments: { selected: 1, available: [0] },
      },
    })

    expect(response.payment?.ntpID).toBe("ntp_123")
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://secure.mobilpay.ro/pay/payment/card/start")
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe("api-key")
  })

  it("throws on provider error payload", async () => {
    const fetchMock = vi.fn<NetopiaFetch>(async () =>
      jsonResponse(200, { error: { code: "bad_request", message: "No merchant" } }),
    )

    const client = createNetopiaClient({
      apiUrl: "https://secure.mobilpay.ro/pay",
      apiKey: "api-key",
      fetch: fetchMock,
    })

    await expect(
      client.startCardPayment({
        config: {
          emailTemplate: "confirm",
          notifyUrl: "https://api.example.com/callback",
          redirectUrl: "https://app.example.com/return",
          language: "ro",
        },
        payment: {
          options: { installments: 1 },
        },
        order: {
          posSignature: "pos-signature",
          dateTime: new Date().toISOString(),
          description: "Tour deposit",
          orderID: "pmss_123",
          amount: 125,
          currency: "RON",
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
          shipping: {
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
          products: [{ name: "Tour deposit", price: 125, vat: 0 }],
          installments: { selected: 1, available: [0] },
        },
      }),
    ).rejects.toThrow(/Netopia start payment failed/)
  })

  it("throws when fetch is unavailable", async () => {
    const originalFetch = globalThis.fetch
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: undefined,
      writable: true,
    })
    try {
      const client = createNetopiaClient({
        apiUrl: "https://secure.mobilpay.ro/pay",
        apiKey: "api-key",
      })
      await expect(
        client.startCardPayment({
          config: {
            emailTemplate: "confirm",
            notifyUrl: "https://api.example.com/callback",
            redirectUrl: "https://app.example.com/return",
            language: "ro",
          },
          payment: {
            options: { installments: 1 },
          },
          order: {
            posSignature: "pos-signature",
            dateTime: new Date().toISOString(),
            description: "Tour deposit",
            orderID: "pmss_123",
            amount: 125,
            currency: "RON",
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
            shipping: {
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
            products: [{ name: "Tour deposit", price: 125, vat: 0 }],
            installments: { selected: 1, available: [0] },
          },
        }),
      ).rejects.toThrow(/requires a fetch implementation/)
    } finally {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: originalFetch,
        writable: true,
      })
    }
  })

  it("surfaces non-2xx HTTP failures", async () => {
    const fetchMock = vi.fn<NetopiaFetch>(async () => textResponse(500, "gateway error"))
    const client = createNetopiaClient({
      apiUrl: "https://secure.mobilpay.ro/pay",
      apiKey: "api-key",
      fetch: fetchMock,
    })

    await expect(
      client.startCardPayment({
        config: {
          emailTemplate: "confirm",
          notifyUrl: "https://api.example.com/callback",
          redirectUrl: "https://app.example.com/return",
          language: "ro",
        },
        payment: {
          options: { installments: 1 },
        },
        order: {
          posSignature: "pos-signature",
          dateTime: new Date().toISOString(),
          description: "Tour deposit",
          orderID: "pmss_123",
          amount: 125,
          currency: "RON",
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
          shipping: {
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
          products: [{ name: "Tour deposit", price: 125, vat: 0 }],
          installments: { selected: 1, available: [0] },
        },
      }),
    ).rejects.toThrow(/\(500\)/)
  })
})

describe("createNetopiaClient — resilience", () => {
  it("never retries payment initiation, even on 503", async () => {
    const fetchMock = vi.fn<NetopiaFetch>(async () => textResponse(503, "gateway unavailable"))
    const client = createNetopiaClient({
      apiUrl: "https://secure.sandbox.netopia-payments.com",
      apiKey: "api-key",
      fetch: fetchMock,
      // Fresh breaker so this test doesn't share the module-level one.
      resilience: { breaker: createCircuitBreaker() },
    })

    await expect(client.startCardPayment(makeStartRequest())).rejects.toThrow(/\(503\)/)
    // Money movement: exactly one attempt, no automatic retry.
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it("fails fast with CircuitOpenError once the breaker trips", async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1, openMs: 60_000 })
    const fetchMock = vi.fn<NetopiaFetch>(async () => textResponse(500, "down"))
    const client = createNetopiaClient({
      apiUrl: "https://secure.sandbox.netopia-payments.com",
      apiKey: "api-key",
      fetch: fetchMock,
      resilience: { breaker },
    })

    await expect(client.startCardPayment(makeStartRequest())).rejects.toThrow(/\(500\)/)
    expect(fetchMock).toHaveBeenCalledOnce()

    // Breaker is open now: no network call, fail fast.
    await expect(client.startCardPayment(makeStartRequest())).rejects.toBeInstanceOf(
      CircuitOpenError,
    )
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
