import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  CodexExecRestartError,
  CodexExecTimeoutError,
  startCodexExec,
  type CodexExecHandle,
  type ExecRunOptions,
  type ExecRunResult,
} from "./exec-adapter"
import { ChildGraph, type ChildTerminalState } from "./graph"
import type { ReviewChildExecutor, ReviewResult, ReviewTask } from "./review-runner"
import { isReviewPassKind, type ReviewAdmissionLedger, type ReviewPassKind, type ReviewResultBinding } from "./review-admission"
import { durableWriteFile } from "./durable-file"
import { appendJsonl, readJsonl } from "./jsonl"
import { processIdentity, type ProcessIdentity } from "./run-lock"
import { attachRecordHmac, hasValidRecordHmac, validateRecordHmacKey } from "./authenticated-record"
import { UNLIMITED_DEADLINE_AT } from "./deadlines"

export type ChildState = "queued" | "running" | "completed" | "failed" | "timed_out" | "interrupted" | "lost"

export interface ChildHandle {
  runId: string
  parentRunId: string
  childId: string
  parentId: string
  spawnItemId: string
  generation: number
  role: string
  passKind?: ReviewPassKind
  state: ChildState
  sessionId?: string
  deadlineAt: string
  sandbox: NonNullable<ExecRunOptions["sandbox"]>
  tokenScope: string
  resultPath: string
  attempts: ChildAttemptArtifact[]
  output?: string
  error?: string
  closeReason?: string
  result?: ReviewResultBinding
}

export interface ChildAttemptArtifact {
  attempt: number
  sessionId: string
  state: Exclude<ChildState, "queued" | "running">
  terminal: "completed" | "failed" | "interrupted"
  startedAt: string
  completedAt: string
  output?: string
  error?: string
}

export interface ChildResultArtifact {
  schemaVersion: 2 | 3
  mode: "explicit_child"
  runId: string
  parentRunId: string
  childId: string
  parentId: string
  spawnItemId: string
  generation: number
  role: string
  passKind?: ReviewPassKind
  state: Exclude<ChildState, "queued" | "running">
  sessionId?: string
  deadlineAt: string
  sandbox: NonNullable<ExecRunOptions["sandbox"]>
  tokenScope: string
  output?: string
  error?: string
  closeReason?: string
  attempts: ChildAttemptArtifact[]
  updatedAt: string
}

/** Work identity for a running explicit child. Heartbeat/updatedAt are excluded
 * so liveness writes cannot be mistaken for semantic progress. */
export function explicitChildWorkKey(child: {
  generation: number
  state: string
  sessionId?: string
  attempt?: number
  promptSha256?: string
  activePrompt?: string
  queuedPrompts?: readonly string[]
}): string {
  return [
    String(child.generation),
    child.state,
    child.sessionId ?? "",
    String(child.attempt ?? ""),
    child.promptSha256 ?? child.activePrompt ?? "",
    Array.isArray(child.queuedPrompts) ? child.queuedPrompts.join("\n") : "",
  ].join("\0")
}

export interface ChildRunningArtifact {
  schemaVersion: 5
  mode: "explicit_child"
  kind: "explicit_child_running"
  runId: string
  parentRunId: string
  childId: string
  parentId: string
  spawnItemId: string
  generation: number
  role: string
  passKind?: ReviewPassKind
  state: "queued" | "running"
  sessionId?: string
  deadlineAt: string
  sandbox: NonNullable<ExecRunOptions["sandbox"]>
  tokenScope: string
  resultPath: string
  activePrompt?: string
  activeStartedAt?: string
  queuedPrompts: string[]
  attempts: ChildAttemptArtifact[]
  attempt: number
  pid?: number
  processGroupId?: number
  processIdentity?: ProcessIdentity
  launchState?: "idle" | "prepared" | "checkpointed"
  ownerId: string
  ownerEpoch: number
  resumeState: "initial" | "resuming"
  promptSha256?: string
  heartbeatAt: string
  updatedAt: string
  mac: string
}

export interface ExplicitChildCloseEvent {
  schemaVersion: 1
  event: "explicit_child_closed"
  runId: string
  parentRunId: string
  childId: string
  parentId: string
  spawnItemId: string
  generation: number
  closeReason: string
  closedAt: string
}

export interface ChildAdapterOptions {
  exec: Omit<ExecRunOptions, "prompt">
  childModels?: {
    review: string
    worker: string
  }
  resultRoot: string
  runId?: string
  parentRunId?: string
  tokenScope?: string
  timeoutMs?: number
  maxActive?: number
  unlimited?: boolean
  graph?: ChildGraph
  startExec?: typeof startCodexExec
  admissionLedger?: ReviewAdmissionLedger
  onTerminal?: (handle: ChildHandle) => void
  redactDiagnostic?: (value: string) => string
  /** Controller-only key authorizing durable explicit-child process records. */
  recordHmacKey?: string
}

export type ExplicitChildTask = Omit<ReviewTask, "passKind"> & { passKind?: ReviewPassKind }

interface ChildRecord {
  handle: ChildHandle
  active?: CodexExecHandle
  completion?: Promise<ChildHandle>
  queue: string[]
  attempts: ChildAttemptArtifact[]
  activePrompt?: string
  activeStartedAt?: string
  processIdentity?: ProcessIdentity
  processGroupId?: number
  launchState: "idle" | "prepared" | "checkpointed"
  ownerEpoch: number
  resumeState: "initial" | "resuming"
  restartRequested: boolean
  terminalPublished: boolean
  closed: boolean
  lastRunningWorkKey?: string
  lastRunningUpdatedAt?: string
}

