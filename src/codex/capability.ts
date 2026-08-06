import { renameSync, writeFileSync } from "node:fs"
import type { CollaborationMode } from "./config"
import { assertPinnedVersion, probeCapabilities, type CodexCapability } from "./cli"

export interface CollaborationDecision {
  schemaVersion: 1
  codexVersion: string
  expectedVersion: string
  codexV2Gate: "passed" | "failed"
  executionMode: "native_v2" | "explicit_child"
  collaborationMode: CollaborationMode
  reason?: string
  featureOutput: string
  decidedAt: string
}

export interface CapabilityDecisionOptions {
  codexBin?: string
  expectedVersion?: string
  env?: Record<string, string | undefined>
  probe?: (codexBin: string, env: Record<string, string | undefined>) => CodexCapability
}

export function decideCollaborationMode(options: CapabilityDecisionOptions = {}): CollaborationDecision {
  const env = options.env ?? process.env
  const expectedVersion = options.expectedVersion ?? env.CCHP_CODEX_VERSION ?? "0.146.0"
  const forced = env.CCHP_FORCE_EXPLICIT_CHILD === "1"
  let capability: CodexCapability | undefined
  try {
    capability = (options.probe ?? probeCapabilities)(options.codexBin ?? env.CODEX_BIN ?? "codex", env)
    assertPinnedVersion(capability.version, expectedVersion)
    if (forced) throw new Error("explicit child mode forced by CCHP_FORCE_EXPLICIT_CHILD")
    if (!capability.multiAgentV2) throw new Error("multi_agent_v2 is not stable/enabled")
    return {
      schemaVersion: 1,
      codexVersion: capability.version,
      expectedVersion,
      codexV2Gate: "passed",
      executionMode: "native_v2",
      collaborationMode: "native-v2",
      featureOutput: capability.featureOutput,
      decidedAt: new Date().toISOString(),
    }
  } catch (error) {
    return {
      schemaVersion: 1,
      codexVersion: capability?.version ?? "unavailable",
      expectedVersion,
      codexV2Gate: "failed",
      executionMode: "explicit_child",
      collaborationMode: "explicit-exec",
      reason: error instanceof Error ? error.message : String(error),
      featureOutput: capability?.featureOutput ?? "",
      decidedAt: new Date().toISOString(),
    }
  }
}

export function writeCapabilityDecision(path: string, decision: CollaborationDecision): void {
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(decision, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  renameSync(temporary, path)
}
