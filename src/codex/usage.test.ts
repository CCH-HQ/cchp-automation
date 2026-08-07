import { expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { UsageLedger } from "./usage"

test("keeps cumulative snapshots and bills multiple provider responses for one Codex turn exactly once", () => {
  const path = join(mkdtempSync(join(tmpdir(), "usage-")), "usage.jsonl")
  const ledger = new UsageLedger({ path, totalBudget: 1_000 })
  const update = {
    threadId: "thread_1",
    turnId: "turn_1",
    tokenUsage: {
      total: {
        totalTokens: 150,
        inputTokens: 100,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 5,
        outputTokens: 50,
        reasoningOutputTokens: 10,
      },
      last: {
        totalTokens: 150,
        inputTokens: 100,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 5,
        outputTokens: 50,
        reasoningOutputTokens: 10,
      },
      modelContextWindow: 372000,
    },
  }

  expect(ledger.recordCodexUpdate(update)).toMatchObject({ acceptedRaw: false, consumed: 0 })
  expect(ledger.recordCodexUpdate(update)).toMatchObject({ acceptedRaw: false, consumed: 0 })
  expect(ledger.rawCompletions).toHaveLength(0)
  expect(ledger.cumulative.get("thread_1")?.totalTokens).toBe(150)
  expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1)

  expect(ledger.recordRaw({ threadId: "thread_1", turnId: "turn_1", responseId: "resp_1", totalTokens: 150 })).toMatchObject({ acceptedRaw: true, consumed: 150 })
  expect(ledger.recordRaw({ threadId: "thread_1", turnId: "turn_1", responseId: "resp_2", totalTokens: 150 })).toMatchObject({ acceptedRaw: true, consumed: 300, blockingAnomalies: 0 })
  expect(ledger.recordRaw({ threadId: "thread_1", turnId: "turn_1", responseId: "resp_2", totalTokens: 150 })).toMatchObject({ acceptedRaw: false, consumed: 300, blockingAnomalies: 0 })
  expect(ledger.rawCompletions).toHaveLength(2)
  expect(ledger.anomalies).toHaveLength(0)
})

test("replay restores multiple provider responses for one turn without rebilling", () => {
  const path = join(mkdtempSync(join(tmpdir(), "usage-turn-replay-")), "usage.jsonl")
  const recordedAt = new Date().toISOString()
  writeFileSync(path, [
    JSON.stringify({ kind: "raw_completion_usage", recordedAt, threadId: "root", turnId: "turn", responseId: "first", totalTokens: 10 }),
    JSON.stringify({ kind: "raw_completion_usage", recordedAt, threadId: "root", turnId: "turn", responseId: "second", totalTokens: 99 }),
    "",
  ].join("\n"))

  const restored = new UsageLedger({ path, totalBudget: 1_000 })
  expect(restored.budget).toMatchObject({ consumed: 109, blockingAnomalies: 0 })
  expect(restored.rawCompletions.map((record) => record.responseId)).toEqual(["first", "second"])
  expect(restored.anomalies).toHaveLength(0)
})

test("keeps context and billable input semantics separate and isolates prompt jumps by thread", () => {
  const ledger = new UsageLedger({ totalBudget: 1_000_000 })
  ledger.recordRaw({
    threadId: "root",
    turnId: "turn-1",
    responseId: "root-1",
    provider: "p",
    model: "m",
    inputTokens: 400_000,
    contextInputTokens: 12_000,
    billableInputTokens: 2_000,
    totalTokens: 402_000,
    contextWindow: 32_000,
    billingScopeId: "run-1",
    lineage: ["root"],
  })
  ledger.recordRaw({
    threadId: "child",
    turnId: "turn-2",
    responseId: "child-1",
    provider: "p",
    model: "m",
    inputTokens: 60_000,
    contextInputTokens: 60_000,
    billableInputTokens: 60_000,
    totalTokens: 60_000,
    contextWindow: 32_000,
    billingScopeId: "run-1",
    lineage: ["root", "child"],
  })

  expect(ledger.rawCompletions[0]).toMatchObject({ inputTokens: 400_000, contextInputTokens: 12_000, billableInputTokens: 2_000 })
  expect(ledger.anomalies.map((anomaly) => anomaly.type)).toEqual(["context_overflow"])
})

