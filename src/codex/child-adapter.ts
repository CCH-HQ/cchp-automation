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
import { processIdentity, type ProcessIdentity } from "./run-lock"

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
  schemaVersion: 2
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

export interface ChildRunningArtifact {
  schemaVersion: 2
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
  ownerId: string
  ownerEpoch: number
  resumeState: "initial" | "resuming"
  promptSha256?: string
  heartbeatAt: string
  updatedAt: string
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
  graph?: ChildGraph
  startExec?: typeof startCodexExec
  admissionLedger?: ReviewAdmissionLedger
  onTerminal?: (handle: ChildHandle) => void
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
  ownerEpoch: number
  resumeState: "initial" | "resuming"
  restartRequested: boolean
  terminalPublished: boolean
  closed: boolean
}

function terminalState(state: ChildState): state is Exclude<ChildState, "queued" | "running"> {
  return ["completed", "failed", "timed_out", "interrupted", "lost"].includes(state)
}

function graphState(state: Exclude<ChildState, "queued" | "running">): ChildTerminalState {
  return state
}

function clone(handle: ChildHandle): ChildHandle {
  return { ...handle, ...(handle.result ? { result: { ...handle.result } } : {}) }
}

function safeChildId(childId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(childId)) throw new Error(`invalid child id ${childId}`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  if (artifact.schemaVersion !== 2) throw new Error("unsupported child result artifact schema")
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
  if (artifact.schemaVersion !== 2 || artifact.mode !== "explicit_child" || artifact.kind !== "explicit_child_running") throw new Error("unsupported child running artifact schema")
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

export function readChildRunningArtifact(path: string): ChildRunningArtifact {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"))
  normalizeArtifactIdentity(value)
  validateRunningArtifact(value)
  return value
}

/** Explicit fallback for a Codex run when native multi-agent v2 is unavailable. */
export class ExplicitChildAdapter implements ReviewChildExecutor {
  private readonly children = new Map<string, ChildRecord>()
  private readonly graph: ChildGraph
  private readonly start: typeof startCodexExec
  private readonly runId: string
  private readonly ownerId = randomUUID()
  private readonly ready: Promise<void>

  constructor(private readonly options: ChildAdapterOptions) {
    const maxActive = options.maxActive ?? 10
    if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 10) {
      throw new Error("explicit child maxActive must be an integer between 1 and 10")
    }
    mkdirSync(options.resultRoot, { recursive: true, mode: 0o700 })
    this.runId = options.runId ?? `explicit-${Date.now()}`
    this.graph = options.graph ?? new ChildGraph(join(options.resultRoot, "graph.jsonl"))
    this.start = options.startExec ?? startCodexExec
    for (const entry of readdirSync(options.resultRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(".running.json") || entry.name.endsWith(".native.json")) continue
      const resultPath = resolve(options.resultRoot, entry.name)
      const serialized = readFileSync(resultPath, "utf8")
      const artifact = parseChildResultArtifact(serialized)
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
        artifact.error,
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
          output: artifact.output,
          error: artifact.error,
          closeReason: artifact.closeReason,
          ...(result ? { result } : {}),
        },
        queue: [],
        attempts: [...artifact.attempts],
        ownerEpoch: 1,
        resumeState: "initial",
        restartRequested: false,
        terminalPublished: true,
        closed: Boolean(artifact.closeReason),
      })
    }
    const recover: ChildRecord[] = []
    for (const entry of readdirSync(options.resultRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".running.json")) continue
      const runningPath = join(options.resultRoot, entry.name)
      const artifact = readChildRunningArtifact(runningPath)
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
        },
        queue: [...artifact.queuedPrompts],
        attempts: [...artifact.attempts],
        activePrompt: artifact.activePrompt,
        activeStartedAt: artifact.activeStartedAt,
        processIdentity: artifact.processIdentity,
        ownerEpoch: artifact.ownerEpoch,
        resumeState: artifact.resumeState,
        restartRequested: false,
        terminalPublished: false,
        closed: false,
      }
      this.children.set(artifact.childId, record)
      recover.push(record)
    }
    this.ready = this.recoverOpenChildren(recover)
  }

  async spawn(parentId: string, task: ExplicitChildTask): Promise<ChildHandle> {
    await this.ready
    safeChildId(task.id)
    if (this.children.has(task.id)) throw new Error(`child ${task.id} already exists`)
    const active = [...this.children.values()].filter((record) => !record.closed && !terminalState(record.handle.state)).length
    if (active >= (this.options.maxActive ?? 10)) throw new Error(`explicit child concurrency limit exceeded: ${this.options.maxActive ?? 10}`)
    const parentRunId = this.options.parentRunId ?? this.runId
    const resultPath = resolve(this.options.resultRoot, `${task.id}.json`)
    const spawnItemId = `explicit:${task.id}`
    const admission = this.options.admissionLedger?.task(task.id)
    if (this.options.admissionLedger && !admission) throw new Error(`review child ${task.id} has no admission`)
    if (this.options.admissionLedger && !task.passKind) throw new Error(`review child ${task.id} requires pass kind`)
    if (this.options.admissionLedger && task.passKind) {
      this.options.admissionLedger.assertLaunchable(task.id, task.role, task.passKind, "explicit_child", task.admissionPrompt ?? task.prompt)
    }
    const deadlineAt = admission?.deadlineAt ?? new Date(Date.now() + (this.options.timeoutMs ?? this.options.exec.timeoutMs ?? 1_800_000)).toISOString()
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
    }
    const record: ChildRecord = {
      handle,
      queue: [],
      attempts: [],
      ownerEpoch: 1,
      resumeState: "initial",
      restartRequested: false,
      terminalPublished: false,
      closed: false,
    }
    this.children.set(task.id, record)
    this.graph.open(parentId, task.id, spawnItemId, "explicit_child")
    this.persistRunning(record)
    try {
      await this.launch(record, task.prompt, false)
      return clone(record.handle)
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
    return clone(record.handle)
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
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("wait timeout must be a positive integer")
    const record = this.require(childId)
    const deadline = Date.now() + timeoutMs
    while (record.completion && (!terminalState(record.handle.state) || record.active)) {
      const remaining = Math.max(1, deadline - Date.now())
      await Promise.race([
        record.completion,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`child ${childId} wait exceeded ${timeoutMs}ms`)), remaining)),
      ])
    }
    return clone(record.handle)
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
    if (record.handle.state === "running") await this.interruptAgent(childId)
    if (!terminalState(record.handle.state)) {
      record.handle.state = "lost"
      record.handle.error = reason
    }
    record.handle.closeReason ??= reason
    record.closed = true
    this.finishGraph(record)
    this.persist(record)
  }

  listAgents(): ChildHandle[] {
    return [...this.children.values()].map((record) => clone(record.handle))
  }

  async shutdown(reason = "adapter shutdown"): Promise<void> {
    await this.ready
    await Promise.allSettled(
      [...this.children.values()]
        .filter((record) => !record.closed && !terminalState(record.handle.state))
        .map((record) => this.closeAgent(record.handle.childId, reason)),
    )
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
    await Promise.allSettled(running.map(async (record) => {
      await record.active!.detachForRestart()
      await record.completion
    }))
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
      const remainingMs = Date.parse(record.handle.deadlineAt) - Date.now()
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
        this.markRecoveryTerminal(record, "timed_out", "absolute review admission deadline exceeded during restart recovery")
        return
      }
      const processState = await this.stopRecordedProcess(record)
      if (processState === "unproven") {
        this.markRecoveryTerminal(record, "lost", "could not prove ownership of the previous explicit child process")
        return
      }
      if (record.handle.state !== "running" || !record.handle.sessionId || !record.activePrompt) {
        this.markRecoveryTerminal(record, "lost", "explicit child crashed before a durable Codex session resume point")
        return
      }
      record.processIdentity = undefined
      record.resumeState = "resuming"
      try {
        await this.launch(record, record.activePrompt, true)
      } catch {
        await record.completion?.catch(() => undefined)
      }
    }))
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
    this.finishGraph(record)
    this.persist(record)
  }

  private async stopRecordedProcess(record: ChildRecord): Promise<"absent" | "stopped" | "unproven"> {
    const identity = record.processIdentity
    if (!identity) return "absent"
    if (!this.processLive(identity.pid)) return "absent"
    const current = processIdentity(identity.pid)
    if (current.bootId !== identity.bootId || current.startTicks !== identity.startTicks) return "unproven"
    for (const [signal, graceMs] of [["SIGINT", 1_000], ["SIGTERM", 1_000], ["SIGKILL", 5_000]] as const) {
      try {
        if (process.platform === "win32") process.kill(identity.pid, signal)
        else process.kill(-identity.pid, signal)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return "stopped"
        throw error
      }
      const deadline = Date.now() + graceMs
      while (Date.now() < deadline) {
        if (!this.processLive(identity.pid)) return "stopped"
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    return this.processLive(identity.pid) ? "unproven" : "stopped"
  }

  private processLive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH"
    }
  }

  private runningPath(record: ChildRecord): string {
    return resolve(this.options.resultRoot, `${record.handle.childId}.running.json`)
  }

  private persistRunning(record: ChildRecord): void {
    if (terminalState(record.handle.state)) return
    const now = new Date().toISOString()
    const artifact: ChildRunningArtifact = {
      schemaVersion: 2,
      mode: "explicit_child",
      kind: "explicit_child_running",
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
        processGroupId: record.processIdentity.pid,
        processIdentity: { ...record.processIdentity },
      } : {}),
      ownerId: this.ownerId,
      ownerEpoch: record.ownerEpoch,
      resumeState: record.resumeState,
      heartbeatAt: now,
      updatedAt: now,
    }
    validateRunningArtifact(artifact)
    durableWriteFile(this.runningPath(record), `${JSON.stringify(artifact, null, 2)}\n`)
  }

  private async launch(record: ChildRecord, prompt: string, resume: boolean, queued = false): Promise<void> {
    const remainingMs = Date.parse(record.handle.deadlineAt) - Date.now()
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
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
    if (queued) {
      if (record.queue[0] !== prompt) throw new Error(`child ${record.handle.childId} queued prompt drift`)
      record.queue.shift()
    }
    this.persistRunning(record)
    let exec: CodexExecHandle
    try {
      exec = this.start({
        ...this.options.exec,
        model: this.modelForRole(record.handle.role),
        profile: this.profileForRole(record.handle.role),
        prompt,
        env: { ...this.options.exec.env, CCHP_EXPLICIT_AGENT_DEPTH: "1" },
        ...(resume ? { resumeSessionId: record.handle.sessionId } : {}),
        timeoutMs: Math.max(1, remainingMs),
      })
    } catch (error) {
      const message = errorMessage(error)
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
      this.finishGraph(record)
      this.persist(record)
      throw error
    }
    record.active = exec
    record.processIdentity = processIdentity(exec.pid)
    this.persistRunning(record)
    const startedAt = record.activeStartedAt
    const completion = (async (): Promise<ChildHandle> => {
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
        const message = errorMessage(error)
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
      }

      if (detachedForRestart) {
        this.persistRunning(record)
        return clone(record.handle)
      }
      record.activePrompt = undefined
      record.activeStartedAt = undefined
      if (!record.closed && record.queue.length > 0 && ["completed", "interrupted"].includes(record.handle.state)) {
        const next = record.queue[0]!
        await this.launch(record, next, true, true)
        return clone(record.handle)
      }
      if (!record.closed) this.finishGraph(record)
      this.persist(record)
      return clone(record.handle)
    })()
    record.completion = completion
    await exec.started
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
    const completedWithOutput = result.terminal === "completed" && typeof result.lastMessage === "string" && result.lastMessage.length > 0
    const state: Exclude<ChildState, "queued" | "running"> = completedWithOutput
      ? "completed"
      : result.terminal === "interrupted"
        ? "interrupted"
        : "failed"
    record.handle.state = state
    record.handle.output = result.lastMessage
    record.handle.error = state === "completed"
      ? undefined
      : result.terminal === "completed"
        ? "codex exec completed without a final message"
        : result.stderr || `codex exec exited ${result.exitCode}`
    record.attempts.push({
      attempt: record.attempts.length + 1,
      sessionId: result.sessionId,
      state,
      terminal: result.terminal === "completed" && !completedWithOutput ? "failed" : result.terminal,
      startedAt,
      completedAt: new Date().toISOString(),
      ...(result.lastMessage ? { output: result.lastMessage } : {}),
      ...(record.handle.error ? { error: record.handle.error } : {}),
    })
  }

  private finishGraph(record: ChildRecord): void {
    const edge = this.graph.edge(record.handle.childId)
    if (edge?.state === "open" && terminalState(record.handle.state)) this.graph.close(record.handle.childId, graphState(record.handle.state))
  }

  private persist(record: ChildRecord): void {
    if (!terminalState(record.handle.state)) {
      this.persistRunning(record)
      return
    }
    const artifact: ChildResultArtifact = {
      schemaVersion: 2,
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
    rmSync(this.runningPath(record), { force: true })
    if (!record.terminalPublished) {
      this.options.admissionLedger?.markTerminal(
        record.handle.childId,
        record.handle.state,
        record.handle.error,
        record.handle.result,
      )
      this.options.onTerminal?.(clone(record.handle))
      record.terminalPublished = true
    }
  }
}
