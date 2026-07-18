import { describe, expect, it } from "vitest"

import netopiaAdminOpenApi from "../../openapi/admin/netopia.json"
import packageJson from "../../package.json"
import { createNetopiaFinanceRoutes, NETOPIA_ADMIN_OPENAPI_API_ID } from "../../src/plugin.js"
import netopiaVoyantAdapter from "../../src/voyant.js"

function expectTemplatedPathsToDeclareParameters(document: {
  paths?: Record<string, Record<string, { parameters?: unknown[] }>>
}) {
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    const parameterNames = Array.from(path.matchAll(/\{([^}]+)\}/g), (match) => match[1])

    for (const operation of Object.values(pathItem)) {
      for (const name of parameterNames) {
        expect(operation.parameters).toContainEqual({
          name,
          in: "path",
          required: true,
          schema: { type: "string" },
        })
      }
    }
  }
}

describe("Netopia deployment manifest", () => {
  it("publishes package-owned adapter metadata and source/publish exports", () => {
    expect(packageJson.voyant).toEqual({
      schemaVersion: "voyant.package.v1",
      kind: "adapter",
      manifest: "./voyant",
      compatibleWith: {
        framework: ">=0.35.0",
        targets: ["node", "voyant-cloud"],
        modes: ["local", "managed-cloud", "self-hosted"],
      },
    })
    expect(packageJson.exports["./voyant"]).toBe("./src/voyant.ts")
    expect(packageJson.exports["./adapter"]).toBe("./src/adapter.ts")
    expect(packageJson.exports["./openapi/admin"]).toBe("./openapi/admin/netopia.json")
    expect(packageJson.publishConfig.exports["./voyant"]).toEqual({
      types: "./dist/voyant.d.ts",
      import: "./dist/voyant.js",
      default: "./dist/voyant.js",
    })
  })

  it("declares the finance admin, callback, runtime, and capability contract", () => {
    expect(netopiaVoyantAdapter).toMatchObject({
      schemaVersion: "voyant.adapter.v1",
      id: "@voyant-travel/netopia-adapter",
      packageName: "@voyant-travel/netopia-adapter",
      provides: {
        capabilities: [
          "finance.card-payment",
          "finance.payment-provider.netopia",
          "payments.adapter.runtime",
        ],
      },
      requires: {
        capabilities: ["finance.payment-sessions", "notifications.delivery"],
      },
      api: [
        {
          id: "@voyant-travel/netopia-adapter#api.admin",
          surface: "admin",
          mount: "finance",
          transactional: true,
          openapi: { document: "netopia" },
          runtime: {
            entry: "@voyant-travel/netopia-adapter",
            export: "createNetopiaFinanceExtension",
          },
        },
        {
          id: "@voyant-travel/netopia-adapter#api.webhook",
          surface: "webhook",
          mount: "finance",
          anonymous: true,
          transactional: true,
          runtime: {
            entry: "@voyant-travel/netopia-adapter",
            export: "createNetopiaFinanceExtension",
          },
        },
      ],
      config: [
        { key: "NETOPIA_SANDBOX", default: "true" },
        { key: "NETOPIA_NOTIFY_URL", required: true },
        { key: "NETOPIA_REDIRECT_URL", required: true },
      ],
      secrets: [
        { key: "NETOPIA_PRIVATE_KEY", required: true },
        { key: "NETOPIA_MERCHANT_ID", required: true },
        { key: "NETOPIA_PUBLIC_KEY", required: true },
      ],
      webhooks: [
        {
          id: "@voyant-travel/netopia-adapter#webhook.ipn",
          direction: "inbound",
          apiId: "@voyant-travel/netopia-adapter#api.webhook",
          secretIds: [
            "@voyant-travel/netopia-adapter#secret.api-key",
            "@voyant-travel/netopia-adapter#secret.pos-signature",
            "@voyant-travel/netopia-adapter#secret.public-key",
          ],
        },
      ],
      providers: [
        {
          port: "payments.adapter.runtime",
          selection: { role: "payments", value: "netopia" },
          runtime: {
            entry: "@voyant-travel/netopia-adapter",
            export: "createNetopiaPaymentAdapter",
          },
        },
      ],
    })

    const document = createNetopiaFinanceRoutes().getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "Netopia admin", version: "1" },
    })
    const apiIds = Object.values(document.paths ?? {}).flatMap((path) =>
      Object.values(path).map((operation) => operation["x-voyant-api-id"]),
    )
    expect(apiIds).toEqual(Array.from({ length: 5 }, () => NETOPIA_ADMIN_OPENAPI_API_ID))
    expectTemplatedPathsToDeclareParameters(document)
    expectTemplatedPathsToDeclareParameters(netopiaAdminOpenApi)
  })

  it("points every runtime reference at a real package export", async () => {
    const runtimeNamespace = await import("@voyant-travel/netopia-adapter")

    for (const facet of [...netopiaVoyantAdapter.api, ...(netopiaVoyantAdapter.providers ?? [])]) {
      expect(facet.runtime.entry).toBe("@voyant-travel/netopia-adapter")
      expect(runtimeNamespace[facet.runtime.export]).toEqual(expect.any(Function))
    }
  }, 15_000)
})
