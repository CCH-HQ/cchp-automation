import { spawnSync } from "node:child_process"

export interface CodexCapability {
  version: string
  multiAgentV2: boolean
  featureOutput: string
}

export function codexVersion(codexBin = "codex", env: Record<string, string | undefined> = process.env): string {
  const result = spawnSync(codexBin, ["--version"], { env: env as NodeJS.ProcessEnv, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`codex --version failed: ${(result.stderr || result.stdout || "").trim()}`)
  const version = String(result.stdout || "").trim()
  if (!version) throw new Error("codex --version returned no output")
  return version
}

export function probeCapabilities(codexBin = "codex", env: Record<string, string | undefined> = process.env): CodexCapability {
  const version = codexVersion(codexBin, env)
  const feature = spawnSync(codexBin, ["features", "list"], { env: env as NodeJS.ProcessEnv, encoding: "utf8" })
  const featureOutput = `${feature.stdout || ""}\n${feature.stderr || ""}`
  const multiAgentV2 = /multi_agent_v2[\s:=]+(?:stable|enabled|true)/i.test(featureOutput)
  return { version, multiAgentV2, featureOutput }
}

export function assertPinnedVersion(actual: string, expected: string): void {
  if (actual !== expected && !actual.endsWith(` ${expected}`)) throw new Error(`Codex version mismatch: expected ${expected}, got ${actual}`)
}
