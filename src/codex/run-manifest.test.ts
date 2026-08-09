import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readRunManifest, reviewContinuationClientMessageId } from "./run-manifest"

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
    execution_mode: "native_v2",
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
    execution_mode: "native_v2",
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
    execution_mode: "native_v2",
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
    execution_mode: "native_v2",
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
    execution_mode: "native_v2",
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

test("validates durable review continuation ownership", () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-run-manifest-review-continuation-"))
  const clientUserMessageId = reviewContinuationClientMessageId("run-review", "root", "initial-turn")
  const base = {
    schemaVersion: 1,
    runId: "run-review",
    task: "pr_opened",
    state: "ROOT_DRAINING",
    execution_mode: "explicit_child",
    rootThreadId: "root",
    rootTurnId: "initial-turn",
    restartAttempts: 0,
    startedAt: new Date(Date.now() - 1_000).toISOString(),
    wholeRunDeadlineAt: new Date(Date.now() + 10_000).toISOString(),
    lastSemanticProgressAt: new Date(Date.now() - 500).toISOString(),
    drainDeadlineAt: new Date(Date.now() + 5_000).toISOString(),
    updatedAt: new Date().toISOString(),
  }
  writeManifest(workdir, {
    ...base,
    reviewContinuation: {
      schemaVersion: 1,
      clientUserMessageId,
      phase: "dispatching",
      initialTurnId: "initial-turn",
    },
  })
  expect(readRunManifest(workdir)).toMatchObject({
    reviewContinuation: {
      phase: "dispatching",
      initialTurnId: "initial-turn",
      clientUserMessageId,
    },
  })

  const invalid = [
    { phase: "started", rootTurnId: "initial-turn" },
    { phase: "started", rootTurnId: "continuation-turn", continuationTurnId: undefined },
    { phase: "started", rootTurnId: "continuation-turn", continuationTurnId: "initial-turn" },
    { phase: "completed", state: "ROOT_RUNNING", rootTurnId: "continuation-turn", continuationTurnId: "continuation-turn" },
  ]
  for (const candidate of invalid) {
    writeManifest(workdir, {
      ...base,
      ...candidate,
      reviewContinuation: {
        schemaVersion: 1,
        clientUserMessageId,
        phase: candidate.phase,
        initialTurnId: "initial-turn",
        ...(candidate.continuationTurnId ? { continuationTurnId: candidate.continuationTurnId } : {}),
      },
    })
    expect(() => readRunManifest(workdir)).toThrow(/reviewContinuation/)
  }
})