test("rejects malformed usage lineage before billing", () => {
  const ledger = new UsageLedger({ totalBudget: 1_000 })
  expect(ledger.recordRaw({
    threadId: "child",
    turnId: "turn",
    responseId: "response",
    totalTokens: 10,
    lineage: ["root"],
  })).toMatchObject({ acceptedRaw: false, consumed: 0, blockingAnomalies: 1 })
  expect(ledger.anomalies[0]?.type).toBe("invalid_usage_lineage")
})

test("classifies the same response crossing parent and child lineage as overlap without double billing", () => {
  const ledger = new UsageLedger({ totalBudget: 1_000 })
  expect(ledger.recordRaw({
    threadId: "root",
    turnId: "turn",
    responseId: "shared-response",
    billingScopeId: "run-1",
    lineage: ["root"],
    totalTokens: 120,
  })).toMatchObject({ acceptedRaw: true, consumed: 120 })
  expect(ledger.recordRaw({
    threadId: "child",
    parentThreadId: "root",
    turnId: "turn",
    responseId: "shared-response",
    billingScopeId: "run-1",
    lineage: ["root", "child"],
    totalTokens: 120,
  })).toMatchObject({ acceptedRaw: false, consumed: 120, blockingAnomalies: 1 })
  expect(ledger.anomalies.at(-1)?.type).toBe("lineage_billing_overlap")
})

test("rejects different response ids billed to overlapping parent and child lineage in the same turn", () => {
  const ledger = new UsageLedger({ totalBudget: 1_000 })
  expect(ledger.recordRaw({
    threadId: "root",
    turnId: "shared-turn",
    responseId: "root-response",
    billingScopeId: "run-1",
    lineage: ["root"],
    totalTokens: 120,
  })).toMatchObject({ acceptedRaw: true, consumed: 120 })
  expect(ledger.recordRaw({
    threadId: "child",
    parentThreadId: "root",
    turnId: "shared-turn",
    responseId: "child-response",
    billingScopeId: "run-1",
    lineage: ["root", "child"],
    totalTokens: 120,
  })).toMatchObject({ acceptedRaw: false, consumed: 120, blockingAnomalies: 1 })
  expect(ledger.anomalies.at(-1)?.type).toBe("lineage_billing_overlap")
})

test("deduplicates repeated reports of the same blocking anomaly", () => {
  const ledger = new UsageLedger({ totalBudget: 1_000 })
  ledger.recordRaw({ threadId: "root", turnId: "turn", responseId: "response", totalTokens: 10 })
  expect(ledger.recordRaw({ threadId: "root", turnId: "turn", responseId: "response", totalTokens: 11 }))
    .toMatchObject({ acceptedRaw: false, consumed: 10, blockingAnomalies: 1 })
  expect(ledger.recordRaw({ threadId: "root", turnId: "turn", responseId: "response", totalTokens: 12 }))
    .toMatchObject({ acceptedRaw: false, consumed: 10, blockingAnomalies: 1 })
  expect(ledger.anomalies).toHaveLength(1)
})

test("classifies the same response crossing billable scopes separately from ordinary response conflicts", () => {
  const ledger = new UsageLedger({ totalBudget: 1_000 })
  ledger.recordRaw({ threadId: "root", turnId: "turn", responseId: "shared", billingScopeId: "scope-a", totalTokens: 10 })
  expect(ledger.recordRaw({ threadId: "child", turnId: "turn", responseId: "shared", billingScopeId: "scope-b", totalTokens: 10 }))
    .toMatchObject({ acceptedRaw: false, consumed: 10, blockingAnomalies: 1 })
  expect(ledger.anomalies.at(-1)?.type).toBe("billing_scope_double_billing")
})

