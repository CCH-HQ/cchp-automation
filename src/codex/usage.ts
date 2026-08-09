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
  reservation?: UsageReservationRef
}

export interface RawUsageRecord extends RawUsageInput {
  kind: "raw_completion_usage"
  recordedAt: string
}

export interface UsageResult {
  acceptedRaw: boolean
  consumed: number
  reservedTokens?: number
  responsesInFlight?: number
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
  reason?: "budget_threshold" | "projected_budget"
  consumed: number
  limit: number
  threshold: number
  estimatedNextTokens: number
  responsesInTurn: number
  responsesInFlight: number
  reservedTokens: number
  reservationId?: string
  reservation?: UsageReservationRef
}

export interface UsageReservationRef {
  reservationId: string
  writerId: string
  writerGeneration: number
  requestId: string
}

export type TokenAnomalyType =
  | "terminal_usage_changed"
  | "response_double_billing"
  | "billing_scope_double_billing"
  | "invalid_usage_lineage"
  | "lineage_billing_overlap"
  | "usage_metadata_conflict"
  | "context_overflow"
  | "token_jump"

export interface TokenAnomaly {
  id: string
  type: TokenAnomalyType
  blocking: boolean
  baselineResponseId?: string
  responseId: string
  threadId: string
  turnId: string
  billingScopeId?: string
  message: string
  recordedAt: string
}

export interface UsageLedgerOptions {
  path?: string
  totalBudget: number
  assertWriterOwnership?: () => void
  admissionFraction?: number
  writerFence?: { writerId: string; generation: number }
}

interface UsageReservation {
  id: string
  writerId: string
  writerGeneration: number
  requestId: string
  scopedTurn: string
  provider?: string
  model?: string
  estimatedTokens: number
  recordedAt: string
}