export async function stopProvenProcessGroup(
  recorded: { identity: ProcessIdentity; processGroupId: number },
  options: {
    kill?: (pid: number, signal: NodeJS.Signals | 0) => void
    identify?: (pid: number) => ProcessIdentity
    now?: () => number
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<"absent" | "stopped" | "unproven"> {
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal))
  const identify = options.identify ?? processIdentity
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)))
  const { identity, processGroupId } = recorded
  if (!Number.isSafeInteger(processGroupId) || processGroupId < 1 || processGroupId !== identity.pid) return "unproven"
  const live = (target: number): boolean => {
    try {
      kill(target, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH"
    }
  }
  const target = process.platform === "win32" ? identity.pid : -processGroupId
  const leaderLive = live(identity.pid)
  if (leaderLive) {
    const current = identify(identity.pid)
    if (current.bootId !== identity.bootId || current.startTicks !== identity.startTicks) return "unproven"
  } else if (!live(target)) {
    return "absent"
  }
  for (const [signal, graceMs] of [["SIGINT", 1_000], ["SIGTERM", 1_000], ["SIGKILL", 5_000]] as const) {
    try {
      kill(target, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return "stopped"
      throw error
    }
    const deadline = now() + graceMs
    while (now() < deadline) {
      if (!live(target)) return "stopped"
      await sleep(20)
    }
  }
  return live(target) ? "unproven" : "stopped"
}

function terminalState(state: ChildState): state is Exclude<ChildState, "queued" | "running"> {
  return ["completed", "failed", "timed_out", "interrupted", "lost"].includes(state)
}

function graphState(state: Exclude<ChildState, "queued" | "running">): ChildTerminalState {
  return state
}

function clone(handle: ChildHandle, attempts = handle.attempts): ChildHandle {
  return {
    ...handle,
    attempts: attempts.map((attempt) => ({ ...attempt })),
    ...(handle.result ? { result: { ...handle.result } } : {}),
  }
}

function safeChildId(childId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(childId)) throw new Error(`invalid child id ${childId}`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function restoredAttempts(
  schemaVersion: number,
  attempts: ChildAttemptArtifact[],
): ChildAttemptArtifact[] {
  if (schemaVersion >= 3) return attempts.map((attempt) => ({ ...attempt }))
  return attempts.map(({ output: _output, error: _error, ...attempt }) => attempt)
}

function normalizeArtifactIdentity(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const artifact = value as Record<string, unknown>
  if (artifact.spawnItemId == null && typeof artifact.childId === "string") artifact.spawnItemId = `explicit:${artifact.childId}`
  if (artifact.generation == null) artifact.generation = 1
}

function validateArtifact(value: unknown): asserts value is ChildResultArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("child result artifact must be an object")
  const artifact = value as Partial<ChildResultArtifact>
  if (artifact.schemaVersion !== 2 && artifact.schemaVersion !== 3) throw new Error("unsupported child result artifact schema")
  if (artifact.mode !== "explicit_child") throw new Error("child result artifact has invalid mode")
  for (const field of ["runId", "parentRunId", "childId", "parentId", "spawnItemId", "role", "deadlineAt", "sandbox", "tokenScope", "updatedAt"]) {
    if (typeof artifact[field as keyof ChildResultArtifact] !== "string") throw new Error(`child result artifact missing ${field}`)
  }
  if (!Number.isSafeInteger(artifact.generation) || (artifact.generation ?? 0) < 1) throw new Error("child result artifact has invalid generation")
  if (artifact.passKind !== undefined && !isReviewPassKind(artifact.passKind)) throw new Error("child result artifact has invalid pass kind")
  if (!Array.isArray(artifact.attempts) || artifact.attempts.length < 1) throw new Error("child result artifact has no attempts")
  if (!terminalState(artifact.state as ChildState)) throw new Error("child result artifact has non-terminal state")
  if (artifact.state === "completed" && (typeof artifact.sessionId !== "string" || !artifact.sessionId)) {
    throw new Error("completed child result artifact has no session id")
  }
  if (artifact.state === "completed" && (typeof artifact.output !== "string" || artifact.output.length === 0)) {
    throw new Error("completed child result artifact has no output")
  }
}

function validateRunningArtifact(value: unknown): asserts value is ChildRunningArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("child running artifact must be an object")
  const artifact = value as Partial<ChildRunningArtifact>
  if (artifact.schemaVersion !== 5 || artifact.mode !== "explicit_child" || artifact.kind !== "explicit_child_running") throw new Error("unsupported child running artifact schema")
  for (const field of ["runId", "parentRunId", "childId", "parentId", "spawnItemId", "role", "deadlineAt", "sandbox", "tokenScope", "resultPath", "ownerId", "resumeState", "heartbeatAt", "updatedAt"]) {
    if (typeof artifact[field as keyof ChildRunningArtifact] !== "string") throw new Error(`child running artifact missing ${field}`)
  }
  if (!Number.isSafeInteger(artifact.generation) || (artifact.generation ?? 0) < 1) throw new Error("child running artifact has invalid generation")
  if (artifact.passKind !== undefined && !isReviewPassKind(artifact.passKind)) throw new Error("child running artifact has invalid pass kind")
  if (artifact.state !== "queued" && artifact.state !== "running") throw new Error("child running artifact has invalid state")
  if (!Array.isArray(artifact.queuedPrompts) || !artifact.queuedPrompts.every((prompt) => typeof prompt === "string" && prompt.trim())) throw new Error("child running artifact has invalid queued prompts")
  if (!Array.isArray(artifact.attempts)) throw new Error("child running artifact has invalid attempts")
  if (!Number.isSafeInteger(artifact.attempt) || (artifact.attempt ?? -1) < 1) throw new Error("child running artifact has invalid attempt")
  if (!Number.isSafeInteger(artifact.ownerEpoch) || (artifact.ownerEpoch ?? -1) < 1) throw new Error("child running artifact has invalid owner epoch")
  if (artifact.activePrompt != null && (typeof artifact.activePrompt !== "string" || !artifact.activePrompt.trim())) throw new Error("child running artifact has invalid active prompt")
  if (artifact.state === "running" && artifact.activePrompt == null) throw new Error("running child artifact has no active prompt")
  if (artifact.promptSha256 != null && (typeof artifact.promptSha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.promptSha256))) throw new Error("child running artifact has invalid prompt hash")
  if (artifact.processGroupId != null && (!Number.isSafeInteger(artifact.processGroupId) || artifact.processGroupId < 1)) throw new Error("child running artifact has invalid process group")
  if (artifact.processIdentity && artifact.processGroupId !== artifact.processIdentity.pid) throw new Error("child running artifact process group identity drift")
  if (!["idle", "prepared", "checkpointed"].includes(String(artifact.launchState))) {
    throw new Error("child running artifact has invalid launch state")
  }
  if (artifact.launchState === "prepared" && artifact.processIdentity) throw new Error("prepared child launch already has a process identity")
  if (artifact.launchState === "checkpointed" && !artifact.processIdentity) throw new Error("checkpointed child launch has no process identity")
  if (artifact.launchState === "idle" && artifact.processIdentity) throw new Error("idle child launch has a process identity")
  if (typeof artifact.mac !== "string" || !/^[a-f0-9]{64}$/.test(artifact.mac)) throw new Error("child running artifact has invalid mac")
}

