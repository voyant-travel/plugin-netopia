import { execFile } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const rootDir = process.cwd()
const packDir = mkdtempSync(path.join(tmpdir(), "netopia-adapter-pack-"))
const consumerDir = mkdtempSync(path.join(tmpdir(), "netopia-adapter-consumer-"))

try {
  const { stdout } = await execFileAsync(
    "pnpm",
    ["pack", "--json", "--config.ignore-scripts=true", "--pack-destination", packDir],
    { cwd: rootDir, encoding: "utf8" },
  )
  const packResult = JSON.parse(stdout)
  const packInfo = Array.isArray(packResult) ? packResult[0] : packResult
  const tarballPath = path.join(packDir, path.basename(packInfo.filename))

  writeFileSync(
    path.join(consumerDir, "package.json"),
    `${JSON.stringify(
      {
        name: "netopia-adapter-external-consumer",
        version: "0.0.0",
        private: true,
        dependencies: { [packInfo.name]: `file:${tarballPath}` },
      },
      null,
      2,
    )}\n`,
  )

  await execFileAsync(
    "pnpm",
    ["install", "--ignore-scripts", "--lockfile-only", "--no-frozen-lockfile"],
    { cwd: consumerDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
} catch (error) {
  const detail = error.stderr?.trim() || error.stdout?.trim() || error.message
  throw new Error(`An external consumer could not install the packed plugin: ${detail}`)
} finally {
  rmSync(packDir, { recursive: true, force: true })
  rmSync(consumerDir, { recursive: true, force: true })
}