function finiteToken(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function parseReservationRef(value: unknown): UsageReservationRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("usage reservation reference must be an object")
  const reference = value as Partial<UsageReservationRef>
  if (
    typeof reference.reservationId !== "string" || !reference.reservationId ||
    typeof reference.writerId !== "string" || !reference.writerId ||
    !Number.isSafeInteger(reference.writerGeneration) || (reference.writerGeneration ?? -1) < 0 ||
    typeof reference.requestId !== "string" || !reference.requestId
  ) throw new Error("usage reservation reference is invalid")
  return reference as UsageReservationRef
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
  private readonly estimateByModel = new Map<string, RawUsageRecord>()
  private readonly reservations = new Map<string, UsageReservation>()
  private readonly recoveredReservations = new Map<string, UsageReservation>()
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
    if (options.writerFence && (
      !options.writerFence.writerId || !Number.isSafeInteger(options.writerFence.generation) || options.writerFence.generation < 1
    )) throw new Error("usage writer fence is invalid")
    if (options.path) for (const row of readJsonl(options.path)) this.replay(row)
    this.recoverStaleReservations()
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
      if (input.reservation) this.releaseReservation(input.reservation, "duplicate_usage")
      return this.result(false)
    }
    if (normalized.lineage !== undefined && !this.validLineage(normalized)) {
      this.addAnomaly("invalid_usage_lineage", normalized, "usage lineage does not terminate at the billed thread or parent")
      if (input.reservation) this.releaseReservation(input.reservation, "invalid_lineage")
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
      if (input.reservation) this.releaseReservation(input.reservation, "lineage_overlap")
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
      if (input.reservation) this.releaseReservation(input.reservation, "response_conflict")
      return this.result(false)
    }
    this.observeRecordAnomalies(normalized)
    this.rawKeys.set(key, normalized)
    this.responseOwners.set(input.responseId, key)
    this.responseRecords.set(input.responseId, normalized)
    this.recordsByScopedTurn.set(scopedTurn, [...(this.recordsByScopedTurn.get(scopedTurn) ?? []), normalized])
    this.rawCompletions.push(normalized)
    this.indexRecord(normalized)
    const recoveredEstimate = this.takeRecoveredEstimate(input.reservation)
    this.consumed += normalized.totalTokens - recoveredEstimate
    this.rebuildTokenJumpAnomalies()
    this.append(normalized)
    if (input.reservation) this.releaseReservation(input.reservation, "usage_recorded")
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
    estimatedTokens?: number
  }): UsageAdmission {
    const threshold = Math.floor(this.options.totalBudget * (this.options.admissionFraction ?? 0.85))
    const scopedTurn = `${input.billingScopeId}\0${input.turnId}`
    const records = this.recordsByScopedTurn.get(scopedTurn) ?? []
    const turnReservations = [...this.reservations.values()].filter((reservation) => reservation.scopedTurn === scopedTurn)
    const matchesModel = (record: RawUsageRecord): boolean =>
      (!input.provider || record.provider === input.provider) && (!input.model || record.model === input.model)
    const prior = [...records].reverse().find(matchesModel) ?? (
      input.provider || input.model
        ? this.estimateByModel.get(`${input.billingScopeId}\0${input.provider ?? "unknown"}\0${input.model ?? "unknown"}`)
        : records.at(-1)
    )
    const observedEstimate = prior ? Math.max(prior.totalTokens, prior.contextInputTokens ?? 0) : 0
    const requestEstimate = finiteToken(input.estimatedTokens)
    const estimatedNextTokens = requestEstimate > 0
      ? requestEstimate
      : observedEstimate > 0
        ? observedEstimate
      : finiteToken(input.contextWindow) || threshold
    const reservedBefore = [...this.reservations.values()].reduce((sum, reservation) => sum + reservation.estimatedTokens, 0)
    const responsesInFlightBefore = turnReservations.length
    let reason: UsageAdmission["reason"]
    if (this.consumed + reservedBefore >= threshold) {
      reason = "budget_threshold"
    } else if (this.consumed + reservedBefore + estimatedNextTokens > threshold) {
      reason = "projected_budget"
    }
    let reservation: UsageReservationRef | undefined
    if (reason) {
      this.admissionDenials += 1
    } else {
      const reservationId = randomUUID()
      const writerFence = this.options.writerFence ?? { writerId: "legacy", generation: 0 }
      reservation = {
        reservationId,
        writerId: writerFence.writerId,
        writerGeneration: writerFence.generation,
        requestId: randomUUID(),
      }
      const recordedAt = new Date().toISOString()
      this.reservations.set(reservationId, {
        id: reservationId,
        writerId: reservation.writerId,
        writerGeneration: reservation.writerGeneration,
        requestId: reservation.requestId,
        scopedTurn,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        estimatedTokens: estimatedNextTokens,
        recordedAt,
      })
      this.append({
        kind: "reservation_acquired",
        reservationId,
        writerId: reservation.writerId,
        writerGeneration: reservation.writerGeneration,
        requestId: reservation.requestId,
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
      ...(reservation ? { reservationId: reservation.reservationId, reservation } : {}),
      consumed: this.consumed,
      limit: this.options.totalBudget,
      threshold,
      estimatedNextTokens,
      responsesInTurn: records.length,
      responsesInFlight: responsesInFlightBefore + (reservation ? 1 : 0),
      reservedTokens: reservedBefore + (reservation ? estimatedNextTokens : 0),
    }
  }

  hasBlockingAnomalies(): boolean {
    return this.anomalies.some((anomaly) => anomaly.blocking)
  }

  hasProvisionalTokenJump(): boolean {
    return this.anomalies.some((anomaly) => anomaly.type === "token_jump" && !anomaly.blocking)
  }

  releaseReservation(reference: UsageReservationRef, reason = "request_finished", persist = true): boolean {
    const reservation = this.reservations.get(reference.reservationId)
    if (!reservation || !this.sameReservation(reservation, reference)) return false
    this.reservations.delete(reference.reservationId)
    if (persist) {
      this.append({
        kind: "reservation_released",
        ...reference,
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
    if (input.reservation) this.releaseReservation(input.reservation, "terminal_usage_conflict")
    return this.result(false)
  }

  private sameReservation(reservation: UsageReservation, reference: UsageReservationRef): boolean {
    return reservation.id === reference.reservationId &&
      reservation.writerId === reference.writerId &&
      reservation.writerGeneration === reference.writerGeneration &&
      reservation.requestId === reference.requestId
  }

  private takeRecoveredEstimate(reference: UsageReservationRef | undefined): number {
    if (!reference) return 0
    const recovered = this.recoveredReservations.get(reference.reservationId)
    if (!recovered || !this.sameReservation(recovered, reference)) return 0
    this.recoveredReservations.delete(reference.reservationId)
    return recovered.estimatedTokens
  }

  private recoverStaleReservations(): void {
    const fence = this.options.writerFence
    if (!fence) return
    for (const reservation of [...this.reservations.values()]) {
      if (reservation.writerId === fence.writerId && reservation.writerGeneration === fence.generation) continue
      this.reservations.delete(reservation.id)
      this.recoveredReservations.set(reservation.id, reservation)
      this.consumed += reservation.estimatedTokens
      this.append({
        kind: "reservation_recovered",
        reservationId: reservation.id,
        writerId: reservation.writerId,
        writerGeneration: reservation.writerGeneration,
        requestId: reservation.requestId,
        recoveredByWriterId: fence.writerId,
        recoveredByGeneration: fence.generation,
        scopedTurn: reservation.scopedTurn,
        provider: reservation.provider,
        model: reservation.model,
        estimatedTokens: reservation.estimatedTokens,
        recordedAt: new Date().toISOString(),
      })
    }
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
    const reservations = [...this.reservations.values()]
    const state: TokenBudgetState =
      fraction >= 1 ? "exceeded" : fraction >= 0.85 ? "throttled" : fraction >= 0.7 ? "warning" : "normal"
    return {
      acceptedRaw,
      consumed: this.consumed,
      reservedTokens: reservations.reduce((sum, reservation) => sum + reservation.estimatedTokens, 0),
      responsesInFlight: reservations.length,
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
      id: type === "token_jump" ? `${type}:${record.responseId}` : `${type}:${record.responseId}:${this.anomalies.length + 1}`,
      type,
      blocking: type !== "token_jump" || Boolean(record.provider && record.model),
      responseId: record.responseId,
      threadId: record.threadId,
      turnId: record.turnId,
      ...(record.billingScopeId ? { billingScopeId: record.billingScopeId } : {}),
      message,
      recordedAt: type === "token_jump" ? record.recordedAt : new Date().toISOString(),
    }
    this.anomalies.push(anomaly)
    this.anomalyIds.add(anomaly.id)
    this.anomalyKeys.add(anomalyKey)
    if (persist) this.append({ kind: "token_anomaly", ...anomaly })
  }

  private addTokenJumpAnomaly(baseline: RawUsageRecord, record: RawUsageRecord, provisional: boolean): void {
    const anomalyKey = this.anomalyKey("token_jump", { ...record, baselineResponseId: baseline.responseId })
    if (this.anomalyKeys.has(anomalyKey)) return
    const baselineInputTokens = baseline.contextInputTokens ?? 0
    const inputTokens = record.contextInputTokens ?? 0
    const anomaly: TokenAnomaly = {
      id: `token_jump:${baseline.responseId}:${record.responseId}`,
      type: "token_jump",
      blocking: !provisional,
      baselineResponseId: baseline.responseId,
      responseId: record.responseId,
      threadId: record.threadId,
      turnId: record.turnId,
      ...(record.billingScopeId ? { billingScopeId: record.billingScopeId } : {}),
      message: `response input tokens jumped from ${baselineInputTokens} to ${inputTokens}`,
      recordedAt: record.recordedAt,
    }
    this.anomalies.push(anomaly)
    this.anomalyIds.add(anomaly.id)
    this.anomalyKeys.add(anomalyKey)
  }

  private enrichRecord(existing: RawUsageRecord, incoming: RawUsageRecord, persistAnomaly = true): boolean {
    const previousModelScope = this.modelScope(existing)
    const previousEstimateScope = this.estimateScope(existing)
    let changed = false
    for (const field of ["provider", "model", "contextWindow"] as const) {
      const oldValue = existing[field]
      const newValue = incoming[field]
      if (oldValue !== undefined && newValue !== undefined && oldValue !== newValue) {
        this.addAnomaly(
          "usage_metadata_conflict",
          incoming,
          `${field} metadata changed for response ${incoming.responseId}: existing=${String(oldValue)} incoming=${String(newValue)}`,
          persistAnomaly,
        )
        return false
      }
    }
    if (existing.source && incoming.source && existing.source !== incoming.source) {
      const observationSources = [existing.source, incoming.source]
      const observationPair = observationSources.every((source) =>
        source.startsWith("app-server:") || source.startsWith("provider-bridge:"),
      ) && observationSources.some((source) => source.startsWith("app-server:")) &&
        observationSources.some((source) => source.startsWith("provider-bridge:"))
      if (!observationPair) {
        this.addAnomaly(
          "usage_metadata_conflict",
          incoming,
          `source metadata changed for response ${incoming.responseId}: existing=${existing.source} incoming=${incoming.source}`,
          persistAnomaly,
        )
        return false
      }
    }
    if (existing.provider === undefined && incoming.provider !== undefined) { existing.provider = incoming.provider; changed = true }
    if (existing.model === undefined && incoming.model !== undefined) { existing.model = incoming.model; changed = true }
    if (existing.contextWindow === undefined && incoming.contextWindow !== undefined) { existing.contextWindow = incoming.contextWindow; changed = true }
    if (!existing.source && incoming.source) { existing.source = incoming.source; changed = true }
    if (changed) {
      if (this.previousByModel.get(previousModelScope) === existing) this.previousByModel.delete(previousModelScope)
      if (this.estimateByModel.get(previousEstimateScope) === existing) this.estimateByModel.delete(previousEstimateScope)
      this.indexRecord(existing)
    }
    this.observeRecordAnomalies(existing, persistAnomaly)
    this.rebuildTokenJumpAnomalies()
    return changed
  }

  private observeRecordAnomalies(record: RawUsageRecord, persist = true): void {
    const inputTokens = record.contextInputTokens ?? 0
    if (record.contextWindow !== undefined && inputTokens > record.contextWindow) {
      this.addAnomaly("context_overflow", record, `response used ${inputTokens} input tokens with context window ${record.contextWindow}`, persist)
    }
  }

  private rebuildTokenJumpAnomalies(): void {
    for (let index = this.anomalies.length - 1; index >= 0; index--) {
      const anomaly = this.anomalies[index]!
      if (anomaly.type !== "token_jump") continue
      this.anomalies.splice(index, 1)
      this.anomalyIds.delete(anomaly.id)
      this.anomalyKeys.delete(this.anomalyKey(anomaly.type, anomaly))
    }
    const previous = new Map<string, RawUsageRecord[]>()
    for (const record of this.rawCompletions) {
      const threadRecords = previous.get(record.threadId) ?? []
      const compatible = (candidate: RawUsageRecord): boolean =>
        (!candidate.provider || !record.provider || candidate.provider === record.provider) &&
        (!candidate.model || !record.model || candidate.model === record.model)
      let priorIndex = -1
      if (record.provider && record.model) {
        priorIndex = threadRecords.findLastIndex((candidate) =>
          candidate.provider === record.provider && candidate.model === record.model)
      }
      if (priorIndex < 0) priorIndex = threadRecords.findLastIndex(compatible)
      const prior = priorIndex >= 0 ? threadRecords[priorIndex] : undefined
      const priorInputTokens = prior?.contextInputTokens ?? 0
      const inputTokens = record.contextInputTokens ?? 0
      if (prior && priorInputTokens >= 16_000 && inputTokens > priorInputTokens * 3 && !record.anomalyReason) {
        const unresolvedIntervening = threadRecords.slice(priorIndex + 1).some((candidate) =>
          compatible(candidate) && (!candidate.provider || !candidate.model))
        this.addTokenJumpAnomaly(
          prior,
          record,
          unresolvedIntervening || !prior.provider || !prior.model || !record.provider || !record.model,
        )
      }
      threadRecords.push(record)
      previous.set(record.threadId, threadRecords)
    }
  }

  private modelScope(record: RawUsageRecord): string {
    return `${record.threadId}\0${record.provider ?? "unknown"}\0${record.model ?? "unknown"}`
  }

  private estimateScope(record: RawUsageRecord): string {
    return `${record.billingScopeId ?? record.threadId}\0${record.provider ?? "unknown"}\0${record.model ?? "unknown"}`
  }

  private indexRecord(record: RawUsageRecord): void {
    const candidateIndex = this.rawCompletions.indexOf(record)
    const update = (index: Map<string, RawUsageRecord>, key: string): void => {
      const current = index.get(key)
      if (!current || this.rawCompletions.indexOf(current) <= candidateIndex) index.set(key, record)
    }
    update(this.previousByModel, this.modelScope(record))
    update(this.estimateByModel, this.estimateScope(record))
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

  private anomalyKey(
    type: TokenAnomalyType,
    record: Pick<RawUsageRecord, "billingScopeId" | "responseId" | "threadId" | "turnId"> & { baselineResponseId?: string },
  ): string {
    return [
      type,
      record.billingScopeId ?? record.threadId,
      record.threadId,
      record.turnId,
      record.baselineResponseId ?? "",
      record.responseId,
    ].join("\0")
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
      const reservation = row.reservation === undefined ? undefined : parseReservationRef(row.reservation)
      const record = {
        ...row,
        kind: "raw_completion_usage",
        ...(reservation ? { reservation } : {}),
        inputTokens: finiteToken(row.inputTokens),
        contextInputTokens: finiteToken(row.contextInputTokens ?? row.inputTokens),
        billableInputTokens: finiteToken(row.billableInputTokens ?? row.inputTokens),
        cachedInputTokens: finiteToken(row.cachedInputTokens),
        cacheWriteInputTokens: finiteToken(row.cacheWriteInputTokens),
        outputTokens: finiteToken(row.outputTokens),
        reasoningOutputTokens: finiteToken(row.reasoningOutputTokens),
        totalTokens: finiteToken(row.totalTokens),
      } as RawUsageRecord
      if (reservation) {
        const active = this.reservations.get(reservation.reservationId)
        if (active && this.sameReservation(active, reservation)) this.reservations.delete(reservation.reservationId)
      } else if (typeof row.reservationId === "string") {
        // Legacy rows predate generation-bound reservation capabilities.
        this.reservations.delete(row.reservationId)
      }
      const scope = record.billingScopeId ?? record.threadId
      const key = `${scope}\0${record.threadId}\0${record.turnId}\0${record.responseId}`
      const existing = this.rawKeys.get(key)
      if (existing) {
        if (!sameTerminalUsage(existing, record)) throw new Error(`conflicting raw usage replay for ${record.responseId}`)
        const anomalyCount = this.anomalies.length
        this.enrichRecord(existing, record, false)
        if (this.anomalies.length > anomalyCount && this.anomalies.at(-1)?.type === "usage_metadata_conflict") {
          throw new Error(`conflicting usage metadata replay for ${record.responseId}`)
        }
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
      this.rawKeys.set(key, record)
      this.responseOwners.set(record.responseId, key)
      this.responseRecords.set(record.responseId, record)
      this.recordsByScopedTurn.set(scopedTurn, [...(this.recordsByScopedTurn.get(scopedTurn) ?? []), record])
      this.rawCompletions.push(record)
      this.indexRecord(record)
      const recoveredEstimate = this.takeRecoveredEstimate(reservation)
      this.consumed += record.totalTokens - recoveredEstimate
      this.observeRecordAnomalies(record, false)
      this.rebuildTokenJumpAnomalies()
      return
    }
    if (row.kind === "reservation_acquired") {
      if (
        typeof row.reservationId !== "string" || !row.reservationId ||
        typeof row.scopedTurn !== "string" || !row.scopedTurn ||
        typeof row.estimatedTokens !== "number" || !Number.isSafeInteger(row.estimatedTokens) || row.estimatedTokens < 0 ||
        typeof row.recordedAt !== "string" || !row.recordedAt
      ) throw new Error("invalid usage reservation acquisition replay row")
      const writerId = typeof row.writerId === "string" && row.writerId ? row.writerId : "legacy"
      const writerGeneration = Number.isSafeInteger(row.writerGeneration) && Number(row.writerGeneration) >= 0 ? Number(row.writerGeneration) : 0
      const requestId = typeof row.requestId === "string" && row.requestId ? row.requestId : row.reservationId
      this.reservations.set(row.reservationId, {
        id: row.reservationId,
        writerId,
        writerGeneration,
        requestId,
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
      const reservation = this.reservations.get(row.reservationId)
      if (!reservation) return
      if (row.writerId === undefined && row.writerGeneration === undefined && row.requestId === undefined) {
        this.reservations.delete(row.reservationId)
        return
      }
      const reference = parseReservationRef(row)
      if (this.sameReservation(reservation, reference)) this.reservations.delete(row.reservationId)
      return
    }
    if (row.kind === "reservation_recovered") {
      const reference = parseReservationRef(row)
      if (
        typeof row.scopedTurn !== "string" || !row.scopedTurn ||
        typeof row.estimatedTokens !== "number" || !Number.isSafeInteger(row.estimatedTokens) || row.estimatedTokens < 0 ||
        typeof row.recoveredByWriterId !== "string" || !row.recoveredByWriterId ||
        !Number.isSafeInteger(row.recoveredByGeneration) || Number(row.recoveredByGeneration) < 1 ||
        typeof row.recordedAt !== "string" || !row.recordedAt
      ) throw new Error("invalid usage reservation recovery replay row")
      const reservation: UsageReservation = {
        id: reference.reservationId,
        writerId: reference.writerId,
        writerGeneration: reference.writerGeneration,
        requestId: reference.requestId,
        scopedTurn: row.scopedTurn,
        ...(typeof row.provider === "string" ? { provider: row.provider } : {}),
        ...(typeof row.model === "string" ? { model: row.model } : {}),
        estimatedTokens: row.estimatedTokens,
        recordedAt: row.recordedAt,
      }
      const active = this.reservations.get(reference.reservationId)
      if (active && !this.sameReservation(active, reference)) throw new Error("usage reservation recovery identity drift")
      this.reservations.delete(reference.reservationId)
      const prior = this.recoveredReservations.get(reference.reservationId)
      if (prior) {
        if (!this.sameReservation(prior, reference) || prior.estimatedTokens !== reservation.estimatedTokens) {
          throw new Error("usage reservation recovery replay drift")
        }
        return
      }
      this.recoveredReservations.set(reference.reservationId, reservation)
      this.consumed += reservation.estimatedTokens
      return
    }
    if (row.kind === "thread_cumulative_usage") {
      if (typeof row.threadId !== "string" || !row.threadId) throw new Error("usage cumulative row missing threadId")
      this.cumulative.set(row.threadId, this.breakdown(row as unknown as TokenBreakdown))
      return
    }
    if (row.kind === "token_anomaly") {
      if (row.type === "turn_multiple_terminal_responses") {
        if (
          typeof row.id !== "string" || !row.id ||
          typeof row.responseId !== "string" || typeof row.threadId !== "string" || typeof row.turnId !== "string" ||
          typeof row.message !== "string" || typeof row.recordedAt !== "string" || typeof row.blocking !== "boolean"
        ) throw new Error("invalid legacy token anomaly replay row")
        return
      }
      const type = row.type as TokenAnomalyType
      if (
        typeof row.id !== "string" || !row.id ||
        !["terminal_usage_changed", "response_double_billing", "billing_scope_double_billing", "invalid_usage_lineage", "lineage_billing_overlap", "usage_metadata_conflict", "context_overflow", "token_jump"].includes(type) ||
        typeof row.responseId !== "string" || typeof row.threadId !== "string" || typeof row.turnId !== "string" ||
        typeof row.message !== "string" || typeof row.recordedAt !== "string" || typeof row.blocking !== "boolean"
      ) throw new Error("invalid token anomaly replay row")
      // Prompt jumps are derived from the complete chronological raw ledger.
      // Ignore persisted legacy rows so metadata enrichment can both add and
      // invalidate the derived anomaly deterministically during replay.
      if (type === "token_jump") return
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