test("hydrates billing identities, cumulative snapshots, anomalies, and budget state", () => {
  const path = join(mkdtempSync(join(tmpdir(), "usage-replay-")), "usage.jsonl")
  const first = new UsageLedger({ path, totalBudget: 100_000 })
  first.recordCodexUpdate({
    threadId: "root",
    turnId: "turn-1",
    tokenUsage: {
      total: { totalTokens: 200, inputTokens: 150, cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 5 },
      last: { totalTokens: 200, inputTokens: 150, cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 5 },
      modelContextWindow: 372_000,
    },
  })
  first.recordRaw({ threadId: "root", turnId: "turn-1", responseId: "resp-1", provider: "p", model: "m", inputTokens: 20_000, totalTokens: 20_000 })
  first.recordRaw({ threadId: "root", turnId: "turn-2", responseId: "resp-2", provider: "p", model: "m", inputTokens: 60_001, totalTokens: 60_001 })
  const before = readFileSync(path, "utf8")

  const restored = new UsageLedger({ path, totalBudget: 1_000_000 })
  expect(restored.budget).toMatchObject({ consumed: 80_001, blockingAnomalies: 1 })
  expect(restored.cumulative.get("root")?.totalTokens).toBe(200)
  expect(restored.recordRaw({ threadId: "root", turnId: "turn-1", responseId: "resp-1", provider: "p", model: "m", inputTokens: 20_000, totalTokens: 20_000 })).toMatchObject({ acceptedRaw: false, consumed: 80_001 })
  expect(readFileSync(path, "utf8")).toBe(before)
})

test("usage replay ignores a torn final row but rejects durable middle corruption", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-torn-"))
  const path = join(root, "usage.jsonl")
  const ledger = new UsageLedger({ path, totalBudget: 1_000 })
  ledger.recordRaw({ threadId: "root", turnId: "turn", responseId: "response", totalTokens: 10 })
  appendFileSync(path, '{"kind":"raw_completion_usage"')
  expect(new UsageLedger({ path, totalBudget: 1_000 }).budget.consumed).toBe(10)

  const corrupt = join(root, "corrupt.jsonl")
  writeFileSync(corrupt, `${JSON.stringify({ kind: "thread_cumulative_usage", threadId: "root", turnId: "turn", totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 })}\ninvalid\n`)
  expect(() => new UsageLedger({ path: corrupt, totalBudget: 100 })).toThrow("invalid JSONL row 2")
})

test("blocks input context overflow, response double billing and unexplained greater-than-3x prompt jumps", () => {
  const ledger = new UsageLedger({ totalBudget: 1_000_000 })
  ledger.recordRaw({
    threadId: "root",
    turnId: "turn-1",
    responseId: "resp-1",
    provider: "gpt-cchp",
    model: "gpt-5.6-sol",
    inputTokens: 20_000,
    totalTokens: 40_000,
    contextWindow: 372_000,
  })
  ledger.recordRaw({
    threadId: "root",
    turnId: "turn-2",
    responseId: "resp-2",
    provider: "gpt-cchp",
    model: "gpt-5.6-sol",
    inputTokens: 60_001,
    totalTokens: 70_000,
    contextWindow: 372_000,
  })
  ledger.recordRaw({
    threadId: "child",
    turnId: "turn-3",
    responseId: "resp-2",
    provider: "gpt-cchp",
    model: "gpt-5.6-sol",
    inputTokens: 60_001,
    totalTokens: 70_000,
    contextWindow: 372_000,
  })
  ledger.recordRaw({
    threadId: "root",
    turnId: "turn-4",
    responseId: "resp-4",
    provider: "gpt-cchp",
    model: "gpt-5.6-sol",
    inputTokens: 400_000,
    outputTokens: 10,
    totalTokens: 400_010,
    contextWindow: 372_000,
    anomalyReason: "validated-large-context",
  })

  expect(ledger.anomalies.map((anomaly) => anomaly.type)).toEqual([
    "token_jump",
    "response_double_billing",
    "context_overflow",
  ])
  expect(ledger.hasBlockingAnomalies()).toBe(true)
})

