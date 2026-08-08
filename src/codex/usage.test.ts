import { expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { UsageLedger } from "./usage"

test("keeps cumulative snapshots and rejects a second terminal provider response for one Codex turn", () => {
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
  expect(ledger.recordRaw({ threadId: "thread_1", turnId: "turn_1", responseId: "resp_2", totalTokens: 150 })).toMatchObject({ acceptedRaw: false, consumed: 150, blockingAnomalies: 1 })
  expect(ledger.recordRaw({ threadId: "thread_1", turnId: "turn_1", responseId: "resp_2", totalTokens: 150 })).toMatchObject({ acceptedRaw: false, consumed: 150, blockingAnomalies: 1 })
  expect(ledger.rawCompletions).toHaveLength(1)
  expect(ledger.anomalies.map((anomaly) => anomaly.type)).toEqual(["turn_multiple_terminal_responses"])
})

test("replay rejects a second provider response for one turn without rebilling", () => {
  const path = join(mkdtempSync(join(tmpdir(), "usage-turn-replay-")), "usage.jsonl")
  const recordedAt = new Date().toISOString()
  writeFileSync(path, [
    JSON.stringify({ kind: "raw_completion_usage", recordedAt, threadId: "root", turnId: "turn", responseId: "first", totalTokens: 10 }),
    JSON.stringify({ kind: "raw_completion_usage", recordedAt, threadId: "root", turnId: "turn", responseId: "second", totalTokens: 99 }),
    "",
  ].join("\n"))

  const restored = new UsageLedger({ path, totalBudget: 1_000 })
  expect(restored.budget).toMatchObject({ consumed: 10, blockingAnomalies: 1 })
  expect(restored.rawCompletions.map((record) => record.responseId)).toEqual(["first"])
  expect(restored.anomalies.map((anomaly) => anomaly.type)).toEqual(["turn_multiple_terminal_responses"])
})

test("denies a projected response before the run can overshoot the admission threshold", () => {
  const ledger = new UsageLedger({ totalBudget: 1_000, admissionFraction: 0.85 })
  ledger.recordRaw({ threadId: "root", turnId: "turn-1", responseId: "first", provider: "p", model: "m", contextInputTokens: 350, totalTokens: 400, billingScopeId: "run" })
  const admitted = ledger.admitNextResponse({ billingScopeId: "run", threadId: "root", turnId: "turn-2", provider: "p", model: "m" })
  expect(admitted).toMatchObject({
    allowed: true,
    estimatedNextTokens: 400,
    responsesInTurn: 0,
    responsesInFlight: 1,
    reservedTokens: 400,
  })
  ledger.recordRaw({
    threadId: "root", turnId: "turn-2", responseId: "second", provider: "p", model: "m", contextInputTokens: 350,
    totalTokens: 400, billingScopeId: "run", reservationId: admitted.reservationId,
  })
  expect(ledger.admitNextResponse({ billingScopeId: "run", threadId: "root", turnId: "turn-3", provider: "p", model: "m" })).toMatchObject({
    allowed: false,
    reason: "projected_budget",
    consumed: 800,
    threshold: 850,
    estimatedNextTokens: 400,
    responsesInTurn: 0,
    responsesInFlight: 0,
    reservedTokens: 0,
  })
  expect(ledger.budget).toMatchObject({ responses: 2, turns: 2, admissionDenials: 1 })
})

test("reserves projected tokens and response slots across concurrent provider requests", () => {
  const ledger = new UsageLedger({ totalBudget: 1_000, admissionFraction: 0.85, maxResponsesPerTurn: 2 })
  ledger.recordRaw({ threadId: "other", turnId: "other-turn", responseId: "bulk", provider: "p", model: "large", totalTokens: 760, billingScopeId: "run" })
  ledger.recordRaw({ threadId: "root", turnId: "baseline-turn", responseId: "baseline", provider: "p", model: "m", totalTokens: 40, billingScopeId: "run" })

  const first = ledger.admitNextResponse({ billingScopeId: "run", threadId: "root", turnId: "turn", provider: "p", model: "m", contextWindow: 372_000 })
  expect(first).toMatchObject({ allowed: true, estimatedNextTokens: 40, responsesInFlight: 1, reservedTokens: 40 })
  expect(ledger.admitNextResponse({ billingScopeId: "run", threadId: "root", turnId: "turn", provider: "p", model: "m", contextWindow: 372_000 })).toMatchObject({
    allowed: false,
    reason: "projected_budget",
    responsesInTurn: 0,
    responsesInFlight: 1,
    reservedTokens: 40,
  })

  ledger.recordRaw({
    threadId: "root", turnId: "turn", responseId: "settled", provider: "p", model: "m",
    totalTokens: 40, billingScopeId: "run", reservationId: first.reservationId,
  })
  expect(ledger.admitNextResponse({ billingScopeId: "run", threadId: "root", turnId: "turn-2", provider: "p", model: "m", contextWindow: 372_000 })).toMatchObject({
    allowed: false,
    reason: "projected_budget",
    responsesInFlight: 0,
    reservedTokens: 0,
  })
})

test("releases failed reservations and restores unresolved reservations after replay", () => {
  const path = join(mkdtempSync(join(tmpdir(), "usage-reservation-replay-")), "usage.jsonl")
  const first = new UsageLedger({ path, totalBudget: 1_000, admissionFraction: 0.85 })
  const failed = first.admitNextResponse({ billingScopeId: "run", threadId: "root", turnId: "turn-failed", contextWindow: 100 })
  expect(failed.allowed).toBe(true)
  expect(first.releaseReservation(failed.reservationId!, "upstream_502")).toBe(true)
  const healthy = first.admitNextResponse({ billingScopeId: "run", threadId: "root", turnId: "turn-healthy", contextWindow: 100 })
  expect(healthy).toMatchObject({ allowed: true, reservedTokens: 100 })
  first.releaseReservation(healthy.reservationId!, "test_cleanup")

  const unresolved = first.admitNextResponse({ billingScopeId: "run", threadId: "root", turnId: "turn-unresolved", contextWindow: 800 })
  expect(unresolved.allowed).toBe(true)

  const restored = new UsageLedger({ path, totalBudget: 1_000, admissionFraction: 0.85 })
  expect(restored.admitNextResponse({ billingScopeId: "run", threadId: "root", turnId: "turn-after-restart", contextWindow: 100 })).toMatchObject({
    allowed: false,
    reason: "projected_budget",
    reservedTokens: 800,
  })
})

test("uses the requested model context for cold starts and model switches", () => {
  const cold = new UsageLedger({ totalBudget: 1_000, admissionFraction: 0.85 })
  expect(cold.admitNextResponse({
    billingScopeId: "run", threadId: "root", turnId: "turn", provider: "p", model: "large", contextWindow: 372_000,
  })).toMatchObject({ allowed: false, reason: "projected_budget", estimatedNextTokens: 372_000 })

  const switched = new UsageLedger({ totalBudget: 1_000, admissionFraction: 0.85 })
  switched.recordRaw({ threadId: "root", turnId: "turn-1", responseId: "small", provider: "p", model: "small", totalTokens: 100, billingScopeId: "run" })
  expect(switched.admitNextResponse({
    billingScopeId: "run", threadId: "root", turnId: "turn-2", provider: "p", model: "large", contextWindow: 800,
  })).toMatchObject({ allowed: false, reason: "projected_budget", estimatedNextTokens: 800 })
})

test("blocks sequential response loops per turn even when individual responses are small", () => {
  const ledger = new UsageLedger({ totalBudget: 10_000, maxResponsesPerTurn: 2 })
  ledger.recordRaw({ threadId: "root", turnId: "turn", responseId: "first", totalTokens: 10, billingScopeId: "run" })
  expect(ledger.recordRaw({ threadId: "root", turnId: "turn", responseId: "second", totalTokens: 10, billingScopeId: "run" }))
    .toMatchObject({ acceptedRaw: false, consumed: 10, blockingAnomalies: 1, responses: 1 })
  expect(ledger.anomalies.at(-1)?.type).toBe("turn_multiple_terminal_responses")
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
