import { describe, expect, it, vi } from "vitest"

vi.mock("../../src/plugin.js", () => {
  throw new Error("the deployment manifest imported Netopia route bodies")
})

vi.mock("../../src/service.js", () => {
  throw new Error("the deployment manifest imported Netopia service bodies")
})

describe("Netopia deployment manifest import boundary", () => {
  it("loads without importing route or service bodies", async () => {
    const manifestNamespace = await import("../../src/voyant.js")

    expect(manifestNamespace.default).toBe(manifestNamespace.netopiaVoyantAdapter)
    expect(manifestNamespace.default.schemaVersion).toBe("voyant.adapter.v1")
  })
})
