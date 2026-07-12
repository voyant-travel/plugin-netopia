import { describe, expect, it } from "vitest"

import netopiaAdminOpenApi from "../../openapi/admin/netopia.json"
import packageJson from "../../package.json"
import { createNetopiaFinanceRoutes, NETOPIA_ADMIN_OPENAPI_API_ID } from "../../src/plugin.js"
import netopiaVoyantPlugin from "../../src/voyant.js"

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
  it("publishes package-owned plugin metadata and source/publish exports", () => {
    expect(packageJson.voyant).toEqual({
      schemaVersion: "voyant.package.v1",
      kind: "plugin",
      manifest: "./voyant",
      compatibleWith: {
        framework: ">=0.35.0",
        targets: ["node", "voyant-cloud"],
        modes: ["local", "managed-cloud", "self-hosted"],
      },
    })
    expect(packageJson.exports["./voyant"]).toBe("./src/voyant.ts")
    expect(packageJson.exports["./openapi/admin"]).toBe("./openapi/admin/netopia.json")
    expect(packageJson.publishConfig.exports["./voyant"]).toEqual({
      types: "./dist/voyant.d.ts",
      import: "./dist/voyant.js",
      default: "./dist/voyant.js",
    })
  })

  it("declares the finance admin, callback, runtime, and capability contract", () => {
    expect(netopiaVoyantPlugin).toMatchObject({
      schemaVersion: "voyant.plugin.v1",
      id: "@voyant-travel/plugin-netopia",
      packageName: "@voyant-travel/plugin-netopia",
      provides: {
        capabilities: ["finance.card-payment", "finance.payment-provider.netopia"],
      },
      requires: {
        capabilities: ["finance.payment-sessions", "notifications.delivery"],
      },
      api: [
        {
          id: "@voyant-travel/plugin-netopia#api.admin",
          surface: "admin",
          mount: "finance",
          transactional: true,
          openapi: { document: "netopia" },
          runtime: {
            entry: "@voyant-travel/plugin-netopia",
            export: "createNetopiaFinanceExtension",
          },
        },
        {
          id: "@voyant-travel/plugin-netopia#api.webhook",
          surface: "webhook",
          mount: "finance",
          anonymous: true,
          transactional: true,
          runtime: {
            entry: "@voyant-travel/plugin-netopia",
            export: "createNetopiaFinanceExtension",
          },
        },
      ],
      config: [
        { key: "NETOPIA_MODE", default: "sandbox" },
        { key: "NETOPIA_NOTIFY_URL", required: true },
        { key: "NETOPIA_REDIRECT_URL", required: true },
      ],
      secrets: [
        { key: "NETOPIA_API_KEY", required: true },
        { key: "NETOPIA_POS_SIGNATURE", required: true },
        { key: "NETOPIA_IPN_PUBLIC_KEY", required: true },
      ],
      webhooks: [
        {
          id: "@voyant-travel/plugin-netopia#webhook.ipn",
          direction: "inbound",
          apiId: "@voyant-travel/plugin-netopia#api.webhook",
          secretIds: [
            "@voyant-travel/plugin-netopia#secret.api-key",
            "@voyant-travel/plugin-netopia#secret.pos-signature",
            "@voyant-travel/plugin-netopia#secret.ipn-public-key",
          ],
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
    const runtimeNamespace = await import("@voyant-travel/plugin-netopia")

    for (const facet of netopiaVoyantPlugin.api) {
      expect(facet.runtime.entry).toBe("@voyant-travel/plugin-netopia")
      expect(runtimeNamespace[facet.runtime.export]).toEqual(expect.any(Function))
    }
  }, 15_000)
})
