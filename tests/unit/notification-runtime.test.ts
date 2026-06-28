import { describe, expect, it, vi } from "vitest"

import { buildNetopiaNotificationRuntime } from "../../src/notification-runtime.js"

describe("buildNetopiaNotificationRuntime", () => {
  it("uses resolved notification providers once", () => {
    const resolveNotificationProviders = vi.fn(() => [
      {
        name: "email-provider",
        channels: ["email"],
        send: vi.fn(async () => ({ id: "ntf_123", provider: "email-provider" })),
      },
    ])

    const runtime = buildNetopiaNotificationRuntime(
      { VOYANT_CLOUD_API_KEY: "k_test" },
      { resolveNotificationProviders },
    )

    expect(resolveNotificationProviders).toHaveBeenCalledOnce()
    expect(runtime.dispatcher).toBeTruthy()
  })

  it("throws when no providers are supplied", () => {
    expect(() => buildNetopiaNotificationRuntime({}, {})).toThrow(/requires/)
  })

  it("prefers an explicit dispatcher override", () => {
    const dispatcher = {
      send: vi.fn(async () => ({
        id: "ntf_123",
        channel: "email",
        provider: "email-provider",
      })),
    }

    const runtime = buildNetopiaNotificationRuntime({}, {}, dispatcher as never)

    expect(runtime.dispatcher).toBe(dispatcher)
  })
})
