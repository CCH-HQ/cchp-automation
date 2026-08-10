import { expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { UsageLedger } from "./usage"

test("keeps cumulative snapshots and bills unique provider responses in one Codex tool-loop turn", () => {
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
  expect(ledger.anomalies).toEqual([])
  expect(ledger.budget).toMatchObject({
    inputTokens: 0,
    contextInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    maxResponseTokens: 150,
    maxContextInputTokens: 0,
  })
})

test("projects bounded numeric usage aggregates without raw response content", () => {
  const ledger = new UsageLedger({ totalBudget: 10_000 })
  ledger.recordRaw({
    threadId: "root", turnId: "turn", responseId: "first", totalTokens: 160,
    inputTokens: 100, contextInputTokens: 120, cachedInputTokens: 40,
    outputTokens: 60, reasoningOutputTokens: 20,
  })
  ledger.recordRaw({
    threadId: "root", turnId: "turn", responseId: "second", totalTokens: 250,
    inputTokens: 150, contextInputTokens: 200, cachedInputTokens: 50,
    outputTokens: 100, reasoningOutputTokens: 30,
  })
  expect(ledger.budget).toMatchObject({
    inputTokens: 250,
    contextInputTokens: 320,
    cachedInputTokens: 90,
    outputTokens: 160,
    reasoningOutputTokens: 50,
    maxResponseTokens: 250,
    maxContextInputTokens: 200,
  })
})

test("replay restores multiple unique provider responses for one turn", () => {
  const path = join(mkdtempSync(join(tmpdir(), "usage-turn-replay-")), "usage.jsonl")
  const recordedAt = new Date().toISOString()
  writeFileSync(path, [
    JSON.stringify({ kind: "raw_completion_usage", recordedAt, threadId: "root", turnId: "turn", responseId: "first", totalTokens: 10 }),
    JSON.stringify({ kind: "raw_completion_usage", recordedAt, threadId: "root", turnId: "turn", responseId: "second", totalTokens: 99 }),
    "",
  ].join("\n"))

  const restored = new UsageLedger({ path, totalBudget: 1_000 })
  expect(restored.budget).toMatchObject({ consumed: 109, blockingAnomalies: 0, responses: 2, turns: 1 })
  expect(restored.rawCompletions.map((record) => record.responseId)).toEqual(["first", "second"])
  expect(restored.anomalies).toEqual([])
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
    totalTokens: 400, billingScopeId: "run", reservation: admitted.reservation,
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

test("reserves projected tokens across concurrent provider requests", () => {
  const ledger = new UsageLedger({ totalBudget: 1_000, admissionFraction: 0.85 })
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
    totalTokens: 40, billingScopeId: "run", reservation: first.reservation,
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
  expect(first.releaseReservation(failed.reservation!, "upstream_502")).toBe(true)
  const healthy = first.admitNextResponse({ billingScopeId: "run", threadId: "root", turnId: "turn-healthy", contextWindow: 100 })
  expect(healthy).toMatchObject({ allowed: true, reservedTokens: 100 })
  first.releaseReservation(healthy.reservation!, "test_cleanup")

  const unresolved = first.admitNextResponse({ billingScopeId: "run", threadId: "root", turnId: "turn-unresolved", contextWindow: 800 })
  expect(unresolved.allowed).toBe(true)

  const restored = new UsageLedger({ path, totalBudget: 1_000, admissionFraction: 0.85 })
  expect(restored.admitNextResponse({ billingScopeId: "run", threadId: "root", turnId: "turn-after-restart", contextWindow: 100 })).toMatchObject({
    allowed: false,
    reason: "projected_budget",
    reservedTokens: 800,
  })
})

test("charges the reservation estimate when provider usage is unavailable", () => {
  const ledger = new UsageLedger({ totalBudget: 1_000, admissionFraction: 0.85 })
  const admission = ledger.admitNextResponse({
    billingScopeId: "run", threadId: "root", turnId: "turn", contextWindow: 400,
  })
  expect(admission.allowed).toBe(true)
  expect(ledger.chargeReservationEstimate(admission.reservation!, "missing_usage")).toBe(true)
  expect(ledger.budget).toMatchObject({ consumed: 400, reservedTokens: 0, responsesInFlight: 0 })
  expect(ledger.releaseReservation(admission.reservation!, "late_release")).toBe(false)
})

test("recovers stale-generation reservations as conservative charges without leaving them in flight", () => {
  const path = join(mkdtempSync(join(tmpdir(), "usage-reservation-generation-")), "usage.jsonl")
  const first = new UsageLedger({
    path,
    totalBudget: 1_000,
    admissionFraction: 0.85,
    writerFence: { writerId: "writer", generation: 1 },
  })
  const stale = first.admitNextResponse({
    billingScopeId: "run",
    threadId: "root",
    turnId: "turn-before-crash",
    contextWindow: 400,
  })
  expect(stale).toMatchObject({ allowed: true, responsesInFlight: 1, reservedTokens: 400 })

  const resumed = new UsageLedger({
    path,
    totalBudget: 1_000,
    admissionFraction: 0.85,
    writerFence: { writerId: "writer", generation: 2 },
  })
  const current = resumed.admitNextResponse({
    billingScopeId: "run",
    threadId: "root",
    turnId: "turn-after-restart",
    contextWindow: 100,
  })
  expect(current).toMatchObject({
    allowed: true,
    consumed: 400,
    responsesInFlight: 1,
    reservedTokens: 100,
  })
  expect(resumed.releaseReservation(stale.reservation!, "stale_callback")).toBe(false)
  expect(resumed.releaseReservation(current.reservation!, "current_complete")).toBe(true)

  expect(resumed.recordRaw({
    threadId: "root",
    turnId: "turn-before-crash",
    responseId: "late-terminal",
    totalTokens: 250,
    billingScopeId: "run",
    reservation: stale.reservation,
  })).toMatchObject({ acceptedRaw: true, consumed: 250 })
  expect(readFileSync(path, "utf8")).toContain('"kind":"reservation_recovered"')
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

test("prefers a request-derived estimate over the model context window", () => {
  const ledger = new UsageLedger({ totalBudget: 2_000_000, admissionFraction: 0.85 })
  expect(ledger.admitNextResponse({
    billingScopeId: "run",
    threadId: "root",
    turnId: "turn",
    provider: "p",
    model: "m",
    contextWindow: 372_000,
    estimatedTokens: 48_000,
  })).toMatchObject({
    allowed: true,
    estimatedNextTokens: 48_000,
    reservedTokens: 48_000,
  })
})

test("short read-only conservative prompt bound preserves the 384k hard cap", () => {
  const ledger = new UsageLedger({
    totalBudget: 384_000,
    admissionFraction: 0.85,
    maxResponsesPerTurn: 6,
  })
  for (const [index, totalTokens] of [42_327, 40_000, 40_000, 39_503].entries()) {
    ledger.recordRaw({
      threadId: "root",
      turnId: "turn",
      responseId: `response-${index}`,
      provider: "p",
      model: "m",
      totalTokens,
      billingScopeId: "run",
    })
  }

  // 生产 run 31342358138 在此处已计费 161,830 tokens. 将单次 output 从
  // 131,072 限制为 8,192 后, 再以 prompt UTF-8 bytes 作为 token 上界.
  // 即使 provider 的实际 tokenizer 比平均 3 bytes/token 更密, 请求也不会
  // 在不可撤销的 dispatch 后才发现它突破了 384k ceiling.
  const fifth = ledger.admitNextResponse({
    billingScopeId: "run",
    threadId: "root",
    turnId: "turn",
    provider: "p",
    model: "m",
    estimatedTokens: 185_882,
  })
  expect(fifth).toMatchObject({
    allowed: false,
    reason: "projected_budget",
    consumed: 161_830,
    threshold: 326_400,
    estimatedNextTokens: 185_882,
    responsesInTurn: 4,
  })
})

test("does not repeat the 31322123553 whole-context reservation failure", () => {
  const ledger = new UsageLedger({ totalBudget: 2_000_000, admissionFraction: 0.85 })
  ledger.recordRaw({
    threadId: "root", turnId: "completed-turn", responseId: "completed-response",
    provider: "p", model: "m", totalTokens: 319_426, billingScopeId: "run",
  })

  for (let index = 0; index < 4; index++) {
    expect(ledger.admitNextResponse({
      billingScopeId: "run",
      threadId: "root",
      turnId: `concurrent-${index}`,
      provider: "p",
      model: "m",
      contextWindow: 372_000,
      estimatedTokens: 132_000,
    })).toMatchObject({
      allowed: true,
      estimatedNextTokens: 132_000,
      responsesInFlight: 1,
      reservedTokens: 132_000 * (index + 1),
    })
  }
})

test("allows more than sixteen Responses API calls within one Codex turn", () => {
  const ledger = new UsageLedger({ totalBudget: 10_000 })
  for (let index = 0; index < 32; index++) {
    expect(ledger.recordRaw({
      threadId: "root", turnId: "turn", responseId: `response-${index}`,
      totalTokens: 10, billingScopeId: "run",
    })).toMatchObject({
      acceptedRaw: true,
      consumed: (index + 1) * 10,
      blockingAnomalies: 0,
      responses: index + 1,
      turns: 1,
    })
  }
})

test("denies responses after the configured per-turn limit", () => {
  const ledger = new UsageLedger({ totalBudget: 1_000_000, maxResponsesPerTurn: 2 })
  ledger.recordRaw({
    threadId: "root", turnId: "turn", responseId: "first", totalTokens: 10, billingScopeId: "run",
  })
  const second = ledger.admitNextResponse({
    billingScopeId: "run", threadId: "root", turnId: "turn", estimatedTokens: 10,
  })
  expect(second).toMatchObject({ allowed: true, responsesInTurn: 1, responsesInFlight: 1 })
  expect(ledger.admitNextResponse({
    billingScopeId: "run", threadId: "root", turnId: "turn", estimatedTokens: 10,
  })).toMatchObject({
    allowed: false,
    reason: "response_limit",
    responsesInTurn: 1,
    responsesInFlight: 1,
  })
  expect(ledger.budget).toMatchObject({ responseLimit: 2, admissionDenials: 1 })
  ledger.releaseReservation(second.reservation!, "test_cleanup")
})

test("recovered reservations continue occupying response slots after restart", () => {
  const path = join(mkdtempSync(join(tmpdir(), "usage-response-limit-restart-")), "usage.jsonl")
  const first = new UsageLedger({
    path,
    totalBudget: 1_000_000,
    maxResponsesPerTurn: 2,
    writerFence: { writerId: "writer", generation: 1 },
  })
  for (let index = 0; index < 2; index++) {
    expect(first.admitNextResponse({
      billingScopeId: "run", threadId: "root", turnId: "turn", estimatedTokens: 10,
    }).allowed).toBe(true)
  }

  const resumed = new UsageLedger({
    path,
    totalBudget: 1_000_000,
    maxResponsesPerTurn: 2,
    writerFence: { writerId: "writer", generation: 2 },
  })
  expect(resumed.admitNextResponse({
    billingScopeId: "run", threadId: "root", turnId: "turn", estimatedTokens: 10,
  })).toMatchObject({
    allowed: false,
    reason: "response_limit",
    responsesInTurn: 0,
    responsesInFlight: 0,
  })
})

test("uses run-wide provider history when a child thread has no local usage", () => {
  const ledger = new UsageLedger({ totalBudget: 2_000_000, admissionFraction: 0.85 })
  ledger.recordRaw({
    threadId: "root", turnId: "root-turn", responseId: "root-response", provider: "p", model: "m",
    contextInputTokens: 90_000, totalTokens: 100_000, billingScopeId: "run",
  })

  expect(ledger.admitNextResponse({
    billingScopeId: "run", threadId: "child", turnId: "child-turn", provider: "p", model: "m", contextWindow: 372_000,
  })).toMatchObject({
    allowed: true,
    estimatedNextTokens: 100_000,
    reservedTokens: 100_000,
  })
  ledger.recordRaw({
    threadId: "child", turnId: "child-turn", responseId: "child-response", provider: "p", model: "m",
    contextInputTokens: 310_000, totalTokens: 320_000, contextWindow: 372_000, billingScopeId: "run",
  })
  expect(ledger.anomalies.map((anomaly) => anomaly.type)).not.toContain("token_jump")
})

test("reindexes raw-first usage after provider enrichment for admission and prompt jumps", () => {
  const ledger = new UsageLedger({ totalBudget: 2_000_000, admissionFraction: 0.85 })
  const raw = {
    threadId: "root",
    turnId: "root-turn",
    responseId: "root-response",
    contextInputTokens: 20_000,
    totalTokens: 25_000,
    billingScopeId: "run",
  }
  ledger.recordRaw(raw)
  ledger.recordRaw({ ...raw, provider: "p", model: "m" })

  const admission = ledger.admitNextResponse({
    billingScopeId: "run",
    threadId: "child",
    turnId: "child-turn",
    provider: "p",
    model: "m",
    contextWindow: 372_000,
  })
  expect(admission).toMatchObject({ allowed: true, estimatedNextTokens: 25_000 })
  ledger.releaseReservation(admission.reservation!, "test_cleanup")

  ledger.recordRaw({
    threadId: "root",
    turnId: "root-turn-2",
    responseId: "root-response-2",
    provider: "p",
    model: "m",
    contextInputTokens: 60_001,
    totalTokens: 65_000,
    billingScopeId: "run",
  })
  expect(ledger.anomalies.map((anomaly) => anomaly.type)).toContain("token_jump")
})

test("compares late-enriched usage only with its chronological model predecessor", () => {
  const forward = new UsageLedger({ totalBudget: 2_000_000 })
  forward.recordRaw({
    threadId: "root", turnId: "turn-1", responseId: "known", provider: "p", model: "m",
    contextInputTokens: 20_000, totalTokens: 25_000,
  })
  const late = {
    threadId: "root", turnId: "turn-2", responseId: "late",
    contextInputTokens: 70_000, totalTokens: 75_000,
  }
  forward.recordRaw(late)
  forward.recordRaw({ ...late, provider: "p", model: "m" })
  expect(forward.anomalies.map((anomaly) => anomaly.type)).toContain("token_jump")

  const backward = new UsageLedger({ totalBudget: 2_000_000 })
  const early = {
    threadId: "root", turnId: "turn-1", responseId: "early",
    contextInputTokens: 70_000, totalTokens: 75_000,
  }
  backward.recordRaw(early)
  backward.recordRaw({
    threadId: "root", turnId: "turn-2", responseId: "later", provider: "p", model: "m",
    contextInputTokens: 20_000, totalTokens: 25_000,
  })
  backward.recordRaw({ ...early, provider: "p", model: "m" })
  expect(backward.anomalies.map((anomaly) => anomaly.type)).not.toContain("token_jump")
})

test("rebuilds successor prompt-jump state when an earlier record is enriched", () => {
  const introduced = new UsageLedger({ totalBudget: 2_000_000 })
  const early = {
    threadId: "root", turnId: "turn-1", responseId: "early",
    contextInputTokens: 20_000, totalTokens: 25_000, billingScopeId: "run",
  }
  introduced.recordRaw(early)
  introduced.recordRaw({
    threadId: "root", turnId: "turn-2", responseId: "later", provider: "p", model: "m",
    contextInputTokens: 70_000, totalTokens: 75_000, billingScopeId: "run",
  })
  introduced.recordRaw({ ...early, provider: "p", model: "m" })
  expect(introduced.anomalies.map((anomaly) => anomaly.type)).toEqual(["token_jump"])

  const invalidated = new UsageLedger({ totalBudget: 2_000_000 })
  invalidated.recordRaw({
    threadId: "root", turnId: "turn-1", responseId: "first", provider: "p", model: "m",
    contextInputTokens: 20_000, totalTokens: 25_000, billingScopeId: "run",
  })
  const middle = {
    threadId: "root", turnId: "turn-2", responseId: "middle",
    contextInputTokens: 30_000, totalTokens: 35_000, billingScopeId: "run",
  }
  invalidated.recordRaw(middle)
  invalidated.recordRaw({
    threadId: "root", turnId: "turn-3", responseId: "last", provider: "p", model: "m",
    contextInputTokens: 70_000, totalTokens: 75_000, billingScopeId: "run",
  })
  expect(invalidated.anomalies.map((anomaly) => anomaly.type)).toEqual(["token_jump"])
  invalidated.recordRaw({ ...middle, provider: "p", model: "m" })
  expect(invalidated.anomalies.map((anomaly) => anomaly.type)).toEqual([])
})

test("replays a live late-enrichment ledger with identical derived anomalies", () => {
  const path = join(mkdtempSync(join(tmpdir(), "usage-live-enrichment-replay-")), "usage.jsonl")
  const live = new UsageLedger({ path, totalBudget: 2_000_000 })
  live.recordRaw({
    threadId: "root", turnId: "turn-1", responseId: "early", provider: "p", model: "m",
    contextInputTokens: 20_000, totalTokens: 25_000, billingScopeId: "run",
  })
  const late = {
    threadId: "root", turnId: "turn-2", responseId: "late",
    contextInputTokens: 70_000, totalTokens: 75_000, billingScopeId: "run",
  }
  live.recordRaw(late)
  live.recordRaw({ ...late, provider: "p", model: "m" })
  const restored = new UsageLedger({ path, totalBudget: 2_000_000 })
  expect(live.anomalies).toHaveLength(1)
  expect(restored.anomalies).toEqual(live.anomalies)
  expect(restored.budget.blockingAnomalies).toBe(1)
})

test("replays chronological late-enrichment token jumps without comparing older records to the future", () => {
  const directory = mkdtempSync(join(tmpdir(), "usage-enrichment-order-replay-"))
  const recordedAt = new Date().toISOString()
  const raw = (value: Record<string, unknown>) => JSON.stringify({
    kind: "raw_completion_usage",
    recordedAt,
    ...value,
  })

  const forwardPath = join(directory, "forward.jsonl")
  writeFileSync(forwardPath, [
    raw({ threadId: "root", turnId: "turn-1", responseId: "known", provider: "p", model: "m", contextInputTokens: 20_000, totalTokens: 25_000 }),
    raw({ threadId: "root", turnId: "turn-2", responseId: "late", contextInputTokens: 70_000, totalTokens: 75_000 }),
    raw({ threadId: "root", turnId: "turn-2", responseId: "late", provider: "p", model: "m", contextInputTokens: 70_000, totalTokens: 75_000 }),
  ].join("\n") + "\n")
  expect(new UsageLedger({ path: forwardPath, totalBudget: 2_000_000 }).anomalies.map((anomaly) => anomaly.type))
    .toContain("token_jump")

  const backwardPath = join(directory, "backward.jsonl")
  writeFileSync(backwardPath, [
    raw({ threadId: "root", turnId: "turn-1", responseId: "early", contextInputTokens: 70_000, totalTokens: 75_000 }),
    raw({ threadId: "root", turnId: "turn-2", responseId: "later", provider: "p", model: "m", contextInputTokens: 20_000, totalTokens: 25_000 }),
    raw({ threadId: "root", turnId: "turn-1", responseId: "early", provider: "p", model: "m", contextInputTokens: 70_000, totalTokens: 75_000 }),
  ].join("\n") + "\n")
  expect(new UsageLedger({ path: backwardPath, totalBudget: 2_000_000 }).anomalies.map((anomaly) => anomaly.type))
    .not.toContain("token_jump")
})

test("rebuilds enriched model indexes while replaying raw-first usage", () => {
  const path = join(mkdtempSync(join(tmpdir(), "usage-enrichment-replay-")), "usage.jsonl")
  const recordedAt = new Date().toISOString()
  const raw = {
    kind: "raw_completion_usage",
    recordedAt,
    threadId: "root",
    turnId: "root-turn",
    responseId: "root-response",
    contextInputTokens: 20_000,
    totalTokens: 25_000,
    billingScopeId: "run",
  }
  writeFileSync(path, `${JSON.stringify(raw)}\n${JSON.stringify({ ...raw, provider: "p", model: "m" })}\n`)

  const restored = new UsageLedger({ path, totalBudget: 2_000_000, admissionFraction: 0.85 })
  const admission = restored.admitNextResponse({
    billingScopeId: "run",
    threadId: "child",
    turnId: "child-turn",
    provider: "p",
    model: "m",
    contextWindow: 372_000,
  })
  expect(admission).toMatchObject({ allowed: true, estimatedNextTokens: 25_000 })
  restored.releaseReservation(admission.reservation!, "test_cleanup")
  restored.recordRaw({
    threadId: "root",
    turnId: "root-turn-2",
    responseId: "root-response-2",
    provider: "p",
    model: "m",
    contextInputTokens: 60_001,
    totalTokens: 65_000,
    billingScopeId: "run",
  })
  expect(restored.anomalies.map((anomaly) => anomaly.type)).toContain("token_jump")
})

test("detects context overflow when a smaller context window arrives during late enrichment", () => {
  const ledger = new UsageLedger({ totalBudget: 1_000_000 })
  const raw = {
    threadId: "root",
    turnId: "turn",
    responseId: "response",
    contextInputTokens: 60_000,
    totalTokens: 65_000,
    source: "app-server:rawResponse/completed",
  }
  ledger.recordRaw(raw)
  expect(ledger.recordRaw({
    ...raw,
    provider: "provider",
    model: "model",
    contextWindow: 32_000,
    source: "provider-bridge:response.completed",
  })).toMatchObject({ acceptedRaw: false, consumed: 65_000, blockingAnomalies: 1 })
  expect(ledger.rawCompletions[0]).toMatchObject({ provider: "provider", model: "model", contextWindow: 32_000 })
  expect(ledger.anomalies).toMatchObject([{ type: "context_overflow", responseId: "response" }])
})

test("replays late context-window enrichment with the same blocking overflow", () => {
  const path = join(mkdtempSync(join(tmpdir(), "usage-late-window-replay-")), "usage.jsonl")
  const recordedAt = new Date().toISOString()
  const raw = {
    kind: "raw_completion_usage",
    recordedAt,
    threadId: "root",
    turnId: "turn",
    responseId: "response",
    contextInputTokens: 60_000,
    totalTokens: 65_000,
    source: "app-server:rawResponse/completed",
  }
  writeFileSync(path, `${JSON.stringify(raw)}\n${JSON.stringify({
    ...raw,
    provider: "provider",
    model: "model",
    contextWindow: 32_000,
    source: "provider-bridge:response.completed",
  })}\n`)

  const restored = new UsageLedger({ path, totalBudget: 1_000_000 })
  expect(restored.budget).toMatchObject({ consumed: 65_000, responses: 1, blockingAnomalies: 1 })
  expect(restored.anomalies).toMatchObject([{ type: "context_overflow", responseId: "response" }])
})

test("fails closed on non-empty usage metadata drift in live and replay paths", () => {
  const fields = [
    ["provider", "provider-a", "provider-b"],
    ["model", "model-a", "model-b"],
    ["contextWindow", 64_000, 32_000],
    ["source", "source-a", "source-b"],
  ] as const
  for (const [field, first, second] of fields) {
    const base = { threadId: "root", turnId: "turn", responseId: "response", totalTokens: 10 }
    const ledger = new UsageLedger({ totalBudget: 1_000 })
    ledger.recordRaw({ ...base, [field]: first })
    expect(ledger.recordRaw({ ...base, [field]: second })).toMatchObject({ acceptedRaw: false, consumed: 10, blockingAnomalies: 1 })
    expect(ledger.anomalies).toMatchObject([{ type: "usage_metadata_conflict" }])

    const path = join(mkdtempSync(join(tmpdir(), `usage-${field}-drift-replay-`)), "usage.jsonl")
    const recordedAt = new Date().toISOString()
    const row = { kind: "raw_completion_usage", recordedAt, ...base }
    writeFileSync(path, `${JSON.stringify({ ...row, [field]: first })}\n${JSON.stringify({ ...row, [field]: second })}\n`)
    expect(() => new UsageLedger({ path, totalBudget: 1_000 })).toThrow("conflicting usage metadata replay")
  }
})

test("ignores the deprecated multi-terminal-response anomaly during replay", () => {
  const path = join(mkdtempSync(join(tmpdir(), "usage-legacy-anomaly-")), "usage.jsonl")
  const recordedAt = new Date().toISOString()
  writeFileSync(path, `${JSON.stringify({
    kind: "token_anomaly",
    id: "turn_multiple_terminal_responses:response:1",
    type: "turn_multiple_terminal_responses",
    blocking: true,
    responseId: "response",
    threadId: "root",
    turnId: "turn",
    message: "legacy false positive",
    recordedAt,
  })}\n`)

  const restored = new UsageLedger({ path, totalBudget: 1_000 })
  expect(restored.anomalies).toEqual([])
  expect(restored.budget).toMatchObject({ blockingAnomalies: 0, consumed: 0 })
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

  expect(ledger.anomalies.map((anomaly) => anomaly.type).sort()).toEqual([
    "context_overflow",
    "response_double_billing",
    "token_jump",
  ])
  expect(ledger.hasBlockingAnomalies()).toBe(true)
})

test("keeps token jumps provisional until provider and model identity is enriched", () => {
  const ledger = new UsageLedger({ totalBudget: 2_000_000 })
  ledger.recordRaw({ threadId: "root", turnId: "turn-1", responseId: "first", contextInputTokens: 20_000, totalTokens: 20_000 })
  const provisional = ledger.recordRaw({ threadId: "root", turnId: "turn-2", responseId: "second", contextInputTokens: 70_000, totalTokens: 70_000 })
  expect(provisional.blockingAnomalies).toBe(0)
  expect(ledger.hasProvisionalTokenJump()).toBe(true)
  expect(ledger.recordRaw({
    threadId: "root", turnId: "turn-2", responseId: "second", provider: "p", model: "m",
    contextInputTokens: 70_000, totalTokens: 70_000,
  })).toMatchObject({ blockingAnomalies: 0 })
  expect(ledger.hasProvisionalTokenJump()).toBe(true)
  expect(ledger.anomalies.find((anomaly) => anomaly.type === "token_jump")).toMatchObject({
    baselineResponseId: "first",
    responseId: "second",
    blocking: false,
  })
  expect(ledger.recordRaw({
    threadId: "root", turnId: "turn-1", responseId: "first", provider: "p", model: "m",
    contextInputTokens: 20_000, totalTokens: 20_000,
  })).toMatchObject({ blockingAnomalies: 1 })
  expect(ledger.hasProvisionalTokenJump()).toBe(false)
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
