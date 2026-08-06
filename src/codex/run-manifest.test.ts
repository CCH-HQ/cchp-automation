import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readRunManifest } from "./run-manifest"

function writeManifest(workdir: string, value: unknown): void {
  const codexDir = join(workdir, "ctx", "codex")
  mkdirSync(codexDir, { recursive: true })
  writeFileSync(join(codexDir, "run-manifest.json"), `${JSON.stringify(value)}\n`)
}

test("reads a matching nonterminal run manifest as a resume contract", () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-run-manifest-"))
  const startedAt = new Date(Date.now() - 1_000).toISOString()
  const wholeRunDeadlineAt = new Date(Date.now() + 10_000).toISOString()
  writeManifest(workdir, {
    schemaVersion: 1,
    runId: "run-1",
    task: "manual",
    state: "ROOT_RUNNING",
    rootThreadId: "root",
    rootTurnId: "turn",
    restartAttempts: 1,
    startedAt,
    wholeRunDeadlineAt,
    lastSemanticProgressAt: startedAt,
    updatedAt: new Date().toISOString(),
  })
  expect(readRunManifest(workdir, { runId: "run-1", task: "manual" })).toMatchObject({
    runId: "run-1",
    task: "manual",
    state: "ROOT_RUNNING",
    rootThreadId: "root",
    rootTurnId: "turn",
    restartAttempts: 1,
    startedAt,
    wholeRunDeadlineAt,
    lastSemanticProgressAt: startedAt,
  })
})

test("rejects stale, mismatched and terminal run manifests", () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-run-manifest-invalid-"))
  writeManifest(workdir, {
    schemaVersion: 1,
    runId: "other-run",
    task: "manual",
    state: "ROOT_RUNNING",
    rootThreadId: "root",
    rootTurnId: "turn",
    startedAt: new Date(Date.now() - 1_000).toISOString(),
    wholeRunDeadlineAt: new Date(Date.now() + 10_000).toISOString(),
    lastSemanticProgressAt: new Date(Date.now() - 1_000).toISOString(),
    updatedAt: new Date().toISOString(),
  })
  expect(() => readRunManifest(workdir, { runId: "run-1", task: "manual" })).toThrow(/run id mismatch/)

  writeManifest(workdir, {
    schemaVersion: 1,
    runId: "run-1",
    task: "manual",
    state: "SUCCEEDED",
    rootThreadId: "root",
    rootTurnId: "turn",
    updatedAt: new Date().toISOString(),
  })
  expect(() => readRunManifest(workdir, { runId: "run-1", task: "manual" })).toThrow(/terminal run/)
})

test("rejects malformed optional pending provider usage fields", () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-run-manifest-pending-invalid-"))
  const base = {
    schemaVersion: 1,
    runId: "run-1",
    task: "manual",
    state: "ROOT_RUNNING",
    rootThreadId: "root",
    rootTurnId: "turn",
    startedAt: new Date(Date.now() - 1_000).toISOString(),
    wholeRunDeadlineAt: new Date(Date.now() + 10_000).toISOString(),
    lastSemanticProgressAt: new Date(Date.now() - 1_000).toISOString(),
    updatedAt: new Date().toISOString(),
    pendingProviderUsage: [{ providerId: "p", model: "m", responseId: "r", totalTokens: 1, inputTokens: 1, outputTokens: 0 }],
  }
  for (const field of ["cachedInputTokens", "reasoningOutputTokens", "contextWindow"] as const) {
    writeManifest(workdir, { ...base, pendingProviderUsage: [{ ...base.pendingProviderUsage[0], [field]: -1 }] })
    expect(() => readRunManifest(workdir, { runId: "run-1", task: "manual" })).toThrow(field)
  }
})