function validateCloseEvent(value: unknown, runId: string): asserts value is ExplicitChildCloseEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("explicit child close event must be an object")
  const event = value as Partial<ExplicitChildCloseEvent>
  if (event.schemaVersion !== 1 || event.event !== "explicit_child_closed" || event.runId !== runId) {
    throw new Error("explicit child close ledger identity mismatch")
  }
  for (const field of ["parentRunId", "childId", "parentId", "spawnItemId", "closeReason", "closedAt"] as const) {
    if (typeof event[field] !== "string" || !event[field]!.trim()) throw new Error(`explicit child close event missing ${field}`)
  }
  safeChildId(event.childId!)
  if (!Number.isSafeInteger(event.generation) || (event.generation ?? 0) < 1) throw new Error("explicit child close event has invalid generation")
  if (!Number.isFinite(Date.parse(event.closedAt!))) throw new Error("explicit child close event has invalid timestamp")
}

export function readExplicitChildCloseEvents(resultRoot: string, runId: string): ExplicitChildCloseEvent[] {
  return readJsonl(resolve(resultRoot, "explicit-close.jsonl")).map((row) => {
    validateCloseEvent(row, runId)
    return row
  })
}

export function readChildResultArtifact(path: string): ChildResultArtifact {
  return parseChildResultArtifact(readFileSync(path, "utf8"))
}

function parseChildResultArtifact(serialized: string): ChildResultArtifact {
  const value: unknown = JSON.parse(serialized)
  normalizeArtifactIdentity(value)
  validateArtifact(value)
  return value
}

export function readChildRunningArtifact(path: string, recordHmacKey: string): ChildRunningArtifact {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"))
  validateRunningArtifact(value)
  if (!hasValidRecordHmac(value as unknown as Record<string, unknown>, recordHmacKey)) {
    throw new Error("child running artifact has an invalid mac")
  }
  return value
}

/** Explicit fallback for a Codex run when native multi-agent v2 is unavailable. */
export class ExplicitChildAdapter implements ReviewChildExecutor {
  private readonly children = new Map<string, ChildRecord>()
  private readonly graph: ChildGraph
  private readonly start: typeof startCodexExec
  private readonly runId: string
  private readonly ownerId = randomUUID()
  private readonly closeLedgerPath: string
  private readonly ready: Promise<void>
  private readonly recordHmacKey: string

