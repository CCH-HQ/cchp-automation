import { createHash } from "node:crypto"
import { appendFileSync, lstatSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { CodexAppServer, type CodexAppServerExit, type JsonRpcNotification, type JsonRpcServerRequest } from "./app-server"
import type { RunFence } from "./run-lock"
import { DEADLINES, ProgressDeadline } from "./deadlines"
import { durableWriteFile } from "./durable-file"
import { normalizeAppServerNotification, type NormalizedEvent } from "./events"
import { ChildGraph, type ChildTerminalState } from "./graph"
import { ProgressTracker } from "./progress"
import { ProvenanceLedger } from "./provenance"
import type { ProviderBridgeUsage } from "./provider-bridge"
import { UsageLedger, type CodexUsageUpdate, type RawUsageInput, type UsageResult } from "./usage"
import type { SupervisorResumeState } from "./run-manifest"
import { parseReviewTaskIdentity, ReviewAdmissionLedger, type ReviewPassKind, type ReviewResultBinding } from "./review-admission"
import { ArtifactExplicitChildLifecycle, type ExplicitChildLifecycle, type ExplicitChildSnapshot } from "./explicit-lifecycle"

export type SupervisorState =
  | "INIT"
  | "CONFIGURED"
  | "ROOT_STARTING"
  | "ROOT_RUNNING"
  | "ROOT_DRAINING"
  | "FINALIZING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED"
  | "LOST"
  | "TOKEN_BUDGET_EXCEEDED"
  | "NO_PROGRESS_TIMEOUT"

export interface SupervisorOptions {
  appServer: CodexAppServer
  codexHome: string
  repoDir: string
  workdir: string
  task: string
  runId: string
  prompt: string
  model: string
  modelProvider: string
  contextWindow?: number
  totalTokenBudget: number
  drainUsage?: () => Promise<void>
  finalizer?: (context: SupervisorFinalizerContext) => unknown | Promise<unknown>
  publishProgress?: (body: string) => Promise<void>
  codexVersion?: string
  codexV2Gate?: "passed" | "failed"
  executionMode?: "native_v2" | "explicit_child"
  capabilityReason?: string
  deadlines?: Partial<typeof DEADLINES>
  approvalPolicy?: "never"
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access"
  resume?: SupervisorResumeState
  maxAppServerRestarts?: number
  assertWriterOwnership?: () => void
  processRecordPath?: string
  writerFence?: Pick<RunFence, "writerId" | "generation">
  explicitChildren?: ExplicitChildLifecycle
  onAppServerStderr?: (line: string) => void
}

export interface SupervisorFinalizerContext {
  runId: string
  task: string
  rootThreadId: string
  rootTurnId: string
  preterminalProvenanceSha256: string
  idempotencyKey: string
}

export interface SupervisorResult {
  state: SupervisorState
  exitCode: number
  rootThreadId?: string
  rootTurnId?: string
  terminalReason?: string
  usage: UsageResult
}

type RuntimeUsage = UsageResult

const CODEX_ENV_ALLOWLIST = [
  "PATH", "HOME", "SHELL", "USER", "LOGNAME", "TMPDIR", "XDG_RUNTIME_DIR",
  "LANG", "LC_ALL", "TERM", "TZ", "CI",
  "GITHUB_ACTIONS", "GITHUB_WORKSPACE", "GITHUB_REPOSITORY", "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT", "GITHUB_SHA", "GITHUB_REF", "GITHUB_REF_NAME",
  "GITHUB_REF_TYPE", "RUNNER_OS", "RUNNER_ARCH", "RUNNER_TEMP", "RUNNER_TOOL_CACHE",
  "CODEX_HOME", "BUN_INSTALL", "NPM_CONFIG_USERCONFIG", "GOPATH", "GOMODCACHE",
  "GOCACHE", "CARGO_HOME", "RUSTUP_HOME", "UV_CACHE_DIR", "PIP_CACHE_DIR",
  "PLAYWRIGHT_BROWSERS_PATH",
  "BOT_REPO", "GH_REPO", "BOT_TASK", "BOT_WORKDIR", "REPO_DIR", "BOT_DEFAULT_BRANCH",
  "BOT_TARGET_BRANCH", "BOT_PR_BASE", "BOT_PR_NUMBER", "BOT_ISSUE_NUMBER",
  "BOT_DISCUSSION_NUMBER", "BOT_HEAD_SHA", "BOT_RUN_ID", "BOT_RELEASE_TAG",
  "BOT_PLAN_COMMENT_ID", "BOT_SKIP_PR_INSPECT", "BOT_PR_IS_FORK", "BOT_CAN_WRITE",
  "BOT_PATCH_FILE", "BOT_TRUSTED_REVIEW_MANIFEST",
  "BOT_REVIEW_ARTIFACT_DIR", "BOT_REVIEW_FINALIZED_MARKER",
  "BOT_SYSTEM_PROMPT", "BOT_PROMPT_FILE", "BOT_ROADMAP_PROJECT", "BOT_ROADMAP_POLICY",
  "BOT_SEMVER_WORKFLOW", "BOT_SEMVER_MARKER", "BOT_TECH_STACK", "BOT_LANGUAGES",
  "BOT_HAVE_FFF", "BOT_HAVE_SERENA", "BOT_HAVE_SEE",
  "CCHP_DISABLE_AUTO_APPROVE", "CCHP_CODEX_BRIDGE_TOKEN",
  "CCHP_GITHUB_BROKER_SOCKET", "CCHP_GITHUB_BROKER_TOKEN", "CCHP_GITHUB_BROKER_FINALIZER",
  "CCHP_EXPLICIT_PARENT_ID", "CCHP_EXPLICIT_AGENT_DEPTH", "CCHP_EXPLICIT_MAX_ACTIVE",
  "CCHP_EXPLICIT_CHILD_TIMEOUT_MS", "CODEX_BIN",
] as const

export function buildCodexEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of CODEX_ENV_ALLOWLIST) {
    const value = env[name]
    if (typeof value === "string") result[name] = value
  }
  return result
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function optionalNumber(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key]
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function extractId(params: Record<string, unknown>, key: string): string | undefined {
  return text(params[key]) ?? text(record(params.thread)[key]) ?? text(record(params.turn)[key])
}

function extractUsage(params: Record<string, unknown>): CodexUsageUpdate | undefined {
  const tokenUsage = record(params.tokenUsage)
  const total = record(tokenUsage.total)
  const last = record(tokenUsage.last)
  const threadId = extractId(params, "threadId")
  const turnId = extractId(params, "turnId")
  if (!threadId || !turnId || !Object.keys(last).length) return undefined
  return { threadId, turnId, tokenUsage: {
    total: {
      totalTokens: Number(total.totalTokens ?? 0), inputTokens: Number(total.inputTokens ?? 0), cachedInputTokens: Number(total.cachedInputTokens ?? 0), cacheWriteInputTokens: Number(total.cacheWriteInputTokens ?? 0), outputTokens: Number(total.outputTokens ?? 0), reasoningOutputTokens: Number(total.reasoningOutputTokens ?? 0),
    },
    last: {
      totalTokens: Number(last.totalTokens ?? 0), inputTokens: Number(last.inputTokens ?? 0), cachedInputTokens: Number(last.cachedInputTokens ?? 0), cacheWriteInputTokens: Number(last.cacheWriteInputTokens ?? 0), outputTokens: Number(last.outputTokens ?? 0), reasoningOutputTokens: Number(last.reasoningOutputTokens ?? 0),
    },
    modelContextWindow: typeof tokenUsage.modelContextWindow === "number" ? tokenUsage.modelContextWindow : null,
  } }
}

function threadFromRead(value: unknown): Record<string, unknown> {
  const response = record(value)
  return Object.keys(record(response.thread)).length ? record(response.thread) : response
}

function statusType(value: unknown): string | undefined {
  return text(record(value).type) ?? text(value)
}

function collaborationTerminalState(status: string): Exclude<ChildTerminalState, "timed_out"> | undefined {
  if (status === "completed") return "completed"
  if (["interrupted", "cancelled", "canceled"].includes(status)) return "interrupted"
  if (status === "notFound") return "lost"
  if (["errored", "shutdown"].includes(status)) return "failed"
  return undefined
}

function sameProviderUsage(left: ProviderBridgeUsage, right: ProviderBridgeUsage): boolean {
  return !usageObservationConflict(left, right)
}

function usageObservationConflict(left: ProviderBridgeUsage | RawUsageInput, right: ProviderBridgeUsage | RawUsageInput): string | undefined {
  const value = (usage: ProviderBridgeUsage | RawUsageInput, field: string): unknown => {
    if (field === "provider") return "providerId" in usage ? usage.providerId : usage.provider
    return usage[field as keyof typeof usage]
  }
  for (const field of [
    "provider", "model", "responseId", "threadId", "turnId", "inputTokens", "contextInputTokens",
    "billableInputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens",
    "reasoningOutputTokens", "totalTokens", "contextWindow",
  ]) {
    const leftValue = value(left, field)
    const rightValue = value(right, field)
    if (leftValue !== undefined && rightValue !== undefined && leftValue !== rightValue) return field
  }
  return undefined
}

function finalizerIdempotencyKey(
  runId: string,
  rootThreadId: string,
  rootTurnId: string,
  preterminalProvenanceSha256: string,
): string {
  return createHash("sha256")
    .update(`${runId}\0${rootThreadId}\0${rootTurnId}\0${preterminalProvenanceSha256}\0finalizer`)
    .digest("hex")
}

function terminalFromThreadRead(
  value: unknown,
  ownedTurnId?: string,
): "completed" | "failed" | "interrupted" | "lost" | undefined {
  const thread = threadFromRead(value)
  const threadStatus = statusType(thread.status)
  if (["notFound", "not_found", "notLoaded", "not_loaded", "deleted"].includes(threadStatus ?? "")) return "lost"
  if (["systemError", "system_error", "failed"].includes(threadStatus ?? "")) return "failed"
  const turns = Array.isArray(thread.turns) ? thread.turns : []
  const owned = ownedTurnId
    ? turns.map(record).find((turn) => text(turn.id) === ownedTurnId)
    : record(turns.at(-1))
  if (!owned) return undefined
  const status = statusType(owned.status)
  if (status === "completed") return "completed"
  if (status === "failed") return "failed"
  if (["interrupted", "cancelled", "canceled"].includes(status ?? "")) return "interrupted"
  return undefined
}

