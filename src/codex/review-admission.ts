import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"
import { appendJsonl, readJsonl } from "./jsonl"
import { assembleReferenceContext } from "./references"
import { REVIEW_CHILD_TIMEOUT_MS, REVIEW_MAX_TASKS } from "./review-runner"

export type ReviewAdmissionState =
  | "admitted"
  | "spawn_bound"
  | "completed"
  | "failed"
  | "timed_out"
  | "interrupted"
  | "lost"

export const REVIEW_PASS_KINDS = [
  "review_shard",
  "correctness",
  "verifier",
  "refuter",
  "reproducer",
  "adjudicator",
  "completeness",
] as const

export type ReviewPassKind = typeof REVIEW_PASS_KINDS[number]
export const REVIEW_TASK_IDENTITY_PREFIX = "CCHP_REVIEW_TASK_V1 "

export function isReviewPassKind(value: unknown): value is ReviewPassKind {
  return typeof value === "string" && (REVIEW_PASS_KINDS as readonly string[]).includes(value)
}

function validTaskId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value)
}

export function parseReviewTaskIdentity(prompt: string): { taskId: string; passKind: ReviewPassKind } {
  const firstLine = prompt.split("\n", 1)[0] ?? ""
  if (!firstLine.startsWith(REVIEW_TASK_IDENTITY_PREFIX)) throw new Error("review spawn prompt has no CCHP_REVIEW_TASK_V1 identity")
  let value: unknown
  try {
    value = JSON.parse(firstLine.slice(REVIEW_TASK_IDENTITY_PREFIX.length))
  } catch {
    throw new Error("review spawn prompt has malformed CCHP_REVIEW_TASK_V1 identity")
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("review spawn prompt identity must be an object")
  const identity = value as Record<string, unknown>
  if (Object.keys(identity).sort().join(",") !== "pass_kind,task_id") throw new Error("review spawn prompt identity has unexpected fields")
  if (!validTaskId(identity.task_id)) throw new Error("review spawn prompt identity has invalid task_id")
  if (!isReviewPassKind(identity.pass_kind)) throw new Error("review spawn prompt identity has invalid pass_kind")
  return { taskId: identity.task_id, passKind: identity.pass_kind }
}

export interface ReviewReferenceProvenance {
  bytes: number
  selectedEntryIds: string[]
  selectedAssetIds: string[]
  omittedCount: number
  promptSha256: string
  assembledPromptSha256: string
}

export interface ReviewResultBinding {
  schemaVersion: 1
  artifactPath: string
  artifactSha256: string
  outputSha256: string
  outputBytes: number
}

export interface ReviewAdmission {
  schemaVersion: 2
  runId: string
  taskId: string
  role: string
  passKind: ReviewPassKind
  mode: "native_v2" | "explicit_child"
  admittedAt: string
  deadlineAt: string
  reference: ReviewReferenceProvenance
  state: ReviewAdmissionState
  spawnItemId?: string
  childThreadId?: string
  childSessionId?: string
  terminalAt?: string
  error?: string
  result?: ReviewResultBinding
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function terminal(state: ReviewAdmissionState): boolean {
  return ["completed", "failed", "timed_out", "interrupted", "lost"].includes(state)
}

function copy(entry: ReviewAdmission): ReviewAdmission {
  return {
    ...entry,
    reference: { ...entry.reference, selectedEntryIds: [...entry.reference.selectedEntryIds], selectedAssetIds: [...entry.reference.selectedAssetIds] },
    ...(entry.result ? { result: { ...entry.result } } : {}),
  }
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
}

function validateResultBinding(value: unknown): asserts value is ReviewResultBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("review completion requires a result binding")
  const result = value as Partial<ReviewResultBinding>
  if (result.schemaVersion !== 1) throw new Error("review result binding has unsupported schema")
  if (typeof result.artifactPath !== "string" || !isAbsolute(result.artifactPath)) throw new Error("review result binding requires an absolute artifact path")
  if (!validSha256(result.artifactSha256) || !validSha256(result.outputSha256)) throw new Error("review result binding has invalid sha256")
  if (!Number.isSafeInteger(result.outputBytes) || (result.outputBytes ?? -1) < 0) throw new Error("review result binding has invalid output bytes")
}

function sameResult(left: ReviewResultBinding | undefined, right: ReviewResultBinding | undefined): boolean {
  return Boolean(left && right
    && left.schemaVersion === right.schemaVersion
    && left.artifactPath === right.artifactPath
    && left.artifactSha256 === right.artifactSha256
    && left.outputSha256 === right.outputSha256
    && left.outputBytes === right.outputBytes)
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0)
}