test("does not treat output growth as prompt overflow or prompt jump", () => {
  const ledger = new UsageLedger({ totalBudget: 1_000_000 })
  ledger.recordRaw({
    threadId: "root",
    turnId: "turn-1",
    responseId: "resp-1",
    provider: "gpt-cchp",
    model: "gpt-5.6-sol",
    inputTokens: 20_000,
    outputTokens: 100,
    totalTokens: 20_100,
    contextWindow: 372_000,
  })
  ledger.recordRaw({
    threadId: "root",
    turnId: "turn-2",
    responseId: "resp-2",
    provider: "gpt-cchp",
    model: "gpt-5.6-sol",
    inputTokens: 20_000,
    outputTokens: 380_000,
    totalTokens: 400_000,
    contextWindow: 372_000,
  })

  expect(ledger.anomalies).toEqual([])
})

test("returns warning, throttled and exceeded states at fixed budget thresholds", () => {
  const ledger = new UsageLedger({ totalBudget: 1_000 })
  expect(ledger.recordRaw({ threadId: "a", turnId: "1", responseId: "r1", totalTokens: 699 }).state).toBe(
    "normal",
  )
  expect(ledger.recordRaw({ threadId: "a", turnId: "2", responseId: "r2", totalTokens: 1 }).state).toBe(
    "warning",
  )
  expect(ledger.recordRaw({ threadId: "a", turnId: "3", responseId: "r3", totalTokens: 150 }).state).toBe(
    "throttled",
  )
  expect(ledger.recordRaw({ threadId: "a", turnId: "4", responseId: "r4", totalTokens: 150 }).state).toBe(
    "exceeded",
  )
})

test("replay rejects parent-child lineage overlap without rebilling", () => {
  const path = join(mkdtempSync(join(tmpdir(), "usage-lineage-replay-")), "usage.jsonl")
  const recordedAt = new Date().toISOString()
  writeFileSync(path, [
    JSON.stringify({ kind: "raw_completion_usage", recordedAt, threadId: "root", turnId: "turn", responseId: "root-response", billingScopeId: "run", lineage: ["root"], totalTokens: 120 }),
    JSON.stringify({ kind: "raw_completion_usage", recordedAt, threadId: "child", turnId: "turn", responseId: "child-response", billingScopeId: "run", parentThreadId: "root", lineage: ["root", "child"], totalTokens: 120 }),
    "",
  ].join("\n"))
  const restored = new UsageLedger({ path, totalBudget: 1_000 })
  expect(restored.budget).toMatchObject({ consumed: 120, blockingAnomalies: 1 })
  expect(restored.rawCompletions.map((row) => row.responseId)).toEqual(["root-response"])
  expect(restored.anomalies.at(-1)?.type).toBe("lineage_billing_overlap")
})

test("rejects a same-response terminal report whose token breakdown changes", () => {
  const ledger = new UsageLedger({ totalBudget: 1_000 })
  ledger.recordRaw({
    threadId: "root",
    turnId: "turn",
    responseId: "response",
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  })
  expect(ledger.recordRaw({
    threadId: "root",
    turnId: "turn",
    responseId: "response",
    inputTokens: 9,
    outputTokens: 6,
    totalTokens: 15,
  })).toMatchObject({ acceptedRaw: false, consumed: 15, blockingAnomalies: 1 })
  expect(ledger.anomalies.at(-1)?.type).toBe("terminal_usage_changed")
})