function notFoundError(error: unknown): boolean {
  return /not[ _-]?found|unknown thread|thread.*missing/i.test(error instanceof Error ? error.message : String(error))
}

function threadIdFromResponse(value: unknown): string | undefined {
  const response = record(value)
  return text(record(response.thread).id) ?? text(response.id)
}

function lastTurnIdFromThreadRead(value: unknown): string | undefined {
  const thread = threadFromRead(value)
  const turns = Array.isArray(thread.turns) ? thread.turns : []
  return text(record(turns.at(-1)).id)
}

function completedTurnFromThreadRead(value: unknown): Record<string, unknown> | undefined {
  const turns = Array.isArray(threadFromRead(value).turns) ? threadFromRead(value).turns as unknown[] : []
  return turns.map(record).reverse().find((turn) => {
    const status = text(record(turn.status).type) ?? text(turn.status)
    return status === "completed"
  })
}

function finalAgentMessageFromThreadRead(value: unknown): { turnId: string; itemId: string; output: string } {
  const turn = completedTurnFromThreadRead(value)
  const turnId = text(turn?.id)
  const items = Array.isArray(turn?.items) ? turn.items as unknown[] : []
  const message = items.map(record).reverse().find((item) => item.type === "agentMessage" && Boolean(text(item.text)))
  const itemId = text(message?.id)
  const output = text(message?.text)
  if (!turnId || !itemId || !output) throw new Error("review child result is missing a completed agent message")
  return { turnId, itemId, output }
}

function threadSessionIdFromRead(value: unknown): string | undefined {
  return text(threadFromRead(value).sessionId)
}

function threadParentIdFromRead(value: unknown): string | undefined {
  return text(threadFromRead(value).parentThreadId)
}

function hasTurn(value: unknown, turnId: string): boolean {
  const turns = Array.isArray(threadFromRead(value).turns) ? threadFromRead(value).turns as unknown[] : []
  return turns.some((turn) => text(record(turn).id) === turnId)
}

function isSpawnAgentTool(tool: string): boolean {
  return tool === "spawnAgent" || tool === "spawn_agent"
}

function collaborationItemsFromThreadRead(value: unknown): Array<{
  itemId: string
  sender: string
  receivers: string[]
  states: Record<string, string>
  prompt?: string
  role?: string
}> {
  const result: Array<{ itemId: string; sender: string; receivers: string[]; states: Record<string, string>; prompt?: string; role?: string }> = []
  const turns = Array.isArray(threadFromRead(value).turns) ? threadFromRead(value).turns as unknown[] : []
  for (const rawTurn of turns) {
    const items = Array.isArray(record(rawTurn).items) ? record(rawTurn).items as unknown[] : []
    for (const rawItem of items) {
      const item = record(rawItem)
      if (item.type !== "collabAgentToolCall" || typeof item.tool !== "string" || !isSpawnAgentTool(item.tool)) continue
      const itemId = text(item.id)
      const sender = text(item.senderThreadId)
      const receivers = Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds.filter((id): id is string => typeof id === "string" && Boolean(id))
        : []
      if (!itemId || !sender || !receivers.length) continue
      const states: Record<string, string> = {}
      for (const [childId, rawState] of Object.entries(record(item.agentsStates))) {
        const status = statusType(record(rawState).status)
        if (status) states[childId] = status
      }
      const prompt = text(item.prompt)
      const role = text(item.agentType) ?? text(item.agent_type) ?? text(item.role)
      result.push({ itemId, sender, receivers, states, ...(prompt ? { prompt } : {}), ...(role ? { role } : {}) })
    }
  }
  return result
}

/** CCHP-owned lifecycle supervisor. Codex owns model/tool execution; this class
 * owns every deadline, terminal transition, usage row, graph edge and finalizer
 * decision. It is intentionally transport-agnostic enough to be fixture-tested
 * with a fake app-server implementing the same request surface. */
export class Supervisor {
  private state: SupervisorState = "INIT"
  private readonly deadline: ProgressDeadline
  private readonly usage: UsageLedger
  private readonly graph: ChildGraph
  private readonly progress: ProgressTracker
  private readonly eventsPath: string
  private readonly unknownPath: string
  private readonly manifestPath: string
  private readonly provenance: ProvenanceLedger
  private readonly reviewAdmissions: ReviewAdmissionLedger
  private readonly explicitChildren?: ExplicitChildLifecycle
  private rootThreadId?: string
  private rootTurnId?: string
  private rootSessionId?: string
  private readonly startedAt: string
  private readonly wholeRunDeadlineAt: number
  private lastSemanticProgressAt: string
  private terminalReason?: string
  private lastEventAt = Date.now()
  private runTimer?: ReturnType<typeof setTimeout>
  private noProgressTimer?: ReturnType<typeof setInterval>
  private reconcileTimer?: ReturnType<typeof setInterval>
  private reconciling = false
  private readonly reconcileFailures = new Map<string, number>()
  private readonly pendingProviderUsage = new Map<string, ProviderBridgeUsage>()
  private readonly explicitProgressByChild = new Map<string, string>()
  private readonly rawResponseOwners = new Map<string, { threadId: string; turnId: string }>()
  private readonly rawResponseUsage = new Map<string, RawUsageInput>()
  private readonly pendingRootTurnCompletions: NormalizedEvent[] = []
  private drainDeadlineAt?: number
  private finalizationAttempt = false
  private finalizing = false
  private resolveTurn?: (result: SupervisorResult) => void
  private settled = false
  private terminalResult?: SupervisorResult
  private terminalIntent?: SupervisorResult
  private finalizerAttestation?: unknown
  private finalizerIdempotencyKey?: string
  private finalizationInputProvenanceSha256?: string
  private finalizationPhase?: "prepared" | "attested"
  private restartAttempts = 0
  private resumeState: "idle" | "restarting" | "resumed" | "failed" = "idle"
  private lastRestartAt?: string
  private lastResumeError?: string
  private restartTask?: Promise<void>
  private deferredAppServerExit?: CodexAppServerExit
  private runTask?: Promise<SupervisorResult>

  constructor(private readonly options: SupervisorOptions) {
    const codexDir = join(options.workdir, "ctx", "codex")
    mkdirSync(codexDir, { recursive: true, mode: 0o700 })
    this.eventsPath = join(codexDir, "supervisor.jsonl")
    this.unknownPath = join(codexDir, "events-unknown.jsonl")
    this.manifestPath = join(codexDir, "run-manifest.json")
    this.provenance = new ProvenanceLedger(join(codexDir, "provenance.jsonl"), options.runId, options.assertWriterOwnership)
    this.usage = new UsageLedger({ path: join(codexDir, "usage.jsonl"), totalBudget: options.totalTokenBudget, assertWriterOwnership: options.assertWriterOwnership })
    for (const completion of this.usage.rawCompletions) {
      this.rawResponseOwners.set(completion.responseId, { threadId: completion.threadId, turnId: completion.turnId })
      this.rawResponseUsage.set(completion.responseId, completion)
    }
    this.graph = new ChildGraph(join(codexDir, "graph.jsonl"), options.assertWriterOwnership)
    this.reviewAdmissions = new ReviewAdmissionLedger(join(codexDir, "review-admission.jsonl"), options.runId)
    this.explicitChildren = options.executionMode === "explicit_child"
      ? options.explicitChildren ?? new ArtifactExplicitChildLifecycle({
          resultRoot: join(options.workdir, "ctx", "child-results"),
          runId: options.runId,
        })
      : undefined
    const now = Date.now()
    this.startedAt = options.resume?.startedAt ?? new Date(now).toISOString()
    this.wholeRunDeadlineAt = Date.parse(options.resume?.wholeRunDeadlineAt ?? "") ||
      now + (options.deadlines?.wholeRunMs ?? DEADLINES.wholeRunMs)
    this.lastSemanticProgressAt = options.resume?.lastSemanticProgressAt ?? this.startedAt
    this.drainDeadlineAt = Date.parse(options.resume?.drainDeadlineAt ?? "") || undefined
    this.rootSessionId = options.resume?.rootSessionId
    this.deadline = new ProgressDeadline({
      now: () => Date.now(),
      semanticAt: Date.parse(this.lastSemanticProgressAt),
      warningMs: options.deadlines?.noProgressWarningMs,
      terminalMs: options.deadlines?.noProgressTerminalMs,
    })
    if (options.resume) {
      this.state = options.resume.state
      this.rootThreadId = options.resume.rootThreadId
      this.rootTurnId = options.resume.rootTurnId
      this.restartAttempts = options.resume.restartAttempts
      this.finalizationInputProvenanceSha256 = options.resume.finalizationInputProvenanceSha256
      this.finalizationPhase = options.resume.finalizationPhase
      this.finalizerAttestation = options.resume.finalizerAttestation
      this.finalizerIdempotencyKey = options.resume.finalizerIdempotencyKey
      for (const usage of options.resume.pendingProviderUsage ?? []) this.pendingProviderUsage.set(usage.responseId, usage)
    }
    this.progress = new ProgressTracker({
      path: join(codexDir, "todo.json"),
      rootThreadId: options.resume?.rootThreadId ?? "pending",
      task: options.task,
      runId: options.runId,
      publish: options.publishProgress,
    })
    if (options.resume) {
      this.append({
        event: "supervisor_process_resumed",
        state: this.state,
        rootThreadId: this.rootThreadId,
        rootTurnId: this.rootTurnId,
        restartAttempts: this.restartAttempts,
      })
      this.writeRunManifest()
    } else {
      this.transition("CONFIGURED", "preflight complete")
    }
  }