function validateAdmissionPayload(value: unknown, runId: string): asserts value is ReviewAdmission {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("review admission payload must be an object")
  const entry = value as Partial<ReviewAdmission>
  if (entry.schemaVersion !== 2 || entry.runId !== runId) throw new Error("review admission ledger identity mismatch")
  if (!validTaskId(entry.taskId)) throw new Error("review admission has invalid task id")
  if (typeof entry.role !== "string" || !entry.role.trim()) throw new Error("review admission has invalid role")
  if (!isReviewPassKind(entry.passKind)) throw new Error("review admission has invalid pass kind")
  if (entry.mode !== "native_v2" && entry.mode !== "explicit_child") throw new Error("review admission has invalid mode")
  if (entry.state !== "admitted") throw new Error("review admission must begin in admitted state")
  if (!validIso(entry.admittedAt) || !validIso(entry.deadlineAt) || Date.parse(entry.deadlineAt) <= Date.parse(entry.admittedAt)) throw new Error("review admission has invalid deadline")
  const reference = entry.reference as Partial<ReviewReferenceProvenance> | undefined
  if (!reference
    || !Number.isSafeInteger(reference.bytes) || (reference.bytes ?? -1) < 0
    || !Number.isSafeInteger(reference.omittedCount) || (reference.omittedCount ?? -1) < 0
    || !stringArray(reference.selectedEntryIds)
    || !Array.isArray(reference.selectedAssetIds) || !reference.selectedAssetIds.every((item) => typeof item === "string")
    || !validSha256(reference.promptSha256)
    || !validSha256(reference.assembledPromptSha256)) {
    throw new Error("review admission has invalid reference provenance")
  }
}

export class ReviewAdmissionLedger {
  private readonly byTask = new Map<string, ReviewAdmission>()
  private readonly taskByChild = new Map<string, string>()

  constructor(private readonly path: string, private readonly runId: string, private readonly snapshotRows?: readonly unknown[]) {
    if (snapshotRows) {
      for (const row of snapshotRows) this.replay(row)
    } else {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      this.refresh()
    }
  }

  static fromSnapshot(rows: readonly unknown[], runId: string): ReviewAdmissionLedger {
    return new ReviewAdmissionLedger("", runId, rows)
  }

  /** Re-read the append-only ledger so separate supervisor/MCP processes see
   * terminal transitions written by the other process before making a gate
   * decision. The replay is authoritative; in-memory state is only a cache. */
  refresh(): void {
    if (this.snapshotRows) return
    this.byTask.clear()
    this.taskByChild.clear()
    for (const row of readJsonl(this.path)) this.replay(row)
  }

