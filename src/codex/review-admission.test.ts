import { expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ReviewAdmissionLedger } from "./review-admission"
import { parseJsonl } from "./jsonl"

const RESULT = {
  schemaVersion: 1 as const,
  artifactPath: "/tmp/cchp-review-result.json",
  artifactSha256: "a".repeat(64),
  outputSha256: "b".repeat(64),
  outputBytes: 17,
}

test("review admission is durable, unique, bound, and uses an absolute capped deadline", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cchp-review-admission-")), "review.jsonl")
  const ledger = new ReviewAdmissionLedger(path, "run-1")
  const admitted = ledger.admit({
    taskId: "correctness-1",
    role: "correctness",
    passKind: "correctness",
    mode: "native_v2",
    prompt: "inspect the changed request path",
    now: 1_000,
    timeoutMs: 60 * 60 * 1000,
  })
  expect(Date.parse(admitted.deadlineAt) - Date.parse(admitted.admittedAt)).toBe(30 * 60 * 1000)
  expect(admitted.reference.promptSha256).toMatch(/^[0-9a-f]{64}$/)
  ledger.bind("correctness-1", "spawn-1", "child-1", "session-1")
  expect(() => ledger.markTerminalByChild("child-1", "completed")).toThrow("result binding")
  ledger.markTerminalByChild("child-1", "completed", undefined, RESULT, 2_000)
  ledger.assertFinalizable(true)

  const replayed = new ReviewAdmissionLedger(path, "run-1")
  expect(replayed.task("correctness-1")).toMatchObject({
    state: "completed",
    spawnItemId: "spawn-1",
    childThreadId: "child-1",
    childSessionId: "session-1",
    result: RESULT,
  })
  expect(() => replayed.admit({ taskId: "correctness-1", role: "other", passKind: "verifier", mode: "native_v2", prompt: "different" })).toThrow("identity drift")
  expect(() => replayed.bind("correctness-1", "spawn-2", "child-2")).toThrow("spawn item drift")
})

test("separate ledger instances refresh admissions, bindings, and immutable terminal results", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cchp-review-admission-refresh-")), "review.jsonl")
  const first = new ReviewAdmissionLedger(path, "run-refresh")
  const second = new ReviewAdmissionLedger(path, "run-refresh")
  first.admit({ taskId: "task-1", role: "reviewer", passKind: "review_shard", mode: "explicit_child", prompt: "inspect" })
  expect(second.task("task-1")?.state).toBe("admitted")
  second.bind("task-1", "spawn-1", "child-1", "session-1")
  first.markTerminalByChild("child-1", "completed", undefined, RESULT)
  expect(second.task("task-1")).toMatchObject({ state: "completed", result: RESULT })
  expect(() => second.markTerminal("task-1", "completed", undefined, { ...RESULT, outputSha256: "c".repeat(64) })).toThrow("result drift")
})

test("ledger replay rejects terminal rollback and conflicting terminal state", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cchp-review-admission-replay-")), "review.jsonl")
  const ledger = new ReviewAdmissionLedger(path, "run-replay")
  ledger.admit({ taskId: "task-1", role: "reviewer", passKind: "review_shard", mode: "explicit_child", prompt: "inspect" })
  ledger.bind("task-1", "spawn-1", "child-1")
  ledger.markTerminal("task-1", "completed", undefined, RESULT)

  appendFileSync(path, `${JSON.stringify({
    event: "review_spawn_bound",
    runId: "run-replay",
    taskId: "task-1",
    spawnItemId: "spawn-1",
    childThreadId: "child-1",
    state: "spawn_bound",
  })}\n`)
  expect(() => new ReviewAdmissionLedger(path, "run-replay")).toThrow("terminal")
})

test("snapshot replay stays immutable after the ledger pathname changes", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cchp-review-admission-snapshot-")), "review.jsonl")
  const live = new ReviewAdmissionLedger(path, "run-snapshot")
  live.admit({ taskId: "task-1", role: "reviewer", passKind: "review_shard", mode: "explicit_child", prompt: "inspect" })
  live.bind("task-1", "spawn-1", "child-1", "session-1")
  live.markTerminal("task-1", "completed", undefined, RESULT)
  const replay = ReviewAdmissionLedger.fromSnapshot(parseJsonl(readFileSync(path), path), "run-snapshot")
  appendFileSync(path, "invalid durable replacement\n")
  expect(replay.entries()).toHaveLength(1)
  expect(replay.task("task-1")?.state).toBe("completed")
  expect(() => replay.assertFinalizable(true)).not.toThrow()
})

test("review admission rejects the 201st task and expired/open finalization", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cchp-review-admission-limit-")), "review.jsonl")
  const ledger = new ReviewAdmissionLedger(path, "run-2")
  for (let index = 0; index < 200; index++) {
    ledger.admit({ taskId: `task-${index}`, role: "reviewer", passKind: "review_shard", mode: "explicit_child", prompt: `review shard ${index}`, now: 0, timeoutMs: 1 })
  }
  expect(() => ledger.admit({ taskId: "task-200", role: "reviewer", passKind: "review_shard", mode: "explicit_child", prompt: "overflow" })).toThrow("limit exceeded")
  expect(ledger.expired(2)).toHaveLength(200)
  expect(() => ledger.assertFinalizable(true)).toThrow("review finalization blocked")
})