  get currentState(): SupervisorState { return this.state }
  get currentUsage(): RuntimeUsage { return this.usage.budget }

  run(): Promise<SupervisorResult> {
    this.runTask ??= Promise.resolve().then(() => this.runOnce())
    return this.runTask
  }

  private async runOnce(): Promise<SupervisorResult> {
    const remaining = this.wholeRunDeadlineAt - Date.now()
    if (remaining <= 0) return this.fail("whole run deadline exceeded", "TIMED_OUT", 124)
    this.runTimer = setTimeout(() => {
      void this.abort("whole run deadline exceeded", "TIMED_OUT", 124)
    }, remaining)
    if (this.state === "FINALIZING") {
      const terminal = new Promise<SupervisorResult>((resolve) => { this.resolveTurn = resolve })
      await this.finalizeSuccess(true)
      return terminal
    }
    const resuming = this.state === "ROOT_RUNNING" || this.state === "ROOT_DRAINING"
    if (!resuming && this.state !== "CONFIGURED") throw new Error(`supervisor cannot run from ${this.state}`)
    if (!resuming) this.transition("ROOT_STARTING", "starting Codex app-server")
    return this.executeRoot(resuming)
  }

  private async executeRoot(resuming: boolean): Promise<SupervisorResult> {
    const terminal = new Promise<SupervisorResult>((resolve) => {
      this.resolveTurn = resolve
    })
    try {
      const initialized = await this.options.appServer.start()
      this.append({ event: "app_server_initialized", initialized })
      if (resuming) {
        await this.resumeRootThread("runtime_process_restart")
        this.installRuntimeWatchdogs()
        await this.reconcileCycle()
        return await terminal
      }
      const thread = await this.options.appServer.request<Record<string, unknown>>("thread/start", {
        model: this.options.model,
        modelProvider: this.options.modelProvider,
        cwd: this.options.repoDir,
        approvalPolicy: this.options.approvalPolicy ?? "never",
        sandbox: this.options.sandboxMode ?? "read-only",
      })
      const threadRecord = record(thread.thread)
      this.rootThreadId = text(threadRecord.id) ?? text(thread.id)
      this.rootSessionId = text(threadRecord.sessionId)
      if (!this.rootThreadId) throw new Error("thread/start returned no thread id")
      this.progress.setRootThreadId(this.rootThreadId)
      this.transition("ROOT_RUNNING", `root thread ${this.rootThreadId}`)
      this.installRuntimeWatchdogs()
      const turn = await this.options.appServer.request<Record<string, unknown>>("turn/start", {
        threadId: this.rootThreadId,
        input: [{ type: "text", text: this.options.prompt }],
      })
      const turnRecord = record(turn.turn)
      const responseTurnId = text(turnRecord.id) ?? text(turn.id)
      if (!responseTurnId) throw new Error("turn/start returned no turn id")
      if (this.rootTurnId && this.rootTurnId !== responseTurnId) {
        throw new Error(`turn/start ownership mismatch: notification=${this.rootTurnId}, response=${responseTurnId}`)
      }
      this.rootTurnId = responseTurnId
      this.writeRunManifest()
      await this.drainPendingRootTurnCompletions()
      return await terminal
    } catch (error) {
      return this.fail(
        error instanceof Error ? error.message : String(error),
        resuming && notFoundError(error) ? "LOST" : "FAILED",
        1,
      )
    }
  }

  private installRuntimeWatchdogs(): void {
    this.noProgressTimer = setInterval(() => {
      void this.watchdog()
    }, this.options.deadlines?.heartbeatMs ?? DEADLINES.heartbeatMs)
    this.reconcileTimer = setInterval(() => {
      void this.reconcileCycle()
    }, this.options.deadlines?.reconcileMs ?? DEADLINES.reconcileMs)
  }

  private async watchdog(): Promise<void> {
    if (this.settled) return
    const check = this.deadline.check()
    const warning = check.state === "warning" || check.state === "stale"
      ? `No semantic progress for ${Math.floor(check.semanticAgeMs / 1000)}s`
      : undefined
    if (check.state === "warning") this.append({ event: "NO_PROGRESS_WARNING", semanticAgeMs: check.semanticAgeMs })
    await this.progress.heartbeat({
      childStates: this.childStateCounts(),
      usage: this.usage.budget,
      semanticAgeMs: check.semanticAgeMs,
      ...(warning ? { warning } : {}),
    })
    if (this.progress.publishError) this.append({ event: "progress_publish_error", message: this.progress.publishError })
    if (check.state === "terminal") await this.abort("NO_PROGRESS_TIMEOUT", "NO_PROGRESS_TIMEOUT")
  }

  public async handleNotification(notification: JsonRpcNotification): Promise<void> {
    const normalized = normalizeAppServerNotification(notification)
    this.lastEventAt = Date.now()
    await this.handleEvent(normalized)
  }

  public async handleAppServerExit(event: CodexAppServerExit): Promise<void> {
    this.append({ event: "app_server_exit", ...event, error: event.error?.message })
    if (event.expected || this.settled) return
    if (this.terminalIntent) {
      this.append({ event: "app_server_exit_ignored_after_terminal_intent", reason: event.reason, exitCode: event.exitCode })
      return
    }
    if (this.finalizing || this.state === "FINALIZING") {
      this.append({ event: "app_server_exit_ignored_during_finalization", reason: event.reason, exitCode: event.exitCode })
      return
    }
    if (this.state === "ROOT_DRAINING") {
      this.deferredAppServerExit ??= event
      this.append({ event: "app_server_exit_deferred_during_drain", reason: event.reason, exitCode: event.exitCode })
      return
    }
    if (!this.restartTask) {
      this.restartTask = this.restartAppServer(event).finally(() => {
        this.restartTask = undefined
      })
    }
    await this.restartTask
  }

  private async restartAppServer(event: CodexAppServerExit): Promise<void> {
    const limit = this.options.maxAppServerRestarts ?? 1
    if (!this.rootThreadId || !["ROOT_RUNNING", "ROOT_DRAINING"].includes(this.state) || this.restartAttempts >= limit) {
      await this.fail(
        `Codex app-server ${event.reason}${event.exitCode === null ? "" : ` (exit ${event.exitCode})`}; restart budget exhausted`,
        "LOST",
        1,
      )
      return
    }
    this.restartAttempts++
    this.resumeState = "restarting"
    this.lastRestartAt = new Date().toISOString()
    this.lastResumeError = undefined
    this.append({ event: "app_server_restart_started", attempt: this.restartAttempts, rootThreadId: this.rootThreadId })
    this.writeRunManifest()
    try {
      await this.options.appServer.stop()
      const initialized = await this.options.appServer.start()
      this.append({ event: "app_server_reinitialized", attempt: this.restartAttempts, initialized })
      await this.resumeRootThread("app_server_restart")
      await this.reconcileCycle()
    } catch (error) {
      this.resumeState = "failed"
      this.lastResumeError = error instanceof Error ? error.message : String(error)
      this.append({ event: "app_server_restart_failed", attempt: this.restartAttempts, message: this.lastResumeError })
      this.writeRunManifest()
      await this.fail(`Codex app-server restart failed: ${this.lastResumeError}`, "LOST", 1)
    }
  }

  private async resumeRootThread(reason: "runtime_process_restart" | "app_server_restart"): Promise<void> {
    if (!this.rootThreadId) throw new Error("cannot resume without a root thread id")
    const resumed = await this.options.appServer.request<Record<string, unknown>>("thread/resume", {
      threadId: this.rootThreadId,
      model: this.options.model,
      modelProvider: this.options.modelProvider,
      cwd: this.options.repoDir,
      approvalPolicy: this.options.approvalPolicy ?? "never",
      sandbox: this.options.sandboxMode ?? "read-only",
    })
    const resumedThreadId = threadIdFromResponse(resumed)
    if (resumedThreadId !== this.rootThreadId) {
      throw new Error(`thread/resume returned mismatched thread id ${resumedThreadId ?? "<missing>"}`)
    }
    const snapshot = await this.options.appServer.request<Record<string, unknown>>("thread/read", {
      threadId: this.rootThreadId,
      includeTurns: true,
    })
    this.rootTurnId ??= lastTurnIdFromThreadRead(snapshot)
    this.rootSessionId ??= threadSessionIdFromRead(snapshot)
    if (!this.rootTurnId) throw new Error("resumed root thread has no recoverable turn id")
    this.discoverMissingChildren(snapshot)
    await this.resumeOpenChildren()
    this.progress.setRootThreadId(this.rootThreadId)
    this.resumeState = "resumed"
    this.lastResumeError = undefined
    this.append({
      event: "root_thread_resumed",
      reason,
      rootThreadId: this.rootThreadId,
      rootTurnId: this.rootTurnId,
      restartAttempts: this.restartAttempts,
    })
    this.writeRunManifest()
  }

  private discoverMissingChildren(rootSnapshot: unknown): void {
    for (const item of collaborationItemsFromThreadRead(rootSnapshot)) {
      if (item.sender !== this.rootThreadId) {
        throw new Error(`recovered spawn item ${item.itemId} sender drift: expected ${this.rootThreadId}, got ${item.sender}`)
      }
      if (item.receivers.length !== 1) {
        throw new Error(`recovered spawn item ${item.itemId} must bind exactly one child`)
      }
      const identity = this.options.task === "pr_opened"
        ? parseReviewTaskIdentity(item.prompt ?? "")
        : undefined
      const reviewTaskId = identity?.taskId ?? `native:${item.itemId}`
      if (this.options.task === "pr_opened") {
        const existing = this.reviewAdmissions.task(reviewTaskId)
        if (existing) {
          if (item.role && item.role !== existing.role) throw new Error(`recovered spawn item ${item.itemId} role drift`)
          this.reviewAdmissions.admit({ taskId: reviewTaskId, role: existing.role, passKind: identity!.passKind, mode: "native_v2", prompt: item.prompt! })
        } else {
          this.reviewAdmissions.admit({
            taskId: reviewTaskId,
            role: item.role ?? "reviewer",
            passKind: identity!.passKind,
            mode: "native_v2",
            prompt: item.prompt!,
          })
        }
      }
      for (const childId of item.receivers) {
        if (this.options.task === "pr_opened") this.reviewAdmissions.bind(reviewTaskId, item.itemId, childId)
        const edge = this.graph.open(item.sender, childId, item.itemId)
        const status = item.states[childId]
        const terminalState = status ? collaborationTerminalState(status) : undefined
        if (edge.state === "open" && terminalState) {
          if (this.options.task === "pr_opened" && terminalState === "completed") {
            this.append({ event: "recovered_review_result_pending", childId, itemId: item.itemId })
            continue
          }
          this.graph.close(childId, terminalState)
          if (this.options.task === "pr_opened") this.reviewAdmissions.markTerminalByChild(childId, terminalState)
        }
      }
    }
  }

