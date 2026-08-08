import { randomUUID } from "node:crypto"
import { appendJsonl, readJsonl } from "./jsonl"

export type TokenBudgetState = "normal" | "warning" | "throttled" | "exceeded"

export interface TokenBreakdown {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export interface CodexUsageUpdate {
  threadId: string
  turnId: string
  tokenUsage: {
    total: TokenBreakdown
    last: TokenBreakdown
    modelContextWindow: number | null
  }
}

export interface RawUsageInput {
  threadId: string
  turnId: string
  responseId: string
  parentThreadId?: string
  provider?: string
  model?: string
  inputTokens?: number
  contextInputTokens?: number
  billableInputTokens?: number
  billingScopeId?: string
  lineage?: string[]
  cachedInputTokens?: number
  cacheWriteInputTokens?: number
  outputTokens?: number
  reasoningOutputTokens?: number
  totalTokens: number
  contextWindow?: number
  anomalyReason?: string
  source?: string
  reservationId?: string
}

export interface RawUsageRecord extends RawUsageInput {
  kind: "raw_completion_usage"
  recordedAt: string
}

export interface UsageResult {
  acceptedRaw: boolean
  consumed: number
  limit: number
  fraction: number
  state: TokenBudgetState
  blockingAnomalies: number
  responses: number
  turns: number
  admissionDenials: number
}

export interface UsageAdmission {
  allowed: boolean
  reason?: "budget_threshold" | "projected_budget" | "response_limit"
  consumed: number
  limit: number
  threshold: number
  estimatedNextTokens: number
  responsesInTurn: number
  responsesInFlight: number
  reservedTokens: number
  reservationId?: string
}

export type TokenAnomalyType =
  | "terminal_usage_changed"
  | "turn_multiple_terminal_responses"
  | "response_double_billing"
  | "billing_scope_double_billing"
  | "invalid_usage_lineage"
  | "lineage_billing_overlap"
  | "context_overflow"
  | "token_jump"

export interface TokenAnomaly {
  id: string
  type: TokenAnomalyType
  blocking: boolean
  responseId: string
  threadId: string
  turnId: string
  message: string
  recordedAt: string
}

export interface UsageLedgerOptions {
  path?: string
  totalBudget: number
  assertWriterOwnership?: () => void
  admissionFraction?: number
  maxResponsesPerTurn?: number
}

interface UsageReservation {
  id: string
  scopedTurn: string
  provider?: string
  model?: string
  estimatedTokens: number
  recordedAt: string
}

function finiteToken(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function sameTerminalUsage(left: RawUsageRecord, right: RawUsageRecord): boolean {
  return [
    "inputTokens",
    "contextInputTokens",
    "billableInputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
  ].every((field) => left[field as keyof RawUsageRecord] === right[field as keyof RawUsageRecord])
}

export class UsageLedger {
  readonly rawCompletions: RawUsageRecord[] = []
  readonly cumulative = new Map<string, TokenBreakdown>()
  readonly anomalies: TokenAnomaly[] = []
  private readonly rawKeys = new Map<string, RawUsageRecord>()
  private readonly responseOwners = new Map<string, string>()
  private readonly responseRecords = new Map<string, RawUsageRecord>()
  private readonly recordsByScopedTurn = new Map<string, RawUsageRecord[]>()
  private readonly previousByModel = new Map<string, RawUsageRecord>()
  private readonly reservations = new Map<string, UsageReservation>()
  private readonly anomalyIds = new Set<string>()
  private readonly anomalyKeys = new Set<string>()
  private consumed = 0
  private admissionDenials = 0

  constructor(private readonly options: UsageLedgerOptions) {
    if (!Number.isSafeInteger(options.totalBudget) || options.totalBudget <= 0) {
      throw new Error("total token budget must be a positive integer")
    }
    if (options.admissionFraction !== undefined && (!Number.isFinite(options.admissionFraction) || options.admissionFraction <= 0 || options.admissionFraction > 1)) {
      throw new Error("token admission fraction must be within (0, 1]")
    }
    if (options.maxResponsesPerTurn !== undefined && (!Number.isSafeInteger(options.maxResponsesPerTurn) || options.maxResponsesPerTurn <= 0)) {
      throw new Error("max responses per turn must be a positive integer")
    }
    if (options.path) for (const row of readJsonl(options.path)) this.replay(row)
  }

  recordCodexUpdate(update: CodexUsageUpdate): UsageResult {
    const total = this.breakdown(update.tokenUsage.total)
    const previous = this.cumulative.get(update.threadId)
    if (previous && JSON.stringify(previous) === JSON.stringify(total)) return this.result(false)
    this.cumulative.set(update.threadId, total)
    this.append({
      kind: "thread_cumulative_usage",
      recordedAt: new Date().toISOString(),
      threadId: update.threadId,
      turnId: update.turnId,
      modelContextWindow: finiteToken(update.tokenUsage.modelContextWindow),
      ...total,
    })
    return this.result(false)
  }

  recordRaw(input: RawUsageInput): UsageResult {
    const normalized: RawUsageRecord = {
      ...input,
      kind: "raw_completion_usage",
      recordedAt: new Date().toISOString(),
      inputTokens: finiteToken(input.inputTokens),
      contextInputTokens: finiteToken(input.contextInputTokens ?? input.inputTokens),
      billableInputTokens: finiteToken(input.billableInputTokens ?? input.inputTokens),
      cachedInputTokens: finiteToken(input.cachedInputTokens),
      cacheWriteInputTokens: finiteToken(input.cacheWriteInputTokens),
      outputTokens: finiteToken(input.outputTokens),
      reasoningOutputTokens: finiteToken(input.reasoningOutputTokens),
      totalTokens: finiteToken(input.totalTokens),
    }
    const scope = normalized.billingScopeId ?? normalized.threadId
    const key = `${scope}\0${input.threadId}\0${input.turnId}\0${input.responseId}`
    const previous = this.rawKeys.get(key)
    if (previous) {
      if (!sameTerminalUsage(previous, normalized)) {
        this.addAnomaly("terminal_usage_changed", normalized, `terminal usage changed for response ${normalized.responseId}`)
      } else {
        if (this.enrichRecord(previous, normalized)) this.append(previous)
      }
      if (input.reservationId) this.releaseReservation(input.reservationId, "duplicate_usage")
      return this.result(false)
    }
    if (normalized.lineage !== undefined && !this.validLineage(normalized)) {
      this.addAnomaly("invalid_usage_lineage", normalized, "usage lineage does not terminate at the billed thread or parent")
      if (input.reservationId) this.releaseReservation(input.reservationId, "invalid_lineage")
      return this.result(false)
    }
    const scopedTurn = `${scope}\0${normalized.turnId}`
    const priorTurnRecords = this.recordsByScopedTurn.get(scopedTurn) ?? []
    const turnOverlap = priorTurnRecords.find((record) =>
      record.threadId !== normalized.threadId && this.isLineageOverlap(record, normalized),
    )
    if (turnOverlap) {
      this.addAnomaly(
        "lineage_billing_overlap",
        normalized,
        `turn ${normalized.turnId} was already billed to overlapping lineage ${turnOverlap.lineage?.join("/") ?? turnOverlap.threadId}`,
      )
      if (input.reservationId) this.releaseReservation(input.reservationId, "lineage_overlap")
      return this.result(false)
    }
    const responseOwner = this.responseOwners.get(input.responseId)
    if (responseOwner && responseOwner !== key) {
      const previousRecord = this.responseRecords.get(input.responseId)
      const previousScope = previousRecord?.billingScopeId ?? previousRecord?.threadId
      const currentScope = normalized.billingScopeId ?? normalized.threadId
      const anomalyType = previousRecord && previousScope === currentScope && this.isLineageOverlap(previousRecord, normalized)
        ? "lineage_billing_overlap"
        : previousRecord?.billingScopeId && normalized.billingScopeId && previousScope !== currentScope
          ? "billing_scope_double_billing"
          : "response_double_billing"
      this.addAnomaly(anomalyType, normalized, `response ${input.responseId} was already billed to ${responseOwner}`)
      if (input.reservationId) this.releaseReservation(input.reservationId, "response_conflict")
      return this.result(false)
    }
    if (priorTurnRecords.length > 0) {
      this.addAnomaly(
        "turn_multiple_terminal_responses",
        normalized,
        `turn ${normalized.turnId} emitted multiple terminal usage records`,
      )
      if (input.reservationId) this.releaseReservation(input.reservationId, "multiple_terminal_responses")
      return this.result(false)
    }
    const inputTokens = normalized.contextInputTokens ?? 0
    if (normalized.contextWindow && inputTokens > normalized.contextWindow) {
      this.addAnomaly("context_overflow", normalized, `response used ${inputTokens} input tokens with context window ${normalized.contextWindow}`)
    }
    const modelScope = `${normalized.threadId}\0${normalized.provider ?? "unknown"}\0${normalized.model ?? "unknown"}`
    const priorModel = this.previousByModel.get(modelScope)
    const priorInputTokens = priorModel?.contextInputTokens ?? 0
    if (
      priorModel &&
      priorInputTokens >= 16_000 &&
      inputTokens > priorInputTokens * 3 &&
      !normalized.anomalyReason
    ) {
      this.addAnomaly("token_jump", normalized, `response input tokens jumped from ${priorInputTokens} to ${inputTokens}`)
    }
    this.rawKeys.set(key, normalized)
    this.responseOwners.set(input.responseId, key)
    this.responseRecords.set(input.responseId, normalized)
    this.recordsByScopedTurn.set(scopedTurn, [...(this.recordsByScopedTurn.get(scopedTurn) ?? []), normalized])
    this.previousByModel.set(modelScope, normalized)
    this.rawCompletions.push(normalized)
    this.consumed += normalized.totalTokens
    this.append(normalized)
    if (input.reservationId) this.releaseReservation(input.reservationId, "usage_recorded")
    return this.result(true)
  }

  get budget(): UsageResult {
    return this.result(false)
  }

  admitNextResponse(input: {
    billingScopeId: string
    threadId: string
    turnId: string
    provider?: string
    model?: string
    contextWindow?: number
  }): UsageAdmission {
    const threshold = Math.floor(this.options.totalBudget * (this.options.admissionFraction ?? 0.85))
    const scopedTurn = `${input.billingScopeId}\0${input.turnId}`
    const records = this.recordsByScopedTurn.get(scopedTurn) ?? []
    const turnReservations = [...this.reservations.values()].filter((reservation) => reservation.scopedTurn === scopedTurn)
    const matchesModel = (record: RawUsageRecord): boolean =>
      (!input.provider || record.provider === input.provider) && (!input.model || record.model === input.model)
    const prior = [...records].reverse().find(matchesModel) ?? (
      input.provider || input.model
        ? this.previousByModel.get(`${input.threadId}\0${input.provider ?? "unknown"}\0${input.model ?? "unknown"}`)
        : records.at(-1)
    )
    const estimatedNextTokens = prior
      ? Math.max(prior.totalTokens, prior.contextInputTokens ?? 0)
      : finiteToken(input.contextWindow) || threshold
    const reservedBefore = [...this.reservations.values()].reduce((sum, reservation) => sum + reservation.estimatedTokens, 0)
    const responsesInFlightBefore = turnReservations.length
    let reason: UsageAdmission["reason"]
    if (records.length + responsesInFlightBefore >= (this.options.maxResponsesPerTurn ?? 16)) {
      reason = "response_limit"
    } else if (this.consumed + reservedBefore >= threshold) {
      reason = "budget_threshold"
    } else if (this.consumed + reservedBefore + estimatedNextTokens > threshold) {
      reason = "projected_budget"
    }
    let reservationId: string | undefined
    if (reason) {
      this.admissionDenials += 1
    } else {
      reservationId = randomUUID()
      const recordedAt = new Date().toISOString()
      this.reservations.set(reservationId, {
        id: reservationId,
        scopedTurn,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        estimatedTokens: estimatedNextTokens,
        recordedAt,
      })
      this.append({
        kind: "reservation_acquired",
        reservationId,
        scopedTurn,
        billingScopeId: input.billingScopeId,
        threadId: input.threadId,
        turnId: input.turnId,
        provider: input.provider,
        model: input.model,
        estimatedTokens: estimatedNextTokens,
        recordedAt,
      })
    }
    return {
      allowed: !reason,
      ...(reason ? { reason } : {}),
      ...(reservationId ? { reservationId } : {}),
      consumed: this.consumed,
      limit: this.options.totalBudget,
      threshold,
      estimatedNextTokens,
      responsesInTurn: records.length,
      responsesInFlight: responsesInFlightBefore + (reservationId ? 1 : 0),
      reservedTokens: reservedBefore + (reservationId ? estimatedNextTokens : 0),
    }
  }

  hasBlockingAnomalies(): boolean {
    return this.anomalies.some((anomaly) => anomaly.blocking)
  }

  releaseReservation(reservationId: string, reason = "request_finished", persist = true): boolean {
    const reservation = this.reservations.get(reservationId)
    if (!reservation) return false
    this.reservations.delete(reservationId)
    if (persist) {
      this.append({
        kind: "reservation_released",
        reservationId,
        reason,
        recordedAt: new Date().toISOString(),
      })
    }
    return true
  }

  recordTerminalUsageConflict(input: RawUsageInput, message: string): UsageResult {
    const record: RawUsageRecord = {
      ...input,
      kind: "raw_completion_usage",
      recordedAt: new Date().toISOString(),
      inputTokens: finiteToken(input.inputTokens),
      contextInputTokens: finiteToken(input.contextInputTokens ?? input.inputTokens),
      billableInputTokens: finiteToken(input.billableInputTokens ?? input.inputTokens),
      cachedInputTokens: finiteToken(input.cachedInputTokens),
      cacheWriteInputTokens: finiteToken(input.cacheWriteInputTokens),
      outputTokens: finiteToken(input.outputTokens),
      reasoningOutputTokens: finiteToken(input.reasoningOutputTokens),
      totalTokens: finiteToken(input.totalTokens),
    }
    this.addAnomaly("terminal_usage_changed", record, message)
    if (input.reservationId) this.releaseReservation(input.reservationId, "terminal_usage_conflict")
    return this.result(false)
  }

  private breakdown(value: TokenBreakdown): TokenBreakdown {
    return {
      totalTokens: finiteToken(value.totalTokens),
      inputTokens: finiteToken(value.inputTokens),
      cachedInputTokens: finiteToken(value.cachedInputTokens),
      cacheWriteInputTokens: finiteToken(value.cacheWriteInputTokens),
      outputTokens: finiteToken(value.outputTokens),
      reasoningOutputTokens: finiteToken(value.reasoningOutputTokens),
    }
  }

  private result(acceptedRaw: boolean): UsageResult {
    const fraction = this.consumed / this.options.totalBudget
    const state: TokenBudgetState =
      fraction >= 1 ? "exceeded" : fraction >= 0.85 ? "throttled" : fraction >= 0.7 ? "warning" : "normal"
    return {
      acceptedRaw,
      consumed: this.consumed,
      limit: this.options.totalBudget,
      fraction,
      state,
      blockingAnomalies: this.anomalies.filter((anomaly) => anomaly.blocking).length,
      responses: this.rawCompletions.length,
      turns: this.recordsByScopedTurn.size,
      admissionDenials: this.admissionDenials,
    }
  }

  private addAnomaly(type: TokenAnomalyType, record: RawUsageRecord, message: string, persist = true): void {
    const anomalyKey = this.anomalyKey(type, record)
    if (this.anomalyKeys.has(anomalyKey)) return
    const anomaly: TokenAnomaly = {
      id: `${type}:${record.responseId}:${this.anomalies.length + 1}`,
      type,
      blocking: true,
      responseId: record.responseId,
      threadId: record.threadId,
      turnId: record.turnId,
      message,
      recordedAt: new Date().toISOString(),
    }
    this.anomalies.push(anomaly)
    this.anomalyIds.add(anomaly.id)
    this.anomalyKeys.add(anomalyKey)
    if (persist) this.append({ kind: "token_anomaly", ...anomaly })
  }

  private enrichRecord(existing: RawUsageRecord, incoming: RawUsageRecord): boolean {
    let changed = false
    if (!existing.provider && incoming.provider) { existing.provider = incoming.provider; changed = true }
    if (!existing.model && incoming.model) { existing.model = incoming.model; changed = true }
    if (!existing.contextWindow && incoming.contextWindow) { existing.contextWindow = incoming.contextWindow; changed = true }
    if (!existing.source && incoming.source) { existing.source = incoming.source; changed = true }
    return changed
  }

  private validLineage(record: RawUsageRecord): boolean {
    const lineage = record.lineage
    if (!Array.isArray(lineage) || lineage.length === 0 || lineage.some((item) => typeof item !== "string" || !item)) return false
    if (lineage.at(-1) !== record.threadId) return false
    if (record.parentThreadId && lineage.at(-2) !== record.parentThreadId) return false
    return true
  }

  private isLineageOverlap(previous: RawUsageRecord, current: RawUsageRecord): boolean {
    const left = previous.lineage
    const right = current.lineage
    if (!left || !right || left.length === 0 || right.length === 0 || left.length === right.length) return false
    const shorter = left.length < right.length ? left : right
    const longer = left.length < right.length ? right : left
    return shorter.every((value, index) => value === longer[index])
  }

  private anomalyKey(type: TokenAnomalyType, record: Pick<RawUsageRecord, "billingScopeId" | "responseId" | "threadId" | "turnId">): string {
    return [type, record.billingScopeId ?? record.threadId, record.threadId, record.turnId, record.responseId].join("\0")
  }

  private append(value: unknown): void {
    if (!this.options.path) return
    this.options.assertWriterOwnership?.()
    appendJsonl(this.options.path, value)
  }

  private replay(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("usage ledger row must be an object")
    const row = value as Record<string, unknown>
    if (row.kind === "raw_completion_usage") {
      for (const field of ["threadId", "turnId", "responseId", "recordedAt"]) {
        if (typeof row[field] !== "string" || !row[field]) throw new Error(`usage ledger raw row missing ${field}`)
      }
      const record = {
        ...row,
        kind: "raw_completion_usage",
        inputTokens: finiteToken(row.inputTokens),
        contextInputTokens: finiteToken(row.contextInputTokens ?? row.inputTokens),
        billableInputTokens: finiteToken(row.billableInputTokens ?? row.inputTokens),
        cachedInputTokens: finiteToken(row.cachedInputTokens),
        cacheWriteInputTokens: finiteToken(row.cacheWriteInputTokens),
        outputTokens: finiteToken(row.outputTokens),
        reasoningOutputTokens: finiteToken(row.reasoningOutputTokens),
        totalTokens: finiteToken(row.totalTokens),
      } as RawUsageRecord
      if (record.reservationId) this.reservations.delete(record.reservationId)
      const scope = record.billingScopeId ?? record.threadId
      const key = `${scope}\0${record.threadId}\0${record.turnId}\0${record.responseId}`
      const existing = this.rawKeys.get(key)
      if (existing) {
        if (!sameTerminalUsage(existing, record)) throw new Error(`conflicting raw usage replay for ${record.responseId}`)
        this.enrichRecord(existing, record)
        return
      }
      if (record.lineage !== undefined && !this.validLineage(record)) throw new Error(`invalid usage lineage replay for ${record.responseId}`)
      const scopedTurn = `${scope}\0${record.turnId}`
      const priorTurnRecords = this.recordsByScopedTurn.get(scopedTurn) ?? []
      const turnOverlap = priorTurnRecords.find((previous) =>
        previous.threadId !== record.threadId && this.isLineageOverlap(previous, record),
      )
      if (turnOverlap) {
        this.addAnomaly(
          "lineage_billing_overlap",
          record,
          `turn ${record.turnId} was already billed to overlapping lineage ${turnOverlap.lineage?.join("/") ?? turnOverlap.threadId}`,
          false,
        )
        return
      }
      const owner = this.responseOwners.get(record.responseId)
      if (owner && owner !== key) {
        const previousRecord = this.responseRecords.get(record.responseId)
        const previousScope = previousRecord?.billingScopeId ?? previousRecord?.threadId
        const currentScope = record.billingScopeId ?? record.threadId
        if (previousRecord && previousScope === currentScope && this.isLineageOverlap(previousRecord, record)) {
          this.addAnomaly("lineage_billing_overlap", record, `response ${record.responseId} was already billed to ${owner}`, false)
          return
        }
        if (previousRecord?.billingScopeId && record.billingScopeId && previousScope !== currentScope) {
          this.addAnomaly("billing_scope_double_billing", record, `response ${record.responseId} was already billed to ${owner}`, false)
          return
        }
        throw new Error(`conflicting response owner replay for ${record.responseId}`)
      }
      if (priorTurnRecords.length > 0) {
        this.addAnomaly(
          "turn_multiple_terminal_responses",
          record,
          `turn ${record.turnId} emitted multiple terminal usage records`,
          false,
        )
        return
      }
      this.rawKeys.set(key, record)
      this.responseOwners.set(record.responseId, key)
      this.responseRecords.set(record.responseId, record)
      this.recordsByScopedTurn.set(scopedTurn, [...(this.recordsByScopedTurn.get(scopedTurn) ?? []), record])
      this.previousByModel.set(`${record.threadId}\0${record.provider ?? "unknown"}\0${record.model ?? "unknown"}`, record)
      this.rawCompletions.push(record)
      this.consumed += record.totalTokens
      return
    }
    if (row.kind === "reservation_acquired") {
      if (
        typeof row.reservationId !== "string" || !row.reservationId ||
        typeof row.scopedTurn !== "string" || !row.scopedTurn ||
        typeof row.estimatedTokens !== "number" || !Number.isSafeInteger(row.estimatedTokens) || row.estimatedTokens < 0 ||
        typeof row.recordedAt !== "string" || !row.recordedAt
      ) throw new Error("invalid usage reservation acquisition replay row")
      this.reservations.set(row.reservationId, {
        id: row.reservationId,
        scopedTurn: row.scopedTurn,
        ...(typeof row.provider === "string" ? { provider: row.provider } : {}),
        ...(typeof row.model === "string" ? { model: row.model } : {}),
        estimatedTokens: row.estimatedTokens,
        recordedAt: row.recordedAt,
      })
      return
    }
    if (row.kind === "reservation_released") {
      if (typeof row.reservationId !== "string" || !row.reservationId) throw new Error("invalid usage reservation release replay row")
      this.reservations.delete(row.reservationId)
      return
    }
    if (row.kind === "thread_cumulative_usage") {
      if (typeof row.threadId !== "string" || !row.threadId) throw new Error("usage cumulative row missing threadId")
      this.cumulative.set(row.threadId, this.breakdown(row as unknown as TokenBreakdown))
      return
    }
    if (row.kind === "token_anomaly") {
      const type = row.type as TokenAnomalyType
      if (
        typeof row.id !== "string" || !row.id ||
        !["terminal_usage_changed", "turn_multiple_terminal_responses", "response_double_billing", "billing_scope_double_billing", "invalid_usage_lineage", "lineage_billing_overlap", "context_overflow", "token_jump"].includes(type) ||
        typeof row.responseId !== "string" || typeof row.threadId !== "string" || typeof row.turnId !== "string" ||
        typeof row.message !== "string" || typeof row.recordedAt !== "string" || typeof row.blocking !== "boolean"
      ) throw new Error("invalid token anomaly replay row")
      if (this.anomalyIds.has(row.id)) return
      const anomalyKey = this.anomalyKey(type, row as unknown as RawUsageRecord)
      if (this.anomalyKeys.has(anomalyKey)) return
      this.anomalyIds.add(row.id)
      this.anomalyKeys.add(anomalyKey)
      this.anomalies.push(row as unknown as TokenAnomaly)
      return
    }
    throw new Error(`unknown usage ledger row kind ${String(row.kind)}`)
  }
}
