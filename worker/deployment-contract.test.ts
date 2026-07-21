import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

interface DeploymentEnvironment {
  name: string
  workers_dev: boolean
  preview_urls: boolean
  vars: { VOYANT_ENVIRONMENT: string }
  secrets: { required: string[] }
  observability: {
    enabled: boolean
    logs: { enabled: boolean }
    traces: { enabled: boolean }
  }
}

describe("Netopia Worker deployment contract", () => {
  it("keeps staging and production isolated and explicitly authenticated", async () => {
    const config = JSON.parse(
      await readFile(resolve(repositoryRoot, "worker/wrangler.jsonc"), "utf8"),
    )

    expect(config.workers_dev).toBe(false)
    expect(Object.keys(config.env)).toEqual(["staging", "production"])
    for (const [environmentName, environment] of Object.entries(config.env) as Array<
      [string, DeploymentEnvironment]
    >) {
      expect(environment.name).toBe(
        environmentName === "production"
          ? "voyant-netopia-worker"
          : "voyant-netopia-worker-staging",
      )
      expect(environment.workers_dev).toBe(true)
      expect(environment.preview_urls).toBe(false)
      expect(environment.vars).toEqual({ VOYANT_ENVIRONMENT: environmentName })
      expect(environment.secrets.required).toEqual(["ORIGIN_TRUST_SECRET"])
      expect(environment.observability).toMatchObject({
        enabled: true,
        logs: { enabled: true },
        traces: { enabled: true },
      })
    }
  })

  it("provides non-mutating validation commands for both environments", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> }

    for (const environment of ["staging", "production"]) {
      expect(packageJson.scripts[`worker:deploy:dry-run:${environment}`]).toContain(
        `--env ${environment}`,
      )
      expect(packageJson.scripts[`worker:deploy:dry-run:${environment}`]).toContain("--dry-run")
    }
  })
})
