import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { decideCollaborationMode, writeCapabilityDecision } from "./capability"

const available = {
  version: "codex-cli 0.147.0",
  multiAgentV2: true,
  featureOutput: "multi_agent_v2 stable true",
}

test("selects native v2 only when the pinned capability gate passes", () => {
  expect(decideCollaborationMode({
    expectedVersion: "0.147.0",
    env: {},
    probe: () => available,
  })).toMatchObject({
    codexVersion: "codex-cli 0.147.0",
    codexV2Gate: "passed",
    executionMode: "native_v2",
    collaborationMode: "native-v2",
  })
})

test("falls back to explicit children for missing v2, version drift, or engine override", () => {
  const missing = decideCollaborationMode({
    expectedVersion: "0.147.0",
    env: {},
    probe: () => ({ ...available, multiAgentV2: false }),
  })
  expect(missing).toMatchObject({ codexV2Gate: "failed", executionMode: "explicit_child" })
  expect(missing.reason).toContain("multi_agent_v2")

  const drift = decideCollaborationMode({
    expectedVersion: "0.147.0",
    env: {},
    probe: () => ({ ...available, version: "codex-cli 0.148.0" }),
  })
  expect(drift.reason).toContain("version mismatch")

  const forced = decideCollaborationMode({
    expectedVersion: "0.147.0",
    env: { CCHP_FORCE_EXPLICIT_CHILD: "1" },
    probe: () => available,
  })
  expect(forced).toMatchObject({ codexV2Gate: "failed", collaborationMode: "explicit-exec" })
  expect(forced.reason).toContain("forced")
})

test("persists the capability decision atomically", () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-capability-"))
  const path = join(root, "capability.json")
  const decision = decideCollaborationMode({ expectedVersion: "0.147.0", env: {}, probe: () => available })
  writeCapabilityDecision(path, decision)
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
    schemaVersion: 1,
    executionMode: "native_v2",
  })
})