  constructor(private readonly options: ChildAdapterOptions) {
    const maxActive = options.maxActive ?? 10
    if (!options.unlimited && (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 10)) {
      throw new Error("explicit child maxActive must be an integer between 1 and 10")
    }
    mkdirSync(options.resultRoot, { recursive: true, mode: 0o700 })
    this.runId = options.runId ?? `explicit-${Date.now()}`
    this.recordHmacKey = validateRecordHmacKey(options.recordHmacKey ?? process.env.CCHP_PROCESS_RECORD_HMAC_KEY)
    this.closeLedgerPath = resolve(options.resultRoot, "explicit-close.jsonl")
    this.graph = options.graph ?? new ChildGraph(join(options.resultRoot, "graph.jsonl"))
    this.start = options.startExec ?? startCodexExec
    for (const entry of readdirSync(options.resultRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(".running.json") || entry.name.endsWith(".native.json")) continue
      const resultPath = resolve(options.resultRoot, entry.name)
      const serialized = readFileSync(resultPath, "utf8")
      const artifact = parseChildResultArtifact(serialized)
      const attempts = restoredAttempts(artifact.schemaVersion, artifact.attempts)
      if (artifact.runId !== this.runId) throw new Error(`child artifact ${entry.name} belongs to another run`)
      safeChildId(artifact.childId)
      if (resultPath !== resolve(options.resultRoot, `${artifact.childId}.json`)) throw new Error(`child artifact ${entry.name} has an unsafe result path`)
      const result: ReviewResultBinding | undefined = artifact.state === "completed"
        ? {
            schemaVersion: 1,
            artifactPath: resultPath,
            artifactSha256: createHash("sha256").update(serialized).digest("hex"),
            outputSha256: createHash("sha256").update(artifact.output ?? "").digest("hex"),
            outputBytes: Buffer.byteLength(artifact.output ?? ""),
          }
        : undefined
      options.admissionLedger?.markTerminal(
        artifact.childId,
        artifact.state,
        artifact.schemaVersion >= 3 ? artifact.error : "legacy child artifact diagnostics withheld",
        result,
        Date.parse(artifact.updatedAt),
      )
      this.children.set(artifact.childId, {
        handle: {
          runId: artifact.runId,
          parentRunId: artifact.parentRunId,
          childId: artifact.childId,
          parentId: artifact.parentId,
          spawnItemId: artifact.spawnItemId,
          generation: artifact.generation,
          role: artifact.role,
          ...(artifact.passKind ? { passKind: artifact.passKind } : {}),
          state: artifact.state,
          sessionId: artifact.sessionId,
          deadlineAt: artifact.deadlineAt,
          sandbox: artifact.sandbox,
          tokenScope: artifact.tokenScope,
          resultPath,
          attempts,
          output: artifact.schemaVersion >= 3 ? artifact.output : undefined,
          error: artifact.schemaVersion >= 3 ? artifact.error : undefined,
          closeReason: artifact.closeReason,
          ...(result ? { result } : {}),
        },
        queue: [],
        attempts,
        ownerEpoch: 1,
        resumeState: "initial",
        launchState: "idle",
        restartRequested: false,
        terminalPublished: true,
        closed: Boolean(artifact.closeReason),
      })
    }
    const recover: ChildRecord[] = []
    for (const entry of readdirSync(options.resultRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".running.json")) continue
      const runningPath = join(options.resultRoot, entry.name)
      const artifact = readChildRunningArtifact(runningPath, this.recordHmacKey)
      const attempts = restoredAttempts(artifact.schemaVersion, artifact.attempts)
      if (artifact.runId !== this.runId) throw new Error(`child running artifact ${entry.name} belongs to another run`)
      safeChildId(artifact.childId)
      const expectedResultPath = resolve(options.resultRoot, `${artifact.childId}.json`)
      if (resolve(artifact.resultPath) !== expectedResultPath) throw new Error(`child running artifact ${entry.name} has an unsafe result path`)
      if (this.children.has(artifact.childId)) {
        const existing = this.children.get(artifact.childId)!
        if (artifact.generation <= existing.handle.generation) {
          rmSync(runningPath, { force: true })
          continue
        }
        if (artifact.generation !== existing.handle.generation + 1) throw new Error(`child ${artifact.childId} has a non-contiguous generation`)
        this.children.delete(artifact.childId)
      }
      const record: ChildRecord = {
        handle: {
          runId: artifact.runId,
          parentRunId: artifact.parentRunId,
          childId: artifact.childId,
          parentId: artifact.parentId,
          spawnItemId: artifact.spawnItemId,
          generation: artifact.generation,
          role: artifact.role,
          ...(artifact.passKind ? { passKind: artifact.passKind } : {}),
          state: artifact.state,
          sessionId: artifact.sessionId,
          deadlineAt: artifact.deadlineAt,
          sandbox: artifact.sandbox,
          tokenScope: artifact.tokenScope,
          resultPath: expectedResultPath,
          attempts,
        },
        queue: [...artifact.queuedPrompts],
        attempts,
        activePrompt: artifact.activePrompt,
        activeStartedAt: artifact.activeStartedAt,
        processIdentity: artifact.processIdentity,
        processGroupId: artifact.processGroupId ?? artifact.processIdentity?.pid,
        launchState: artifact.launchState ?? (artifact.processIdentity ? "checkpointed" : "idle"),
        ownerEpoch: artifact.ownerEpoch,
        resumeState: artifact.resumeState,
        restartRequested: false,
        terminalPublished: false,
        closed: false,
      }
      this.children.set(artifact.childId, record)
      recover.push(record)
    }
    this.overlayCloseEvents(readExplicitChildCloseEvents(options.resultRoot, this.runId))
    this.ready = this.recoverOpenChildren(recover.filter((record) => !record.closed))
  }

  async spawn(parentId: string, task: ExplicitChildTask): Promise<ChildHandle> {
    await this.ready
    safeChildId(task.id)
    if (this.children.has(task.id)) throw new Error(`child ${task.id} already exists`)
    const active = [...this.children.values()].filter((record) => !record.closed && !terminalState(record.handle.state)).length
    if (!this.options.unlimited && active >= (this.options.maxActive ?? 10)) throw new Error(`explicit child concurrency limit exceeded: ${this.options.maxActive ?? 10}`)
    const parentRunId = this.options.parentRunId ?? this.runId
    const resultPath = resolve(this.options.resultRoot, `${task.id}.json`)
    const spawnItemId = `explicit:${task.id}`
    const admission = this.options.admissionLedger?.task(task.id)
    if (this.options.admissionLedger && !admission) throw new Error(`review child ${task.id} has no admission`)
    if (this.options.admissionLedger && !task.passKind) throw new Error(`review child ${task.id} requires pass kind`)
    if (this.options.admissionLedger && task.passKind) {
      this.options.admissionLedger.assertLaunchable(task.id, task.role, task.passKind, "explicit_child", task.admissionPrompt ?? task.prompt)
    }
    const deadlineAt = admission?.deadlineAt ?? (this.options.unlimited
      ? UNLIMITED_DEADLINE_AT
      : new Date(Date.now() + (this.options.timeoutMs ?? this.options.exec.timeoutMs ?? 1_800_000)).toISOString())
    const handle: ChildHandle = {
      runId: this.runId,
      parentRunId,
      childId: task.id,
      parentId,
      spawnItemId,
      generation: 1,
      role: task.role,
      ...(task.passKind ? { passKind: task.passKind } : {}),
      state: "queued",
      deadlineAt,
      sandbox: this.options.exec.sandbox ?? "read-only",
      tokenScope: this.options.tokenScope ?? "child",
      resultPath,
      attempts: [],
    }
    const record: ChildRecord = {
      handle,
      queue: [],
      attempts: [],
      ownerEpoch: 1,
      resumeState: "initial",
      launchState: "idle",
      restartRequested: false,
      terminalPublished: false,
      closed: false,
    }
    this.children.set(task.id, record)
    this.graph.open(parentId, task.id, spawnItemId, "explicit_child")
    this.persistRunning(record)
    try {
      await this.launch(record, task.prompt, false)
      return clone(record.handle, record.attempts)
    } catch (error) {
      await record.completion?.catch(() => undefined)
      throw error
    }
  }

  async sendMessage(childId: string, prompt: string): Promise<ChildHandle> {
    await this.ready
    const record = this.require(childId)
    if (record.closed) throw new Error(`child ${childId} is closed`)
    if (record.handle.state !== "running" || !record.active) throw new Error(`child ${childId} is not active`)
    if (!prompt.trim()) throw new Error("child message must be non-empty")
    record.queue.push(prompt)
    this.persistRunning(record)
    return clone(record.handle, record.attempts)
  }

  async followupTask(childId: string, prompt: string): Promise<ChildHandle> {
    await this.ready
    const record = this.require(childId)
    if (record.closed) throw new Error(`child ${childId} is closed`)
    if (!terminalState(record.handle.state)) throw new Error(`child ${childId} must be terminal before followup`)
    if (!prompt.trim()) throw new Error("child followup must be non-empty")
    if (!record.handle.sessionId) throw new Error(`child ${childId} has no resumable session`)
    const edge = this.graph.reopen(childId)
    record.handle.generation = edge.generation
    record.handle.result = undefined
    record.terminalPublished = false
    await this.launch(record, prompt, true)
    return this.waitAgent(childId)
  }

  async waitAgent(childId: string, timeoutMs = this.options.timeoutMs ?? 1_800_000): Promise<ChildHandle> {
    await this.ready
    if (!this.options.unlimited && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) throw new Error("wait timeout must be a positive integer")
    const record = this.require(childId)
    const completion = record.completion
    if (completion && (!terminalState(record.handle.state) || record.active)) {
      if (this.options.unlimited) await completion
      else await Promise.race([
          completion,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`child ${childId} wait exceeded ${timeoutMs}ms`)), timeoutMs)),
        ])
    }
    return clone(record.handle, record.attempts)
  }

  async interruptAgent(childId: string): Promise<void> {
    await this.ready
    const record = this.require(childId)
    if (record.handle.state !== "running" || !record.active) return
    await record.active.interrupt()
    await record.completion?.catch(() => undefined)
    if (record.handle.state === "running") {
      record.handle.state = "interrupted"
      this.finishGraph(record)
      this.persist(record)
    }
  }

  async closeAgent(childId: string, reason = "closed"): Promise<void> {
    await this.ready
    const record = this.require(childId)
    if (record.closed) return
    if (!reason.trim()) throw new Error("child close reason must be non-empty")
    if (record.handle.state === "running") await this.interruptAgent(childId)
    if (!terminalState(record.handle.state)) {
      record.handle.state = "lost"
      record.handle.error = reason
      this.finishGraph(record)
      this.persist(record)
    }
    this.finishGraph(record)
    this.appendCloseEvent(record, reason)
    record.handle.closeReason = reason
    record.closed = true
  }

  listAgents(): ChildHandle[] {
    return [...this.children.values()].map((record) => clone(record.handle, record.attempts))
  }

  async shutdown(reason = "adapter shutdown"): Promise<void> {
    await this.ready
    const results = await Promise.allSettled(
      [...this.children.values()]
        .filter((record) => !record.closed && !terminalState(record.handle.state))
        .map((record) => this.closeAgent(record.handle.childId, reason)),
    )
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, "one or more explicit children failed to shut down")
  }

  /** Stop local `codex exec` process groups while keeping a durable running
   * record that a replacement MCP server can resume on the same session. */
  async prepareRestart(): Promise<void> {
    await this.ready
    const running = [...this.children.values()].filter((record) => record.handle.state === "running" && record.active)
    for (const record of running) {
      record.restartRequested = true
      this.persistRunning(record)
    }
    const results = await Promise.allSettled(running.map(async (record) => {
      await record.active!.detachForRestart()
      await record.completion
    }))
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, "one or more explicit children failed to detach for restart")
  }

  /** Adapter-compatible executor used by ReviewRunner. */
  async run(input: { task: ReviewTask; prompt: string; signal: AbortSignal }): Promise<{ sessionId?: string; output: string }> {
    if (input.signal.aborted) throw new Error("review child aborted")
    const parentId = this.options.parentRunId ?? this.runId
    const childId = input.task.id
    let abortRequested = false
    let interrupting: Promise<void> | undefined
    const requestAbort = () => {
      abortRequested = true
      const record = this.children.get(childId)
      if (!record || record.handle.state !== "running" || !record.active || interrupting) return
      interrupting = this.interruptAgent(childId)
      void interrupting.catch(() => undefined)
    }
    const onAbort = () => requestAbort()
    input.signal.addEventListener("abort", onAbort, { once: true })
    try {
      if (input.signal.aborted) {
        requestAbort()
        throw new Error("review child aborted")
      }
      const spawned = await this.spawn(parentId, { ...input.task, prompt: input.prompt })
      if (abortRequested || input.signal.aborted) {
        requestAbort()
        await interrupting
        throw new Error("review child aborted")
      }
      const result = await this.waitAgent(spawned.childId)
      if (abortRequested || input.signal.aborted) {
        await interrupting
        throw new Error("review child aborted")
      }
      if (result.state !== "completed") throw new Error(result.error ?? `child ${result.childId} ended ${result.state}`)
      return { sessionId: result.sessionId, output: result.output ?? "" }
    } finally {
      input.signal.removeEventListener("abort", onAbort)
      await interrupting?.catch(() => undefined)
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const child = [...this.children.values()].find((candidate) => candidate.handle.sessionId === sessionId)
    if (child) await this.interruptAgent(child.handle.childId)
  }

  private require(childId: string): ChildRecord {
    const record = this.children.get(childId)
    if (!record) throw new Error(`unknown child ${childId}`)
    return record
  }

  private async recoverOpenChildren(records: ChildRecord[]): Promise<void> {
    await Promise.all(records.map(async (record) => {
      record.ownerEpoch += 1
      const processState = record.launchState === "idle"
        ? "absent"
        : record.launchState === "prepared"
          ? "unproven"
          : await this.stopRecordedProcess(record)
      if (processState === "unproven") {
        this.markRecoveryLostPreservingMarker(record, "could not prove ownership of the previous explicit child process")
        return
      }
      const remainingMs = Date.parse(record.handle.deadlineAt) - Date.now()
      if (!this.options.unlimited && (!Number.isFinite(remainingMs) || remainingMs <= 0)) {
        this.markRecoveryTerminal(record, "timed_out", "absolute review admission deadline exceeded during restart recovery")
        return
      }
      if (record.launchState !== "idle") {
        this.markRecoveryTerminal(record, "lost", "explicit child crashed after launch checkpoint; refusing to replay its prompt")
        return
      }
      if (record.handle.state !== "running" || !record.handle.sessionId || !record.activePrompt) {
        this.markRecoveryTerminal(record, "lost", "explicit child crashed before a durable Codex session resume point")
        return
      }
      record.processIdentity = undefined
      record.processGroupId = undefined
      record.launchState = "idle"
      record.resumeState = "resuming"
      try {
        await this.launch(record, record.activePrompt, true)
      } catch {
        await record.completion?.catch(() => undefined)
      }
    }))
  }

  private markRecoveryLostPreservingMarker(record: ChildRecord, error: string): void {
    record.handle.state = "lost"
    record.handle.error = error
    record.attempts.push({
      attempt: record.attempts.length + 1,
      sessionId: record.handle.sessionId ?? "unknown",
      state: "lost",
      terminal: "failed",
      startedAt: record.activeStartedAt ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error,
    })
    this.finishGraph(record)
  }

  private markRecoveryTerminal(record: ChildRecord, state: "timed_out" | "lost", error: string): void {
    record.handle.state = state
    record.handle.error = error
    record.attempts.push({
      attempt: record.attempts.length + 1,
      sessionId: record.handle.sessionId ?? "unknown",
      state,
      terminal: "failed",
      startedAt: record.activeStartedAt ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error,
    })
    record.activePrompt = undefined
    record.activeStartedAt = undefined
    record.processIdentity = undefined
    record.processGroupId = undefined
    record.launchState = "idle"
    this.finishGraph(record)
    this.persist(record)
  }

  private async stopRecordedProcess(record: ChildRecord): Promise<"absent" | "stopped" | "unproven"> {
    const identity = record.processIdentity
    if (!identity) return record.launchState === "prepared" ? "unproven" : "absent"
    return stopProvenProcessGroup({ identity, processGroupId: record.processGroupId ?? identity.pid })
  }

  private runningPath(record: ChildRecord): string {
    return resolve(this.options.resultRoot, `${record.handle.childId}.running.json`)
  }

  private persistRunning(record: ChildRecord): void {
    if (terminalState(record.handle.state)) return
    const now = new Date().toISOString()
    const workKey = explicitChildWorkKey({
      generation: record.handle.generation,
      state: record.handle.state,
      sessionId: record.handle.sessionId,
      attempt: record.attempts.length + 1,
      activePrompt: record.activePrompt,
      queuedPrompts: record.queue,
    })
    const updatedAt = record.lastRunningWorkKey === workKey && record.lastRunningUpdatedAt
      ? record.lastRunningUpdatedAt
      : now
    record.lastRunningWorkKey = workKey
    record.lastRunningUpdatedAt = updatedAt
    const artifact = attachRecordHmac({
      schemaVersion: 5 as const,
      mode: "explicit_child" as const,
      kind: "explicit_child_running" as const,
      runId: record.handle.runId,
      parentRunId: record.handle.parentRunId,
      childId: record.handle.childId,
      parentId: record.handle.parentId,
      spawnItemId: record.handle.spawnItemId,
      generation: record.handle.generation,
      role: record.handle.role,
      ...(record.handle.passKind ? { passKind: record.handle.passKind } : {}),
      state: record.handle.state,
      ...(record.handle.sessionId ? { sessionId: record.handle.sessionId } : {}),
      deadlineAt: record.handle.deadlineAt,
      sandbox: record.handle.sandbox,
      tokenScope: record.handle.tokenScope,
      resultPath: record.handle.resultPath,
      ...(record.activePrompt ? { activePrompt: record.activePrompt, promptSha256: createHash("sha256").update(record.activePrompt).digest("hex") } : {}),
      ...(record.activeStartedAt ? { activeStartedAt: record.activeStartedAt } : {}),
      queuedPrompts: [...record.queue],
      attempts: [...record.attempts],
      attempt: record.attempts.length + 1,
      ...(record.processIdentity ? {
        pid: record.processIdentity.pid,
        processGroupId: record.processGroupId ?? record.processIdentity.pid,
        processIdentity: { ...record.processIdentity },
      } : {}),
      launchState: record.launchState,
      ownerId: this.ownerId,
      ownerEpoch: record.ownerEpoch,
      resumeState: record.resumeState,
      heartbeatAt: now,
      updatedAt,
    }, this.recordHmacKey)
    validateRunningArtifact(artifact)
    durableWriteFile(this.runningPath(record), `${JSON.stringify(artifact, null, 2)}\n`)
  }

  private async launch(record: ChildRecord, prompt: string, resume: boolean, queued = false): Promise<void> {
    let firstStarted: CodexExecHandle["started"] | undefined
    const completion = this.runLifecycle(record, prompt, resume, queued, (started) => {
      firstStarted ??= started
    })
    record.completion = completion
    if (!firstStarted) {
      await completion
      return
    }
    try {
      await firstStarted
    } catch (error) {
      await completion.catch(() => undefined)
      const message = (this.options.redactDiagnostic ?? ((value: string) => value))(errorMessage(error))
      throw new Error(message)
    }
  }

  /** Owns one complete child generation, including every prompt queued while
   * the active attempt is running. The public completion promise is assigned
   * once per generation and is never replaced during an attempt handoff. */
  private async runLifecycle(
    record: ChildRecord,
    initialPrompt: string,
    initialResume: boolean,
    initialQueued: boolean,
    onFirstStarted: (started: CodexExecHandle["started"]) => void,
  ): Promise<ChildHandle> {
    let prompt = initialPrompt
    let resume = initialResume
    let queued = initialQueued
    while (true) {
      const remainingMs = Date.parse(record.handle.deadlineAt) - Date.now()
      if (!this.options.unlimited && (!Number.isFinite(remainingMs) || remainingMs <= 0)) {
        record.handle.state = "timed_out"
        record.handle.error = "absolute review admission deadline exceeded before launch"
        this.finishGraph(record)
        this.persist(record)
        throw new Error(record.handle.error)
      }
      record.handle.state = "running"
      record.handle.error = undefined
      record.handle.output = undefined
      record.activePrompt = prompt
      record.activeStartedAt = new Date().toISOString()
      record.resumeState = resume ? "resuming" : "initial"
      record.launchState = "prepared"
      record.processIdentity = undefined
      record.processGroupId = undefined
      if (queued) {
        if (record.queue[0] !== prompt) throw new Error(`child ${record.handle.childId} queued prompt drift`)
        record.queue.shift()
      }
      this.persistRunning(record)
      let exec: CodexExecHandle | undefined
      let checkpointTask: Promise<void> | undefined
      const checkpointLaunch = (pid: number): Promise<void> => checkpointTask ??= (async () => {
        if (record.launchState !== "prepared") throw new Error(`child ${record.handle.childId} launch checkpoint state drift`)
        const identity = processIdentity(pid)
        if (identity.pid !== pid) throw new Error(`child ${record.handle.childId} launch identity drift`)
        record.processIdentity = identity
        record.processGroupId = pid
        record.launchState = "checkpointed"
        this.persistRunning(record)
      })()
      try {
        exec = this.start({
          ...this.options.exec,
          model: this.modelForRole(record.handle.role),
          profile: this.profileForRole(record.handle.role),
          prompt,
          env: { ...this.options.exec.env, CCHP_EXPLICIT_AGENT_DEPTH: "1" },
          ...(resume ? { resumeSessionId: record.handle.sessionId } : {}),
          ...(this.options.unlimited ? { unlimited: true } : { timeoutMs: Math.max(1, remainingMs) }),
          beforeExec: checkpointLaunch,
        })
        record.active = exec
        // Register the public startup promise before the first await. The
        // launcher cannot resolve it until the durable checkpoint releases the
        // exec barrier, so this preserves both crash safety and spawn semantics.
        onFirstStarted(exec.started)
        await (checkpointTask ?? checkpointLaunch(exec.pid))
      } catch (error) {
        await exec?.completed.catch(() => undefined)
        const message = (this.options.redactDiagnostic ?? ((value: string) => value))(errorMessage(error))
        record.handle.state = "failed"
        record.handle.error = message
        record.attempts.push({
          attempt: record.attempts.length + 1,
          sessionId: record.handle.sessionId ?? "unknown",
          state: "failed",
          terminal: "failed",
          startedAt: record.activeStartedAt,
          completedAt: new Date().toISOString(),
          error: message,
        })
        record.activePrompt = undefined
        record.activeStartedAt = undefined
        record.processIdentity = undefined
        record.processGroupId = undefined
        record.launchState = "idle"
        this.finishGraph(record)
        this.persist(record)
        throw new Error(message)
      }
      if (!exec) throw new Error(`child ${record.handle.childId} launch handle is unavailable`)
      const startedAt = record.activeStartedAt
      let detachedForRestart = false
      try {
        const started = await exec.started
        if (record.handle.sessionId && record.handle.sessionId !== started.sessionId) {
          throw new Error(`child ${record.handle.childId} resume changed session id`)
        }
        record.handle.sessionId = started.sessionId
        this.options.admissionLedger?.bind(
          record.handle.childId,
          record.handle.spawnItemId,
          started.sessionId,
          started.sessionId,
        )
        this.persistRunning(record)
        const result = await exec.completed
        this.applyResult(record, result, startedAt)
      } catch (error) {
        if (error instanceof CodexExecRestartError && record.restartRequested) {
          detachedForRestart = true
          record.restartRequested = false
          record.handle.state = "running"
          record.handle.error = undefined
        } else {
        const message = (this.options.redactDiagnostic ?? ((value: string) => value))(errorMessage(error))
        const state: Exclude<ChildState, "queued" | "running"> = error instanceof CodexExecTimeoutError
          ? "timed_out"
          : record.active === exec && record.handle.state === "running" && message.includes("interrupt")
            ? "interrupted"
            : "failed"
        record.handle.state = state
        record.handle.error = message
        record.attempts.push({
          attempt: record.attempts.length + 1,
          sessionId: record.handle.sessionId ?? "unknown",
          state,
          terminal: state === "interrupted" ? "interrupted" : "failed",
          startedAt,
          completedAt: new Date().toISOString(),
          error: message,
        })
        }
      } finally {
        if (record.active === exec) record.active = undefined
        record.processIdentity = undefined
        record.processGroupId = undefined
        record.launchState = "idle"
      }

      if (detachedForRestart) {
        this.persistRunning(record)
        return clone(record.handle, record.attempts)
      }
      record.activePrompt = undefined
      record.activeStartedAt = undefined
      if (!record.closed && record.queue.length > 0 && ["completed", "interrupted"].includes(record.handle.state)) {
        prompt = record.queue[0]!
        resume = true
        queued = true
        continue
      }
      if (!record.closed) this.finishGraph(record)
      this.persist(record)
      return clone(record.handle, record.attempts)
    }
  }

  private modelForRole(role: string): string | undefined {
    const models = this.options.childModels
    if (!models) return undefined
    return ["reviewer", "explorer", "review_shard", "correctness", "verifier", "security", "tests", "docs"].includes(role)
      ? models.review
      : models.worker
  }

  private profileForRole(role: string): string {
    const profiles = new Set(["reviewer", "explorer", "planner", "implementer", "default", "worker"])
    if (!profiles.has(role)) throw new Error(`unsupported explicit child role ${role}`)
    return role
  }

  private applyResult(record: ChildRecord, result: ExecRunResult, startedAt: string): void {
    const redact = this.options.redactDiagnostic ?? ((value: string) => value)
    const lastMessage = typeof result.lastMessage === "string" ? redact(result.lastMessage) : undefined
    const completedWithOutput = result.terminal === "completed" && Boolean(lastMessage)
    const state: Exclude<ChildState, "queued" | "running"> = completedWithOutput
      ? "completed"
      : result.terminal === "interrupted"
        ? "interrupted"
        : "failed"
    record.handle.state = state
    record.handle.output = lastMessage
    record.handle.error = state === "completed"
      ? undefined
      : result.terminal === "completed"
        ? "codex exec completed without a final message"
        : result.stderr ? redact(result.stderr) : `codex exec exited ${result.exitCode}`
    record.attempts.push({
      attempt: record.attempts.length + 1,
      sessionId: result.sessionId,
      state,
      terminal: result.terminal === "completed" && !completedWithOutput ? "failed" : result.terminal,
      startedAt,
      completedAt: new Date().toISOString(),
      ...(lastMessage ? { output: lastMessage } : {}),
      ...(record.handle.error ? { error: record.handle.error } : {}),
    })
  }

  private finishGraph(record: ChildRecord): void {
    const edge = this.graph.edge(record.handle.childId)
    if (edge?.state === "open" && terminalState(record.handle.state)) this.graph.close(record.handle.childId, graphState(record.handle.state))
  }

  private overlayCloseEvents(events: ExplicitChildCloseEvent[]): void {
    const seen = new Map<string, ExplicitChildCloseEvent>()
    for (const event of events) {
      const key = `${event.childId}\0${event.generation}`
      const prior = seen.get(key)
      if (prior) {
        if (
          prior.parentRunId !== event.parentRunId || prior.parentId !== event.parentId ||
          prior.spawnItemId !== event.spawnItemId || prior.closeReason !== event.closeReason
        ) throw new Error(`explicit child ${event.childId} close identity drift`)
        continue
      }
      seen.set(key, event)
      const record = this.children.get(event.childId)
      if (!record) throw new Error(`explicit child close event has no artifact for ${event.childId}`)
      if (event.generation < record.handle.generation) continue
      if (event.generation > record.handle.generation) throw new Error(`explicit child ${event.childId} close generation is ahead of its artifact`)
      if (
        event.parentRunId !== record.handle.parentRunId || event.parentId !== record.handle.parentId ||
        event.spawnItemId !== record.handle.spawnItemId
      ) throw new Error(`explicit child ${event.childId} close identity drift`)
      if (!terminalState(record.handle.state)) throw new Error(`explicit child ${event.childId} close event conflicts with an active artifact`)
      if (record.handle.closeReason && record.handle.closeReason !== event.closeReason) {
        throw new Error(`explicit child ${event.childId} close reason drift`)
      }
      record.handle.closeReason = event.closeReason
      record.closed = true
    }
  }

  private appendCloseEvent(record: ChildRecord, closeReason: string): void {
    const event: ExplicitChildCloseEvent = {
      schemaVersion: 1,
      event: "explicit_child_closed",
      runId: record.handle.runId,
      parentRunId: record.handle.parentRunId,
      childId: record.handle.childId,
      parentId: record.handle.parentId,
      spawnItemId: record.handle.spawnItemId,
      generation: record.handle.generation,
      closeReason,
      closedAt: new Date().toISOString(),
    }
    validateCloseEvent(event, this.runId)
    appendJsonl(this.closeLedgerPath, event)
  }

  private persist(record: ChildRecord): void {
    if (!terminalState(record.handle.state)) {
      this.persistRunning(record)
      return
    }
    const artifact: ChildResultArtifact = {
      schemaVersion: 3,
      mode: "explicit_child",
      runId: record.handle.runId,
      parentRunId: record.handle.parentRunId,
      childId: record.handle.childId,
      parentId: record.handle.parentId,
      spawnItemId: record.handle.spawnItemId,
      generation: record.handle.generation,
      role: record.handle.role,
      ...(record.handle.passKind ? { passKind: record.handle.passKind } : {}),
      state: record.handle.state,
      ...(record.handle.sessionId ? { sessionId: record.handle.sessionId } : {}),
      deadlineAt: record.handle.deadlineAt,
      sandbox: record.handle.sandbox,
      tokenScope: record.handle.tokenScope,
      ...(record.handle.output ? { output: record.handle.output } : {}),
      ...(record.handle.error ? { error: record.handle.error } : {}),
      ...(record.handle.closeReason ? { closeReason: record.handle.closeReason } : {}),
      attempts: record.attempts,
      updatedAt: new Date().toISOString(),
    }
    validateArtifact(artifact)
    if (record.handle.state !== "completed" || !record.handle.result) {
      const serialized = `${JSON.stringify(artifact, null, 2)}\n`
      durableWriteFile(record.handle.resultPath, serialized)
      if (record.handle.state === "completed") {
        const output = record.handle.output ?? ""
        record.handle.result = {
          schemaVersion: 1,
          artifactPath: record.handle.resultPath,
          artifactSha256: createHash("sha256").update(serialized).digest("hex"),
          outputSha256: createHash("sha256").update(output).digest("hex"),
          outputBytes: Buffer.byteLength(output),
        }
      }
    }
    if (!record.terminalPublished) {
      this.options.admissionLedger?.markTerminal(
        record.handle.childId,
        record.handle.state,
        record.handle.error,
        record.handle.result,
      )
      this.options.onTerminal?.(clone(record.handle, record.attempts))
      record.terminalPublished = true
    }
    // The running marker is the cross-process commit fence. Keep it visible
    // until the review ledger has durably bound the terminal artifact, so the
    // supervisor cannot observe a completed child before review admission does.
    rmSync(this.runningPath(record), { force: true })
  }
}