  admit(input: {
    taskId: string
    role: string
    passKind: ReviewPassKind
    mode: ReviewAdmission["mode"]
    prompt: string
    now?: number
    timeoutMs?: number
  }): ReviewAdmission {
    this.refresh()
    if (!validTaskId(input.taskId)) throw new Error(`invalid review task id ${input.taskId}`)
    if (!input.role.trim() || !input.prompt.trim()) throw new Error("review admission requires a role and prompt")
    if (!isReviewPassKind(input.passKind)) throw new Error("review admission requires a valid pass kind")
    const existing = this.byTask.get(input.taskId)
    if (existing) {
      if (existing.role !== input.role || existing.passKind !== input.passKind || existing.mode !== input.mode || existing.reference.promptSha256 !== sha256(input.prompt)) {
        throw new Error(`review task ${input.taskId} admission identity drift`)
      }
      return copy(existing)
    }
    if (this.byTask.size >= REVIEW_MAX_TASKS) throw new Error(`review admission limit exceeded: ${REVIEW_MAX_TASKS}`)
    const now = input.now ?? Date.now()
    const timeoutMs = Math.min(input.timeoutMs ?? REVIEW_CHILD_TIMEOUT_MS, REVIEW_CHILD_TIMEOUT_MS)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("review admission timeout must be a positive integer")
    const references = assembleReferenceContext(input.role, input.prompt)
    const entry: ReviewAdmission = {
      schemaVersion: 2,
      runId: this.runId,
      taskId: input.taskId,
      role: input.role,
      passKind: input.passKind,
      mode: input.mode,
      admittedAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + timeoutMs).toISOString(),
      reference: {
        bytes: references.bytes,
        selectedEntryIds: references.selectedEntryIds,
        selectedAssetIds: references.selectedAssetIds,
        omittedCount: references.omittedCount,
        promptSha256: sha256(input.prompt),
        assembledPromptSha256: sha256(`${input.prompt}\n\n${references.text}`),
      },
      state: "admitted",
    }
    this.byTask.set(entry.taskId, entry)
    this.append({ event: "review_admitted", ...entry })
    return copy(entry)
  }

  bind(taskId: string, spawnItemId: string, childThreadId: string, childSessionId?: string): ReviewAdmission {
    this.refresh()
    const entry = this.require(taskId)
    const owner = this.taskByChild.get(childThreadId)
    if (owner && owner !== taskId) throw new Error(`review child ${childThreadId} already belongs to ${owner}`)
    if (entry.spawnItemId && entry.spawnItemId !== spawnItemId) throw new Error(`review task ${taskId} spawn item drift`)
    if (entry.childThreadId && entry.childThreadId !== childThreadId) throw new Error(`review task ${taskId} child thread drift`)
    if (entry.childSessionId && childSessionId && entry.childSessionId !== childSessionId) throw new Error(`review task ${taskId} child session drift`)
    if (terminal(entry.state)) {
      if (entry.spawnItemId === spawnItemId && entry.childThreadId === childThreadId && (!childSessionId || !entry.childSessionId || entry.childSessionId === childSessionId)) {
        return copy(entry)
      }
      throw new Error(`review task ${taskId} is already terminal`)
    }
    entry.spawnItemId = spawnItemId
    entry.childThreadId = childThreadId
    entry.childSessionId ??= childSessionId
    entry.state = "spawn_bound"
    this.taskByChild.set(childThreadId, taskId)
    this.append({ event: "review_spawn_bound", ...entry })
    return copy(entry)
  }

  assertLaunchable(taskId: string, role: string, passKind: ReviewPassKind, mode: ReviewAdmission["mode"], prompt: string): ReviewAdmission {
    this.refresh()
    const entry = this.require(taskId)
    if (entry.role !== role || entry.passKind !== passKind || entry.mode !== mode || entry.reference.promptSha256 !== sha256(prompt)) {
      throw new Error(`review task ${taskId} launch identity drift`)
    }
    if (entry.state !== "admitted" || entry.spawnItemId || entry.childThreadId) {
      throw new Error(`review task ${taskId} is not launchable from state ${entry.state}`)
    }
    return copy(entry)
  }

  markTerminalByChild(
    childThreadId: string,
    state: Exclude<ReviewAdmissionState, "admitted" | "spawn_bound">,
    error?: string,
    result?: ReviewResultBinding,
    now?: number,
  ): ReviewAdmission {
    this.refresh()
    const taskId = this.taskByChild.get(childThreadId)
    if (!taskId) throw new Error(`unknown review child ${childThreadId}`)
    return this.markTerminal(taskId, state, error, result, now)
  }

  markTerminal(
    taskId: string,
    state: Exclude<ReviewAdmissionState, "admitted" | "spawn_bound">,
    error?: string,
    result?: ReviewResultBinding,
    now = Date.now(),
  ): ReviewAdmission {
    this.refresh()
    const entry = this.require(taskId)
    if (state === "completed") validateResultBinding(result)
    else if (result) throw new Error(`review task ${taskId} non-completed terminal state cannot carry a result binding`)
    if (terminal(entry.state)) {
      if (entry.state !== state) throw new Error(`review task ${taskId} terminal state drift: ${entry.state} -> ${state}`)
      if (state === "completed" && !sameResult(entry.result, result)) throw new Error(`review task ${taskId} terminal result drift`)
      return copy(entry)
    }
    entry.state = state
    entry.terminalAt = new Date(now).toISOString()
    if (state === "completed" && Date.parse(entry.terminalAt) > Date.parse(entry.deadlineAt)) {
      throw new Error(`review task ${taskId} completed after its deadline`)
    }
    entry.error = error
    entry.result = result ? { ...result } : undefined
    this.append({ event: "review_terminal", ...entry })
    return copy(entry)
  }

  task(taskId: string): ReviewAdmission | undefined {
    this.refresh()
    const entry = this.byTask.get(taskId)
    return entry ? copy(entry) : undefined
  }

  taskForChild(childThreadId: string): ReviewAdmission | undefined {
    this.refresh()
    const taskId = this.taskByChild.get(childThreadId)
    return taskId ? this.task(taskId) : undefined
  }

  entries(): ReviewAdmission[] {
    this.refresh()
    return [...this.byTask.values()].map(copy)
  }

  expired(now = Date.now()): ReviewAdmission[] {
    return this.entries().filter((entry) => !terminal(entry.state) && Date.parse(entry.deadlineAt) <= now)
  }

  assertFinalizable(requireAdmissions: boolean): void {
    this.refresh()
    if (requireAdmissions && this.byTask.size === 0) throw new Error("review finalization requires at least one admitted child task")
    const incomplete = this.entries().filter((entry) => entry.state !== "completed")
    if (incomplete.length) {
      throw new Error(`review finalization blocked by child tasks: ${incomplete.map((entry) => `${entry.taskId}:${entry.state}`).join(", ")}`)
    }
  }

  summary(): Record<string, number> {
    this.refresh()
    const result: Record<string, number> = { total: this.byTask.size }
    for (const entry of this.byTask.values()) result[entry.state] = (result[entry.state] ?? 0) + 1
    return result
  }

  private require(taskId: string): ReviewAdmission {
    const entry = this.byTask.get(taskId)
    if (!entry) throw new Error(`unknown review task ${taskId}`)
    return entry
  }

  private append(value: unknown): void {
    if (this.snapshotRows) throw new Error("cannot mutate an immutable review admission snapshot")
    appendJsonl(this.path, value)
  }

  private replay(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("review admission ledger row must be an object")
    const row = value as Record<string, unknown>
    const taskId = typeof row.taskId === "string" ? row.taskId : ""
    const runId = typeof row.runId === "string" ? row.runId : ""
    if (!taskId || runId !== this.runId) throw new Error("review admission ledger identity mismatch")
    if (row.event === "review_admitted") {
      if (this.byTask.has(taskId) || this.byTask.size >= REVIEW_MAX_TASKS) throw new Error(`duplicate or excessive review admission ${taskId}`)
      const { event: _event, ...payload } = row
      validateAdmissionPayload(payload, this.runId)
      const entry = payload
      this.byTask.set(taskId, copy(entry))
      return
    }
    const entry = this.require(taskId)
    if (row.event === "review_spawn_bound") {
      if (terminal(entry.state)) throw new Error(`review task ${taskId} is already terminal`)
      const childThreadId = typeof row.childThreadId === "string" ? row.childThreadId : ""
      const spawnItemId = typeof row.spawnItemId === "string" ? row.spawnItemId : ""
      if (!childThreadId || !spawnItemId) throw new Error(`review spawn binding ${taskId} is incomplete`)
      const owner = this.taskByChild.get(childThreadId)
      if (owner && owner !== taskId) throw new Error(`review child ${childThreadId} replay ownership drift`)
      if (entry.spawnItemId && entry.spawnItemId !== spawnItemId) throw new Error(`review task ${taskId} replay spawn item drift`)
      if (entry.childThreadId && entry.childThreadId !== childThreadId) throw new Error(`review task ${taskId} replay child thread drift`)
      const childSessionId = typeof row.childSessionId === "string" ? row.childSessionId : undefined
      if (entry.childSessionId && childSessionId && entry.childSessionId !== childSessionId) throw new Error(`review task ${taskId} replay child session drift`)
      entry.spawnItemId = spawnItemId
      entry.childThreadId = childThreadId
      entry.childSessionId ??= childSessionId
      entry.state = "spawn_bound"
      this.taskByChild.set(childThreadId, taskId)
      return
    }
    if (row.event === "review_terminal") {
      const state = row.state as ReviewAdmissionState
      if (!terminal(state)) throw new Error(`review task ${taskId} has invalid terminal state`)
      if (terminal(entry.state) && entry.state !== state) throw new Error(`review task ${taskId} terminal state drift: ${entry.state} -> ${state}`)
      const result = row.result
      if (state === "completed") validateResultBinding(result)
      else if (result != null) throw new Error(`review task ${taskId} non-completed terminal state cannot carry a result binding`)
      if (entry.state === "completed" && !sameResult(entry.result, result as ReviewResultBinding)) throw new Error(`review task ${taskId} terminal result drift`)
      const terminalAt = row.terminalAt
      if (!validIso(terminalAt)) throw new Error(`review task ${taskId} has invalid terminal timestamp`)
      if (state === "completed" && Date.parse(terminalAt) > Date.parse(entry.deadlineAt)) throw new Error(`review task ${taskId} completed after its deadline`)
      entry.state = state
      entry.terminalAt = terminalAt
      entry.error = typeof row.error === "string" ? row.error : undefined
      entry.result = state === "completed" ? { ...(result as ReviewResultBinding) } : undefined
      return
    }
    throw new Error(`unknown review admission ledger event ${String(row.event)}`)
  }
}