  private async completeReviewAdmission(
    childId: string,
    terminalState: "completed" | "failed" | "interrupted" | "lost",
    existingSnapshot?: unknown,
  ): Promise<void> {
    const admission = this.reviewAdmissions.taskForChild(childId)
    if (!admission) throw new Error(`review child result has no admission for ${childId}`)
    if (admission.state === "completed") {
      const result = admission.result
      if (!result) throw new Error(`completed review admission ${admission.taskId} has no result binding`)
      const expectedPath = join(this.options.workdir, "ctx", "child-results", `${encodeURIComponent(childId)}.native.json`)
      if (result.artifactPath !== expectedPath) throw new Error(`review result artifact path drift for ${admission.taskId}`)
      const stat = lstatSync(result.artifactPath)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`review result artifact is not a regular file for ${admission.taskId}`)
      const serialized = readFileSync(result.artifactPath, "utf8")
      if (createHash("sha256").update(serialized).digest("hex") !== result.artifactSha256) {
        throw new Error(`review result artifact hash drift for ${admission.taskId}`)
      }
      const artifact = record(JSON.parse(serialized))
      const output = text(artifact.output)
      if (
        artifact.schemaVersion !== 2
        || artifact.runId !== this.options.runId
        || artifact.taskId !== admission.taskId
        || artifact.role !== admission.role
        || artifact.passKind !== admission.passKind
        || artifact.mode !== "native_v2"
        || artifact.spawnItemId !== admission.spawnItemId
        || artifact.childThreadId !== childId
        || artifact.state !== "completed"
        || output == null
      ) throw new Error(`review result artifact identity drift for ${admission.taskId}`)
      if (
        createHash("sha256").update(output).digest("hex") !== result.outputSha256
        || Buffer.byteLength(output) !== result.outputBytes
      ) throw new Error(`review result output hash drift for ${admission.taskId}`)
      return
    }
    if (terminalState !== "completed") {
      this.reviewAdmissions.markTerminalByChild(childId, terminalState)
      return
    }
    const snapshot = existingSnapshot ?? await this.options.appServer.request<Record<string, unknown>>("thread/read", {
      threadId: childId,
      includeTurns: true,
    })
    if (terminalFromThreadRead(snapshot) !== "completed") throw new Error(`review child result thread ${childId} is not completed`)
    const parentThreadId = threadParentIdFromRead(snapshot)
    const sessionId = threadSessionIdFromRead(snapshot)
    if (parentThreadId && parentThreadId !== this.rootThreadId) {
      throw new Error(`review child result parent drift for ${childId}`)
    }
    if (sessionId && admission.spawnItemId) {
      this.reviewAdmissions.bind(admission.taskId, admission.spawnItemId, childId, sessionId)
    }
    const finalMessage = finalAgentMessageFromThreadRead(snapshot)
    const artifact = {
      schemaVersion: 2,
      runId: this.options.runId,
      taskId: admission.taskId,
      role: admission.role,
      passKind: admission.passKind,
      mode: "native_v2" as const,
      spawnItemId: admission.spawnItemId,
      childThreadId: childId,
      ...(sessionId ? { childSessionId: sessionId } : {}),
      turnId: finalMessage.turnId,
      terminalItemId: finalMessage.itemId,
      state: "completed" as const,
      output: finalMessage.output,
    }
    const serialized = `${JSON.stringify(artifact, null, 2)}\n`
    const resultPath = join(this.options.workdir, "ctx", "child-results", `${encodeURIComponent(childId)}.native.json`)
    mkdirSync(join(this.options.workdir, "ctx", "child-results"), { recursive: true, mode: 0o700 })
    durableWriteFile(resultPath, serialized)
    const result: ReviewResultBinding = {
      schemaVersion: 1,
      artifactPath: resultPath,
      artifactSha256: createHash("sha256").update(serialized).digest("hex"),
      outputSha256: createHash("sha256").update(finalMessage.output).digest("hex"),
      outputBytes: Buffer.byteLength(finalMessage.output),
    }
    this.reviewAdmissions.markTerminalByChild(childId, "completed", undefined, result)
  }

  private async resumeOpenChildren(): Promise<void> {
    for (const edge of this.graph.openEdges()) {
      const resumed = await this.options.appServer.request<Record<string, unknown>>("thread/resume", { threadId: edge.childId })
      const resumedThreadId = threadIdFromResponse(resumed)
      if (resumedThreadId !== edge.childId) {
        throw new Error(`child thread/resume returned mismatched thread id ${resumedThreadId ?? "<missing>"} for ${edge.childId}`)
      }
      const snapshot = await this.options.appServer.request<Record<string, unknown>>("thread/read", {
        threadId: edge.childId,
        includeTurns: true,
      })
      const parentThreadId = threadParentIdFromRead(snapshot)
      const sessionId = threadSessionIdFromRead(snapshot)
      if (parentThreadId && parentThreadId !== edge.parentId) {
        throw new Error(`child ${edge.childId} parent drift: expected ${edge.parentId}, got ${parentThreadId}`)
      }
      if (this.rootSessionId && sessionId && sessionId !== this.rootSessionId) {
        throw new Error(`child ${edge.childId} session drift: expected ${this.rootSessionId}, got ${sessionId}`)
      }
      this.append({ event: "child_thread_resumed", childId: edge.childId, parentThreadId, sessionId })
    }
  }

  private usageAttribution(threadId: string, parentThreadId?: string): { billingScopeId: string; lineage: string[] } {
    const lineage = [threadId]
    let current = threadId
    const seen = new Set<string>(lineage)
    while (true) {
      const parent = this.graph.edge(current)?.parentId ?? (current === threadId ? parentThreadId : undefined)
      if (!parent || seen.has(parent)) break
      lineage.push(parent)
      seen.add(parent)
      current = parent
    }
    lineage.reverse()
    return { billingScopeId: this.options.runId, lineage }
  }

  public async recordProviderUsage(usage: ProviderBridgeUsage): Promise<UsageResult> {
    if (this.options.executionMode === "native_v2") {
      const owner = this.rawResponseOwners.get(usage.responseId)
      if (!owner) {
        return this.rememberPendingProviderUsage(usage, "pending_raw_response")
      }
      const providerInput: RawUsageInput = {
        ...owner,
        ...this.usageAttribution(owner.threadId, this.graph.edge(owner.threadId)?.parentId),
        parentThreadId: this.graph.edge(owner.threadId)?.parentId,
        responseId: usage.responseId,
        provider: usage.providerId,
        model: usage.model,
        inputTokens: usage.inputTokens,
        contextInputTokens: usage.contextInputTokens,
        billableInputTokens: usage.billableInputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheWriteInputTokens: usage.cacheWriteInputTokens,
        outputTokens: usage.outputTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens,
        totalTokens: usage.totalTokens,
        contextWindow: usage.contextWindow ?? this.options.contextWindow,
        source: "provider-bridge:response.completed",
      }
      const raw = this.rawResponseUsage.get(usage.responseId)
      const conflict = raw ? usageObservationConflict(raw, providerInput) : undefined
      if (conflict) {
        const result = this.usage.recordTerminalUsageConflict(providerInput, `raw/provider terminal usage mismatch for ${usage.responseId}: ${conflict}`)
        const anomaly = this.usage.anomalies.at(-1)
        this.append({ event: "TOKEN_ANOMALY", anomaly })
        await this.abort(`TOKEN_ANOMALY: ${anomaly?.message ?? "raw/provider terminal usage mismatch"}`, "FAILED")
        return result
      }
      return this.recordRawUsage(providerInput, "provider_usage")
    }
    const threadId = usage.threadId ?? this.rootThreadId ?? this.options.runId
    const parentThreadId = threadId !== this.rootThreadId ? this.graph.edge(threadId)?.parentId ?? this.rootThreadId : undefined
    if (threadId !== this.rootThreadId && this.options.executionMode === "explicit_child" && !this.graph.edge(threadId)) {
      return this.rememberPendingProviderUsage(usage, "pending_explicit_child_graph")
    }
    const result = await this.recordRawUsage({
      threadId,
      turnId: usage.turnId ?? (threadId === this.rootThreadId ? this.rootTurnId : undefined) ?? usage.responseId,
      ...this.usageAttribution(threadId, parentThreadId),
      parentThreadId,
      responseId: usage.responseId,
      provider: usage.providerId,
      model: usage.model,
      inputTokens: usage.inputTokens,
      contextInputTokens: usage.contextInputTokens,
      billableInputTokens: usage.billableInputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      outputTokens: usage.outputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
      totalTokens: usage.totalTokens,
      contextWindow: usage.contextWindow ?? this.options.contextWindow,
      source: "provider-bridge:response.completed",
    }, "provider_usage")
    return result
  }

  private async rememberPendingProviderUsage(
    usage: ProviderBridgeUsage,
    attribution: "pending_raw_response" | "pending_explicit_child_graph",
  ): Promise<UsageResult> {
    const existing = this.pendingProviderUsage.get(usage.responseId)
    if (existing && !sameProviderUsage(existing, usage)) {
      const result = this.usage.recordTerminalUsageConflict({
        threadId: usage.threadId ?? existing.threadId ?? "pending",
        turnId: usage.turnId ?? existing.turnId ?? usage.responseId,
        responseId: usage.responseId,
        billingScopeId: this.options.runId,
        provider: usage.providerId,
        model: usage.model,
        inputTokens: usage.inputTokens,
        contextInputTokens: usage.contextInputTokens,
        billableInputTokens: usage.billableInputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheWriteInputTokens: usage.cacheWriteInputTokens,
        outputTokens: usage.outputTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens,
        totalTokens: usage.totalTokens,
        contextWindow: usage.contextWindow ?? this.options.contextWindow,
        source: "provider-bridge:pending-conflict",
      }, `pending terminal usage for response ${usage.responseId} changed from ${existing.totalTokens} to ${usage.totalTokens}`)
      const anomaly = this.usage.anomalies.at(-1)
      this.append({ event: "TOKEN_ANOMALY", anomaly })
      this.writeRunManifest()
      await this.abort(`TOKEN_ANOMALY: ${anomaly?.message ?? "pending terminal usage changed"}`, "FAILED")
      return result
    }
    if (!existing) this.pendingProviderUsage.set(usage.responseId, usage)
    this.append({
      event: existing ? "provider_usage_duplicate_observed" : "provider_usage_observed",
      responseId: usage.responseId,
      threadId: usage.threadId,
      provider: usage.providerId,
      model: usage.model,
      attribution,
    })
    this.writeRunManifest()
    return this.usage.budget
  }

  private async flushPendingProviderUsage(): Promise<void> {
    for (const [responseId, usage] of [...this.pendingProviderUsage.entries()]) {
      const threadId = usage.threadId
      if (!threadId) continue
      const parentThreadId = threadId !== this.rootThreadId ? this.graph.edge(threadId)?.parentId ?? this.rootThreadId : undefined
      if (threadId !== this.rootThreadId && !this.graph.edge(threadId)) continue
      this.pendingProviderUsage.delete(responseId)
      await this.recordRawUsage({
        threadId,
        turnId: usage.turnId ?? (threadId === this.rootThreadId ? this.rootTurnId : undefined) ?? responseId,
        ...this.usageAttribution(threadId, parentThreadId),
        parentThreadId,
        responseId,
        provider: usage.providerId,
        model: usage.model,
        inputTokens: usage.inputTokens,
        contextInputTokens: usage.contextInputTokens,
        billableInputTokens: usage.billableInputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheWriteInputTokens: usage.cacheWriteInputTokens,
        outputTokens: usage.outputTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens,
        totalTokens: usage.totalTokens,
        contextWindow: usage.contextWindow ?? this.options.contextWindow,
        source: "provider-bridge:pending-resolved",
      }, "provider_usage")
    }
    this.writeRunManifest()
  }

  private async recordRawUsage(
    input: Parameters<UsageLedger["recordRaw"]>[0],
    event: "provider_usage" | "raw_response_usage",
  ): Promise<UsageResult> {
    const result = this.usage.recordRaw(input)
    this.append({
      event,
      responseId: input.responseId,
      threadId: input.threadId,
      turnId: input.turnId,
      provider: input.provider,
      model: input.model,
      ...result,
    })
    this.writeRunManifest()
    if (this.usage.hasBlockingAnomalies()) {
      const anomaly = this.usage.anomalies.at(-1)
      this.append({ event: "TOKEN_ANOMALY", anomaly })
      await this.abort(`TOKEN_ANOMALY: ${anomaly?.message ?? "unclassified token anomaly"}`, "FAILED")
    } else if (result.state === "exceeded") {
      await this.abort("token budget exceeded", "TOKEN_BUDGET_EXCEEDED")
    }
    return result
  }

  private async handleEvent(event: NormalizedEvent): Promise<void> {
    this.append({ event: event.kind, source: event.source, threadId: event.threadId, turnId: event.turnId, semantic: event.semantic, params: event.params })
    if (event.kind === "turn_started" && event.threadId === this.rootThreadId && event.turnId && !this.rootTurnId) {
      this.rootTurnId = event.turnId
      this.writeRunManifest()
      await this.drainPendingRootTurnCompletions()
    }
    if (event.kind === "unknown") {
      this.options.assertWriterOwnership?.()
      appendFileSync(this.unknownPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 })
      if (this.rootThreadId && event.threadId === this.rootThreadId) {
        await this.abort(`unknown lifecycle event ${event.source}`, "FAILED")
      }
      return
    }
    if (event.kind === "turn_completed" && event.threadId === this.rootThreadId && !this.rootTurnId) {
      this.pendingRootTurnCompletions.push(event)
      this.append({
        event: "root_turn_completion_deferred",
        receivedTurnId: event.turnId,
        pending: this.pendingRootTurnCompletions.length,
      })
      this.deadline.transportEvent(event.source)
      return
    }
    let rootSemantic = false
    if (event.kind === "plan") {
      const rawPlan = Array.isArray(event.params.plan)
        ? event.params.plan
        : Array.isArray(record(event.params.plan).steps)
          ? record(event.params.plan).steps as unknown[]
          : []
      const plan = rawPlan.flatMap((value) => {
        const item = record(value)
        const step = text(item.step)
        const status = text(item.status)
        return step && status ? [{ step, status }] : []
      })
      rootSemantic = await this.progress.applyPlan(event.threadId ?? "", plan)
    } else {
      const childSemantic = Boolean(event.threadId && event.threadId !== this.rootThreadId && this.graph.edge(event.threadId))
      rootSemantic = Boolean(event.semantic && (event.threadId === this.rootThreadId || childSemantic))
    }
    if (rootSemantic) {
      this.deadline.semanticProgress(event.source)
      this.lastSemanticProgressAt = new Date().toISOString()
      this.writeRunManifest()
    }
    else this.deadline.transportEvent(event.source)
    if (event.kind === "usage") {
      const usage = extractUsage(event.params)
      if (usage) {
        const result = this.usage.recordCodexUpdate(usage)
        this.append({ event: "usage_state", ...result })
        if (result.state === "exceeded") await this.abort("token budget exceeded", "TOKEN_BUDGET_EXCEEDED")
      }
    }
    if (event.kind === "raw_usage") {
      const responseId = text(event.params.responseId)
      if (responseId && event.threadId && event.turnId) {
        const provider = this.pendingProviderUsage.get(responseId)
        const raw = record(event.params.usage)
        const rawObservation: RawUsageInput = {
          threadId: event.threadId,
          turnId: event.turnId,
          responseId,
          inputTokens: optionalNumber(raw, "inputTokens"),
          contextInputTokens: optionalNumber(raw, "contextInputTokens"),
          billableInputTokens: optionalNumber(raw, "billableInputTokens"),
          cachedInputTokens: optionalNumber(raw, "cachedInputTokens"),
          cacheWriteInputTokens: optionalNumber(raw, "cacheWriteInputTokens"),
          outputTokens: optionalNumber(raw, "outputTokens"),
          reasoningOutputTokens: optionalNumber(raw, "reasoningOutputTokens"),
          totalTokens: optionalNumber(raw, "totalTokens") ?? provider?.totalTokens ?? 0,
          source: "app-server:rawResponse/completed",
        }
        const conflict = provider ? usageObservationConflict(provider, rawObservation) : undefined
        if (conflict) {
          this.pendingProviderUsage.delete(responseId)
          const result = this.usage.recordTerminalUsageConflict(rawObservation, `raw/provider terminal usage mismatch for ${responseId}: ${conflict}`)
          const anomaly = this.usage.anomalies.at(-1)
          this.append({ event: "TOKEN_ANOMALY", anomaly })
          this.writeRunManifest()
          await this.abort(`TOKEN_ANOMALY: ${anomaly?.message ?? "raw/provider terminal usage mismatch"}`, "FAILED")
          return
        }
        this.rawResponseOwners.set(responseId, { threadId: event.threadId, turnId: event.turnId })
        this.rawResponseUsage.set(responseId, rawObservation)
        this.pendingProviderUsage.delete(responseId)
        const totalTokens = rawObservation.totalTokens
        if (Object.keys(raw).length || provider) {
          const attribution = this.usageAttribution(event.threadId, this.graph.edge(event.threadId)?.parentId)
          await this.recordRawUsage({
            threadId: event.threadId,
            turnId: event.turnId,
            ...attribution,
            parentThreadId: this.graph.edge(event.threadId)?.parentId,
            responseId,
            provider: provider?.providerId,
            model: provider?.model,
            inputTokens: Number(raw.inputTokens ?? provider?.inputTokens ?? 0),
            contextInputTokens: Number(raw.contextInputTokens ?? provider?.contextInputTokens ?? raw.inputTokens ?? provider?.inputTokens ?? 0),
            billableInputTokens: Number(raw.billableInputTokens ?? provider?.billableInputTokens ?? raw.inputTokens ?? provider?.inputTokens ?? 0),
            cachedInputTokens: Number(raw.cachedInputTokens ?? provider?.cachedInputTokens ?? 0),
            cacheWriteInputTokens: Number(raw.cacheWriteInputTokens ?? provider?.cacheWriteInputTokens ?? 0),
            outputTokens: Number(raw.outputTokens ?? provider?.outputTokens ?? 0),
            reasoningOutputTokens: Number(raw.reasoningOutputTokens ?? provider?.reasoningOutputTokens ?? 0),
            totalTokens,
            contextWindow: provider?.contextWindow ?? this.options.contextWindow,
            source: "app-server:rawResponse/completed",
          }, "raw_response_usage")
        }
      }
    }
    if (event.kind === "collaboration" && event.collaboration) {
      if (event.threadId && event.collaboration.sender !== event.threadId) {
        await this.abort(
          `collaboration sender mismatch: notification=${event.threadId}, item=${event.collaboration.sender}`,
          "FAILED",
        )
        return
      }
      if (isSpawnAgentTool(event.collaboration.tool) && event.collaboration.sender !== this.rootThreadId) {
        await this.abort(
          `native child delegation is forbidden: expected sender ${this.rootThreadId}, got ${event.collaboration.sender}`,
          "FAILED",
        )
        return
      }
      if (!isSpawnAgentTool(event.collaboration.tool)) {
        const referencedChildren = new Set([
          ...event.collaboration.receivers,
          ...Object.keys(event.collaboration.states),
        ])
        const unknownChildren = [...referencedChildren].filter((childId) => !this.graph.edge(childId))
        if (unknownChildren.length > 0) {
          await this.abort(
            `non-spawn collaboration tool ${event.collaboration.tool} references unknown children: ${unknownChildren.join(", ")}`,
            "FAILED",
          )
          return
        }
      }
      let reviewTaskId = `native:${event.collaboration.itemId}`
      let reviewPassKind: ReviewPassKind | undefined
      if (this.options.task === "pr_opened" && isSpawnAgentTool(event.collaboration.tool)) {
        if (event.collaboration.receivers.length > 1) {
          await this.abort(`review spawn ${event.collaboration.itemId} returned multiple children`, "FAILED")
          return
        }
        const item = event.item ?? {}
        const role = text(item.agentType) ?? text(item.agent_type) ?? text(item.role) ?? "reviewer"
        const prompt = text(item.prompt) ?? `Review child task ${event.collaboration.itemId}`
        try {
          const identity = parseReviewTaskIdentity(prompt)
          reviewTaskId = identity.taskId
          reviewPassKind = identity.passKind
          this.reviewAdmissions.admit({ taskId: reviewTaskId, role, passKind: reviewPassKind, mode: "native_v2", prompt })
        } catch (error) {
          await this.abort(`review admission failed: ${String(error)}`, "FAILED")
          return
        }
      }
      for (const childId of event.collaboration.receivers) {
        if (isSpawnAgentTool(event.collaboration.tool)) {
          try {
            if (this.options.task === "pr_opened") this.reviewAdmissions.bind(reviewTaskId, event.collaboration.itemId, childId)
            this.graph.open(event.collaboration.sender, childId, event.collaboration.itemId)
          } catch (error) {
            await this.abort(`review child binding failed: ${String(error)}`, "FAILED")
            return
          }
        }
      }
      for (const [childId, status] of isSpawnAgentTool(event.collaboration.tool) ? Object.entries(event.collaboration.states) : []) {
        const terminalState = collaborationTerminalState(status)
        if (terminalState) {
          if (this.options.task === "pr_opened" && this.reviewAdmissions.taskForChild(childId)) {
            try {
              await this.completeReviewAdmission(childId, terminalState)
            } catch (error) {
              await this.abort(`review child result validation failed: ${String(error)}`, "FAILED")
              return
            }
          }
          if (this.graph.edge(childId)?.state === "open" && this.graph.close(childId, terminalState)) {
            this.append({ event: "native_child_terminal_observed", childId, terminalState, itemId: event.collaboration.itemId })
            this.deadline.semanticProgress(event.source)
            this.lastSemanticProgressAt = new Date().toISOString()
            this.writeRunManifest()
          }
        }
      }
      if (this.state === "ROOT_DRAINING") await this.reconcileCycle()
    }
    if (event.kind === "turn_completed" && event.threadId === this.rootThreadId) {
      await this.handleRootTurnCompletion(event)
    }
  }

  private async drainPendingRootTurnCompletions(): Promise<void> {
    if (!this.rootTurnId || !this.pendingRootTurnCompletions.length) return
    const pending = this.pendingRootTurnCompletions.splice(0)
    for (const event of pending) {
      if (this.settled || this.finalizing) return
      if (event.turnId === this.rootTurnId) {
        this.deadline.semanticProgress(event.source)
        this.lastSemanticProgressAt = new Date().toISOString()
        this.writeRunManifest()
      }
      await this.handleRootTurnCompletion(event)
    }
  }

  private async handleRootTurnCompletion(event: NormalizedEvent): Promise<void> {
    if (this.terminalIntent) return
    if (!event.turnId || event.turnId !== this.rootTurnId) {
      this.append({ event: "stale_root_turn_completion", receivedTurnId: event.turnId, rootTurnId: this.rootTurnId })
      return
    }
    const turn = record(event.params.turn)
    const status = statusType(turn.status ?? event.params.status)
    if (status === "completed") await this.succeed()
    else if (["interrupted", "cancelled", "canceled"].includes(status ?? "")) await this.fail(`root turn ${status}`, "CANCELLED", 130)
    else if (["failed", "systemError", "system_error"].includes(status ?? "")) await this.fail(`root turn ${status}`, "FAILED", 1)
    else await this.fail(`root turn completed with unsupported status ${String(status)}`, "FAILED", 1)
  }

  private async succeed(): Promise<void> {
    if (this.settled || this.finalizing || this.terminalIntent) return
    this.drainDeadlineAt ??= Date.now() + (this.options.deadlines?.parentResumeMs ?? DEADLINES.parentResumeMs)
    if (this.state !== "ROOT_DRAINING") this.transition("ROOT_DRAINING", "root turn completed")
    else this.writeRunManifest()
    await this.reconcileCycle()
  }

  private async reconcileCycle(): Promise<void> {
    if (this.settled || this.finalizing || this.reconciling) return
    this.reconciling = true
    try {
      let rootTerminal: ReturnType<typeof terminalFromThreadRead>
      const ids = [
        ...(this.rootThreadId ? [this.rootThreadId] : []),
        ...this.graph.openEdges().filter((edge) => edge.transport === "native_v2").map((edge) => edge.childId),
      ]
      for (const threadId of [...new Set(ids)]) {
        try {
          const snapshot = await this.options.appServer.request<Record<string, unknown>>("thread/read", { threadId, includeTurns: true })
          this.reconcileFailures.delete(threadId)
          if (threadId === this.rootThreadId && this.rootTurnId && !hasTurn(snapshot, this.rootTurnId)) {
            throw new Error(`owned root turn ${this.rootTurnId} is missing from thread/read`)
          }
          const edge = threadId === this.rootThreadId ? undefined : this.graph.edge(threadId)
          const parentThreadId = threadParentIdFromRead(snapshot)
          const sessionId = threadSessionIdFromRead(snapshot)
          if (edge && parentThreadId && parentThreadId !== edge.parentId) {
            throw new Error(`child ${threadId} parent drift: expected ${edge.parentId}, got ${parentThreadId}`)
          }
          if (edge && this.rootSessionId && sessionId && sessionId !== this.rootSessionId) {
            throw new Error(`child ${threadId} session drift: expected ${this.rootSessionId}, got ${sessionId}`)
          }
          const terminal = terminalFromThreadRead(snapshot, threadId === this.rootThreadId ? this.rootTurnId : undefined)
          this.append({ event: "thread_reconciled", threadId, terminal: terminal ?? null })
          if (threadId === this.rootThreadId) rootTerminal = terminal
          else if (terminal && this.graph.edge(threadId)?.state === "open") {
            if (this.options.task === "pr_opened" && this.reviewAdmissions.taskForChild(threadId)) {
              try {
                await this.completeReviewAdmission(threadId, terminal, snapshot)
              } catch (error) {
                this.graph.close(threadId, "failed")
                await this.fail(`review child result validation failed: ${String(error)}`, "FAILED", 1)
                return
              }
            }
            this.graph.close(threadId, terminal)
            this.deadline.semanticProgress("thread/reconcile child terminal")
            this.lastSemanticProgressAt = new Date().toISOString()
            this.writeRunManifest()
          }
        } catch (error) {
          const failures = (this.reconcileFailures.get(threadId) ?? 0) + 1
          this.reconcileFailures.set(threadId, failures)
          this.append({ event: "thread_reconcile_error", threadId, failures, message: String(error) })
          if (notFoundError(error) || failures >= 3) {
            if (threadId === this.rootThreadId) {
              await this.fail(`root thread reconciliation lost ownership: ${String(error)}`, "LOST", 1)
              return
            }
            if (this.graph.edge(threadId)?.state === "open") this.graph.close(threadId, "lost")
            if (this.options.task === "pr_opened" && this.reviewAdmissions.taskForChild(threadId)) {
              this.reviewAdmissions.markTerminalByChild(threadId, "lost", String(error))
            }
          }
        }
      }
      if (this.settled) return
      const explicit = await this.reconcileExplicitChildren()
      if (this.settled || !explicit) return
      await this.expireReviewAdmissions()
      if (this.settled) return
      if (this.state === "ROOT_RUNNING" && rootTerminal) {
        if (rootTerminal === "completed") await this.succeed()
        else {
          if (rootTerminal === "interrupted") await this.fail("root turn reconciled as interrupted", "CANCELLED", 130)
          else await this.fail(`root turn reconciled as ${rootTerminal}`, rootTerminal === "lost" ? "LOST" : "FAILED", 1)
          return
        }
      }
      await this.deliverPendingWakes()
      if (this.settled) return
      if (this.state !== "ROOT_DRAINING") return
      const open = this.graph.openEdges()
      if (!open.length && !explicit.active.length) {
        if (this.deferredAppServerExit && !this.restartTask) {
          const deferred = this.deferredAppServerExit
          this.deferredAppServerExit = undefined
          this.restartTask = this.restartAppServer(deferred).finally(() => {
            this.restartTask = undefined
          })
          await this.restartTask
          return
        }
        if (this.graph.edges().some((edge) => edge.terminalState === "lost")) {
          await this.fail("one or more child threads were lost during reconciliation", "LOST", 1)
          return
        }
        await this.finalizeSuccess()
        return
      }
      this.append({ event: "reconcile_open_edges", count: open.length, explicitActive: explicit.active.length })
      if (Date.now() >= (this.drainDeadlineAt ?? 0)) {
        for (const edge of open) this.graph.close(edge.childId, "lost")
        await this.interruptExplicitChildren("root drain deadline expired", explicit.active.map((child) => child.childId))
        await this.fail("root drain deadline expired with open child work", "LOST", 1)
        return
      }
    } finally {
      this.reconciling = false
    }
  }

  private async reconcileExplicitChildren(): Promise<ExplicitChildSnapshot | undefined> {
    if (!this.explicitChildren) return { active: [], terminal: [], stale: [] }
    let snapshot: ExplicitChildSnapshot
    try {
      snapshot = this.explicitChildren.reconcile()
    } catch (error) {
      await this.fail(`explicit child artifact reconciliation failed: ${error instanceof Error ? error.message : String(error)}`, "FAILED", 1)
      return undefined
    }
    for (const stale of snapshot.stale) this.append({ event: "explicit_child_stale_artifact", ...stale })
    try {
      for (const child of [...snapshot.active, ...snapshot.terminal].sort((left, right) => left.childId.localeCompare(right.childId))) {
        const parentId = child.parentId
        const spawnItemId = child.spawnItemId
        const generation = child.generation
        if (!parentId || !spawnItemId || !Number.isSafeInteger(generation) || generation < 1) {
          throw new Error(`explicit child ${child.childId} has incomplete graph identity`)
        }
        let edge = this.graph.edge(child.childId)
        if (!edge) edge = this.graph.open(parentId, child.childId, spawnItemId, "explicit_child", generation)
        if (edge.transport !== "explicit_child" || edge.parentId !== parentId || edge.spawnItemId !== spawnItemId) {
          throw new Error(`explicit child ${child.childId} graph identity drift`)
        }
        if (generation < edge.generation) {
          this.append({ event: "explicit_child_stale_generation", childId: child.childId, generation, currentGeneration: edge.generation })
          continue
        }
        if (generation > edge.generation) {
          if (generation !== edge.generation + 1 || edge.state !== "closed") throw new Error(`explicit child ${child.childId} graph generation drift`)
          edge = this.graph.reopen(child.childId)
        }
        const runningChild = snapshot.active.find((candidate) => candidate === child)
        if (runningChild) {
          if (edge.state !== "open") throw new Error(`explicit child ${child.childId} active generation is already closed`)
          const progressKey = `${runningChild.generation}\0${runningChild.updatedAt}\0${runningChild.heartbeatAt}`
          const previousProgress = this.explicitProgressByChild.get(child.childId)
          if (previousProgress !== progressKey) {
            const previousTimestamp = previousProgress?.split("\0")[1]
            if (!previousTimestamp || Date.parse(runningChild.updatedAt) > Date.parse(previousTimestamp)) {
              this.deadline.semanticProgress("explicit child running artifact progress")
              this.lastSemanticProgressAt = new Date().toISOString()
              this.writeRunManifest()
            }
            this.explicitProgressByChild.set(child.childId, progressKey)
          }
          continue
        }
        const terminal = child.state as ChildTerminalState
        if (edge.state === "open") {
          this.graph.close(child.childId, terminal)
          this.deadline.semanticProgress("explicit child terminal artifact")
          this.lastSemanticProgressAt = new Date().toISOString()
          this.writeRunManifest()
        }
        else if (edge.terminalState !== terminal) throw new Error(`explicit child ${child.childId} terminal state drift`)
        this.graph.markResumeDelivered(child.childId)
      }
    } catch (error) {
      await this.fail(`explicit child graph projection failed: ${error instanceof Error ? error.message : String(error)}`, "FAILED", 1)
      return undefined
    }
    await this.flushPendingProviderUsage()
    const failed = snapshot.terminal.find((child) => child.state !== "completed")
    if (failed) {
      await this.fail(`explicit child ${failed.childId} ended ${failed.state}${failed.error ? `: ${failed.error}` : ""}`, failed.state === "lost" ? "LOST" : "FAILED", 1)
      return undefined
    }
    const expired = snapshot.active.filter((child) => Date.parse(child.deadlineAt) <= Date.now())
    if (expired.length) {
      await this.interruptExplicitChildren("explicit child deadline expired", expired.map((child) => child.childId))
      await this.fail(`explicit child deadline expired: ${expired.map((child) => child.childId).join(", ")}`, "LOST", 1)
      return undefined
    }
    return snapshot
  }

  private async expireReviewAdmissions(): Promise<void> {
    for (const admission of this.reviewAdmissions.expired()) {
      if (!admission.childThreadId) {
        this.reviewAdmissions.markTerminal(admission.taskId, "timed_out", "review child was not bound before its deadline")
        await this.fail(`review child ${admission.taskId} admission deadline expired before spawn binding`, "LOST", 1)
        return
      }
      try {
        const snapshot = await this.options.appServer.request<Record<string, unknown>>("thread/read", {
          threadId: admission.childThreadId,
          includeTurns: true,
        })
        const turnId = lastTurnIdFromThreadRead(snapshot)
        if (turnId) await this.options.appServer.request("turn/interrupt", { threadId: admission.childThreadId, turnId })
      } catch (error) {
        this.append({ event: "review_child_interrupt_error", taskId: admission.taskId, childId: admission.childThreadId, message: String(error) })
      }
      if (this.graph.edge(admission.childThreadId)?.state === "open") this.graph.close(admission.childThreadId, "timed_out")
      this.reviewAdmissions.markTerminal(admission.taskId, "timed_out", "absolute 30 minute review deadline exceeded")
      await this.fail(`review child ${admission.taskId} exceeded its absolute deadline`, "LOST", 1)
      return
    }
  }

  private async deliverPendingWakes(): Promise<void> {
    for (const edge of this.graph.pendingResumes()) {
      if (edge.transport === "explicit_child") {
        this.graph.markResumeDelivered(edge.childId)
        continue
      }
      if (this.state === "ROOT_DRAINING") {
        // The parent turn already reached a terminal state. Recording delivery
        // closes the outbox without injecting a meaningless post-terminal turn.
        this.graph.markResumeDelivered(edge.childId)
        continue
      }
      if (this.state !== "ROOT_RUNNING" || edge.parentId !== this.rootThreadId || !this.rootThreadId || !this.rootTurnId || !edge.wakeId) continue
      try {
        const parent = await this.options.appServer.request<Record<string, unknown>>("thread/read", { threadId: edge.parentId, includeTurns: true })
        if (JSON.stringify(parent).includes(edge.wakeId)) {
          this.graph.markResumeDelivered(edge.childId)
          continue
        }
      } catch (error) {
        this.append({ event: "parent_wake_history_error", childId: edge.childId, wakeId: edge.wakeId, message: String(error) })
      }
      const age = edge.closedAt ? Date.now() - Date.parse(edge.closedAt) : 0
      if ((edge.wakeAttempts ?? 0) >= 2 || age >= (this.options.deadlines?.parentResumeMs ?? DEADLINES.parentResumeMs)) {
        await this.fail(`parent wake delivery exhausted for child ${edge.childId}`, "LOST", 1)
        return
      }
      this.graph.markResumeAttempt(edge.childId)
      try {
        await this.options.appServer.request("turn/steer", {
          threadId: this.rootThreadId,
          expectedTurnId: this.rootTurnId,
          clientUserMessageId: edge.wakeId,
          input: [{
            type: "text",
            text: `Supervisor reconciliation observed child ${edge.childId} terminal state ${edge.terminalState}. Continue the active task. Idempotency key: ${edge.wakeId}`,
          }],
        })
        this.graph.markResumeDelivered(edge.childId)
        this.append({ event: "parent_wake_delivered", childId: edge.childId, wakeId: edge.wakeId })
      } catch (error) {
        this.append({ event: "parent_wake_error", childId: edge.childId, wakeId: edge.wakeId, message: String(error) })
      }
    }
  }

  private async finalizeSuccess(resuming = false): Promise<void> {
    if (this.settled || ((this.finalizationAttempt || this.finalizing) && !resuming)) return
    if (!resuming) {
      const explicit = await this.reconcileExplicitChildren()
      if (this.settled || !explicit) return
      const native = this.graph.openEdges()
      if (explicit.active.length || native.length) {
        this.append({
          event: "child_appeared_before_finalization",
          nativeCount: native.length,
          explicitCount: explicit.active.length,
        })
        return
      }
    }
    this.finalizationAttempt = true
    if (this.options.drainUsage) {
      try {
        await this.options.drainUsage()
        if (this.settled) return
      } catch (error) {
        await this.fail(`provider usage drain failed: ${error instanceof Error ? error.message : String(error)}`, "FAILED", 1)
        return
      }
    }
    if (this.restartTask) await this.restartTask
    if (this.settled || this.terminalIntent) return
    if (!resuming) {
      const explicit = await this.reconcileExplicitChildren()
      if (this.settled || !explicit) return
      const native = this.graph.openEdges()
      if (explicit.active.length || native.length) {
        this.append({
          event: "child_appeared_during_finalization_drain",
          nativeCount: native.length,
          explicitCount: explicit.active.length,
        })
        this.finalizationAttempt = false
        if (this.deferredAppServerExit && !this.restartTask) {
          const deferred = this.deferredAppServerExit
          this.deferredAppServerExit = undefined
          this.restartTask = this.restartAppServer(deferred).finally(() => {
            this.restartTask = undefined
          })
          await this.restartTask
          if (this.settled) return
        }
        return
      }
    }
    if (this.pendingProviderUsage.size) {
      await this.fail(
        `raw response attribution missing for ${this.pendingProviderUsage.size} provider completion(s)`,
        "FAILED",
        1,
      )
      return
    }
    if (this.usage.hasBlockingAnomalies()) {
      await this.fail("unresolved TOKEN_ANOMALY blocks finalization", "FAILED", 1)
      return
    }
    try {
      this.reviewAdmissions.assertFinalizable(this.options.task === "pr_opened" && Boolean(this.options.executionMode))
    } catch (error) {
      await this.fail(error instanceof Error ? error.message : String(error), "FAILED", 1)
      return
    }
    this.finalizing = true
    if (!resuming) {
      this.finalizationInputProvenanceSha256 = this.provenance.head ?? undefined
      this.finalizationPhase = "prepared"
      this.transition("FINALIZING", "validating completion")
    }
    else this.append({ event: "finalizer_resumed", rootThreadId: this.rootThreadId, rootTurnId: this.rootTurnId })
    try {
      const provenanceHead = this.finalizationInputProvenanceSha256
      if (!this.rootThreadId || !this.rootTurnId || !provenanceHead) throw new Error("finalizer context is incomplete")
      this.finalizerIdempotencyKey ??= finalizerIdempotencyKey(
        this.options.runId,
        this.rootThreadId,
        this.rootTurnId,
        provenanceHead,
      )
      const finalizerContext = {
            runId: this.options.runId,
            task: this.options.task,
            rootThreadId: this.rootThreadId,
            rootTurnId: this.rootTurnId,
            preterminalProvenanceSha256: provenanceHead,
            idempotencyKey: this.finalizerIdempotencyKey,
          }
      if (this.finalizationPhase !== "attested") {
        this.finalizerAttestation = this.options.finalizer
          ? await this.options.finalizer(finalizerContext)
          : { status: "not_required", preterminalProvenanceSha256: provenanceHead, idempotency_key: finalizerContext.idempotencyKey }
        if (this.settled) return
      }
      if (this.options.finalizer) {
        const attestation = record(this.finalizerAttestation)
        const evidenceProvenance = text(attestation.provenance_sha256)
        const preterminalProvenance = text(attestation.preterminal_provenance_sha256) ?? evidenceProvenance
        if (
          attestation.valid !== true ||
          attestation.run_id !== finalizerContext.runId ||
          attestation.idempotency_key !== finalizerContext.idempotencyKey ||
          !evidenceProvenance || !this.provenance.has(evidenceProvenance) ||
          preterminalProvenance !== finalizerContext.preterminalProvenanceSha256
        ) throw new Error("finalizer attestation does not bind the current run and provenance head")
      }
      this.finalizationPhase = "attested"
      this.writeRunManifest()
      await this.stopAppServer()
      if (this.settled) return
      this.transition("SUCCEEDED", "finalizer passed")
      this.settle(this.result("SUCCEEDED", 0))
    } catch (error) {
      if (this.settled) return
      await this.stopAppServer()
      if (this.settled) return
      this.settle(await this.fail(error instanceof Error ? error.message : String(error), "FAILED", 1))
    }
  }

  private async abort(reason: string, state: SupervisorState, exitCode?: number): Promise<void> {
    if (this.settled || this.terminalIntent) return
    const result = this.beginTerminal(reason, state, exitCode ?? (state === "CANCELLED" ? 130 : 1))
    const shutdownDeadlineAt = Math.min(this.wholeRunDeadlineAt + 30_000, Date.now() + 30_000)
    try {
      if (this.rootThreadId && this.rootTurnId) {
        const remainingMs = Math.max(0, shutdownDeadlineAt - Date.now())
        const graceMs = Math.min(this.options.deadlines?.interruptGraceMs ?? DEADLINES.interruptGraceMs, remainingMs)
        let timeout: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          this.options.appServer.request("turn/interrupt", { threadId: this.rootThreadId, turnId: this.rootTurnId }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`turn interrupt exceeded ${graceMs}ms grace`)), graceMs)
          }),
        ]).finally(() => { if (timeout) clearTimeout(timeout) })
      }
    } catch (error) {
      this.append({ event: "interrupt_error", message: String(error) })
    }
    await this.withShutdownBudget(this.interruptExplicitChildren(reason), shutdownDeadlineAt)
    await this.stopAppServer(shutdownDeadlineAt)
    this.settle(result)
  }

  private async fail(reason: string, state: SupervisorState, exitCode: number): Promise<SupervisorResult> {
    if (this.settled) return this.terminalResult ?? this.result(state, exitCode)
    if (this.terminalIntent) return this.terminalIntent
    const result = this.beginTerminal(reason, state, exitCode)
    const shutdownDeadlineAt = Date.now() + 30_000
    await this.withShutdownBudget(this.interruptExplicitChildren(reason), shutdownDeadlineAt)
    await this.stopAppServer(shutdownDeadlineAt)
    this.settle(result)
    return result
  }

  private beginTerminal(reason: string, state: SupervisorState, exitCode: number): SupervisorResult {
    this.terminalReason = reason
    this.transition(state, reason)
    const result = this.result(state, exitCode)
    this.terminalIntent = result
    return result
  }

  private result(state: SupervisorState, exitCode: number): SupervisorResult {
    return { state, exitCode, rootThreadId: this.rootThreadId, rootTurnId: this.rootTurnId, terminalReason: this.terminalReason, usage: this.usage.budget }
  }

  private settle(result: SupervisorResult): void {
    if (this.settled) return
    this.settled = true
    this.terminalResult = result
    this.terminalIntent = result
    if (this.runTimer) clearTimeout(this.runTimer)
    if (this.noProgressTimer) clearInterval(this.noProgressTimer)
    if (this.reconcileTimer) clearInterval(this.reconcileTimer)
    this.append({ event: "terminal", state: result.state, reason: result.terminalReason, rootThreadId: result.rootThreadId, rootTurnId: result.rootTurnId, usage: result.usage })
    this.options.assertWriterOwnership?.()
    durableWriteFile(join(this.options.workdir, "ctx", "codex", "terminal.json"), `${JSON.stringify(result, null, 2)}\n`)
    this.writeRunManifest()
    this.resolveTurn?.(result)
  }

  private transition(next: SupervisorState, reason: string): void {
    const previous = this.state
    this.state = next
    this.append({ event: "state", stateFrom: previous, stateTo: next, reason, at: new Date().toISOString(), lastEventAt: this.lastEventAt })
    this.writeRunManifest()
  }

  private append(value: unknown): void {
    this.options.assertWriterOwnership?.()
    appendFileSync(this.eventsPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 })
    const event = record(value).event
    if (event !== "delta" && event !== "thread_status") {
      this.provenance.record(typeof event === "string" && event ? event : "supervisor_event", value)
    }
  }

  private async stopAppServer(shutdownDeadlineAt?: number): Promise<void> {
    try {
      if (shutdownDeadlineAt === undefined) {
        await this.options.appServer.stop()
        return
      }
      const remainingMs = Math.max(0, shutdownDeadlineAt - Date.now())
      await this.options.appServer.stop({
        // The JSON-RPC interrupt has already had its bounded chance above.
        interruptGraceMs: 0,
        termGraceMs: Math.min(DEADLINES.termGraceMs, Math.max(0, remainingMs - 5_000)),
        killGraceMs: Math.min(5_000, remainingMs),
      })
    } catch (error) {
      this.append({ event: "stop_error", message: String(error) })
    }
  }

  private async withShutdownBudget(task: Promise<void>, deadlineAt: number): Promise<void> {
    const remainingMs = Math.max(0, deadlineAt - Date.now())
    let timeout: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    try {
      await Promise.race([
        task,
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => { timedOut = true; resolve() }, remainingMs)
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
      if (!timedOut) await task.catch(() => undefined)
      else void task.catch(() => undefined)
    }
  }

  private async interruptExplicitChildren(reason: string, childIds?: readonly string[]): Promise<void> {
    if (!this.explicitChildren) return
    try {
      await this.explicitChildren.interruptActive(reason, childIds)
    } catch (error) {
      this.append({ event: "explicit_child_interrupt_error", reason, message: String(error) })
    }
  }

  private writeRunManifest(): void {
    this.options.assertWriterOwnership?.()
    const manifest = {
      schemaVersion: 1,
      runId: this.options.runId,
      task: this.options.task,
      codexVersion: this.options.codexVersion ?? "unknown",
      codex_v2_gate: this.options.codexV2Gate ?? "failed",
      execution_mode: this.options.executionMode ?? "explicit_child",
      capabilityReason: this.options.capabilityReason,
      state: this.state,
      rootThreadId: this.rootThreadId,
      rootTurnId: this.rootTurnId,
      rootSessionId: this.rootSessionId,
      startedAt: this.startedAt,
      wholeRunDeadlineAt: new Date(this.wholeRunDeadlineAt).toISOString(),
      lastSemanticProgressAt: this.lastSemanticProgressAt,
      drainDeadlineAt: this.drainDeadlineAt ? new Date(this.drainDeadlineAt).toISOString() : undefined,
      restartAttempts: this.restartAttempts,
      resumeState: this.resumeState,
      lastRestartAt: this.lastRestartAt,
      lastResumeError: this.lastResumeError,
      terminalReason: this.terminalReason,
      usage: this.usage.budget,
      provenance: { entries: this.provenance.length, headSha256: this.provenance.head },
      finalizerAttestation: this.finalizerAttestation,
      finalizationInputProvenanceSha256: this.finalizationInputProvenanceSha256,
      finalizerIdempotencyKey: this.finalizerIdempotencyKey,
      finalizationPhase: this.finalizationPhase,
      pendingProviderUsage: this.pendingProviderUsage.size ? [...this.pendingProviderUsage.values()] : undefined,
      reviewAdmissions: this.reviewAdmissions.summary(),
      updatedAt: new Date().toISOString(),
    }
    durableWriteFile(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  private childStateCounts(): Record<string, number> {
    const result: Record<string, number> = {}
    for (const edge of this.graph.edges()) {
      const state = edge.state === "open" ? "running" : edge.terminalState ?? "closed"
      result[state] = (result[state] ?? 0) + 1
    }
    return result
  }
}

// Wire notification handling without exposing mutable internals in the public
// constructor. The app-server callback is installed before start so no startup
// event can be lost.
export function createSupervisor(options: Omit<SupervisorOptions, "appServer"> & { appServer?: CodexAppServer }): Supervisor {
  let supervisor: Supervisor
  const appServer = options.appServer ?? new CodexAppServer({
    codexBin: process.env.CODEX_BIN ?? "codex",
    codexHome: options.codexHome,
    cwd: options.repoDir,
    env: { ...buildCodexEnvironment(process.env), CODEX_HOME: options.codexHome },
    onNotification: (notification) => supervisor.handleNotification(notification),
    onStderr: options.onAppServerStderr,
    onExit: (event) => supervisor.handleAppServerExit(event),
    processRecordPath: options.processRecordPath,
    runId: options.runId,
    writerFence: options.writerFence,
  })
  supervisor = new Supervisor({ ...options, appServer })
  return supervisor
}
