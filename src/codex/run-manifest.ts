import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { SupervisorState } from "./supervisor"
import type { ProviderBridgeUsage } from "./provider-bridge"

const TERMINAL_STATES = new Set<SupervisorState>([
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "LOST",
  "TOKEN_BUDGET_EXCEEDED",
  "NO_PROGRESS_TIMEOUT",
])

const RESUMABLE_STATES = new Set<SupervisorState>(["ROOT_RUNNING", "ROOT_DRAINING", "FINALIZING"])

export interface ReviewContinuationState {
  schemaVersion: 1
  clientUserMessageId: string
  phase: "prepared" | "dispatching" | "started" | "completed"
  initialTurnId: string
  continuationTurnId?: string
}

export function reviewContinuationClientMessageId(
  runId: string,
  rootThreadId: string,
  initialTurnId: string,
): string {
  const digest = createHash("sha256")
    .update(`${runId}\0${rootThreadId}\0${initialTurnId}\0review-zero-admission-continuation`)
    .digest("hex")
  return `cchp-review-continuation-${digest}`
}

export interface SupervisorResumeState {
  state: "ROOT_RUNNING" | "ROOT_DRAINING" | "FINALIZING"
  executionMode?: "native_v2" | "explicit_child"
  rootThreadId: string
  rootTurnId?: string
  restartAttempts: number
  rootSessionId?: string
  startedAt?: string
  wholeRunDeadlineAt?: string
  lastSemanticProgressAt?: string
  drainDeadlineAt?: string
  finalizationInputProvenanceSha256?: string
  finalizerIdempotencyKey?: string
  finalizationPhase?: "prepared" | "attested"
  finalizerAttestation?: unknown
  pendingProviderUsage?: ProviderBridgeUsage[]
  reviewContinuation?: ReviewContinuationState
}

export interface RunManifest {
  schemaVersion: 1
  runId: string
  task: string
  state: SupervisorState
  execution_mode: "native_v2" | "explicit_child"
  rootThreadId?: string
  rootTurnId?: string
  restartAttempts: number
  resumeState?: "idle" | "restarting" | "resumed" | "failed"
  lastRestartAt?: string
  lastResumeError?: string
  rootSessionId?: string
  startedAt: string
  wholeRunDeadlineAt: string
  lastSemanticProgressAt: string
  drainDeadlineAt?: string
  finalizationInputProvenanceSha256?: string
  finalizerIdempotencyKey?: string
  finalizationPhase?: "prepared" | "attested"
  finalizerAttestation?: unknown
  pendingProviderUsage?: ProviderBridgeUsage[]
  reviewContinuation?: ReviewContinuationState
  updatedAt: string
  [key: string]: unknown
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function timestamp(value: unknown, name: string): string {
  const result = nonEmpty(value)
  if (!result || !Number.isFinite(Date.parse(result))) throw new Error(`run manifest has invalid ${name}`)
  return result
}

function reviewContinuation(
  value: unknown,
  runId: string,
  task: string,
  state: SupervisorState,
  rootThreadId: string,
  rootTurnId?: string,
): ReviewContinuationState | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("run manifest reviewContinuation must be an object")
  }
  if (task !== "pr_opened") throw new Error("run manifest reviewContinuation is only valid for pr_opened")
  const candidate = value as Record<string, unknown>
  const clientUserMessageId = nonEmpty(candidate.clientUserMessageId)
  const initialTurnId = nonEmpty(candidate.initialTurnId)
  const continuationTurnId = nonEmpty(candidate.continuationTurnId)
  const phase = candidate.phase
  if (
    candidate.schemaVersion !== 1 || !clientUserMessageId || !initialTurnId ||
    !["prepared", "dispatching", "started", "completed"].includes(String(phase))
  ) throw new Error("run manifest has invalid reviewContinuation")
  if (clientUserMessageId !== reviewContinuationClientMessageId(runId, rootThreadId, initialTurnId)) {
    throw new Error("run manifest reviewContinuation client message identity drift")
  }
  if (continuationTurnId === initialTurnId) {
    throw new Error("run manifest reviewContinuation must own a distinct continuation turn")
  }
  if (phase === "prepared" || phase === "dispatching") {
    if (continuationTurnId || state !== "ROOT_DRAINING" || rootTurnId !== initialTurnId) {
      throw new Error(`run manifest reviewContinuation phase ${phase} has invalid root ownership`)
    }
  } else {
    if (!continuationTurnId || rootTurnId !== continuationTurnId) {
      throw new Error(`run manifest reviewContinuation phase ${phase} has invalid turn ownership`)
    }
    if (phase === "started" && state !== "ROOT_RUNNING") {
      throw new Error("run manifest started reviewContinuation must be ROOT_RUNNING")
    }
    if (phase === "completed" && !["ROOT_DRAINING", "FINALIZING"].includes(state)) {
      throw new Error("run manifest completed reviewContinuation must be draining or finalizing")
    }
  }
  return {
    schemaVersion: 1,
    clientUserMessageId,
    phase: phase as ReviewContinuationState["phase"],
    initialTurnId,
    ...(continuationTurnId ? { continuationTurnId } : {}),
  }
}

export function runManifestPath(workdir: string): string {
  return join(workdir, "ctx", "codex", "run-manifest.json")
}

export function hasDurableRunState(workdir: string): boolean {
  const codexDir = join(workdir, "ctx", "codex")
  return ["supervisor.jsonl", "provenance.jsonl", "usage.jsonl", "graph.jsonl", "todo.json", "terminal.json"]
    .some((name) => existsSync(join(codexDir, name)))
}

export function readRunManifest(
  workdir: string,
  expected: { runId?: string; task?: string; executionMode?: "native_v2" | "explicit_child" } = {},
): RunManifest | undefined {
  const path = runManifestPath(workdir)
  if (!existsSync(path)) return undefined
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("run manifest must be a regular file")
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  const runId = nonEmpty(value.runId)
  const task = nonEmpty(value.task)
  const state = value.state as SupervisorState
  const executionMode = value.execution_mode === "native_v2" || value.execution_mode === "explicit_child"
    ? value.execution_mode
    : undefined
  const updatedAt = nonEmpty(value.updatedAt)
  if (
    value.schemaVersion !== 1 || !runId || !task || !updatedAt || !executionMode ||
    ![
      "INIT", "CONFIGURED", "ROOT_STARTING", "ROOT_RUNNING", "ROOT_DRAINING",
      "FINALIZING", "SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED", "LOST",
      "TOKEN_BUDGET_EXCEEDED", "NO_PROGRESS_TIMEOUT",
    ].includes(state)
  ) throw new Error("invalid run manifest")
  if (expected.runId && expected.runId !== runId) {
    throw new Error(`run manifest run id mismatch: expected ${expected.runId}, got ${runId}`)
  }
  if (expected.task && expected.task !== task) {
    throw new Error(`run manifest task mismatch: expected ${expected.task}, got ${task}`)
  }
  if (expected.executionMode && expected.executionMode !== executionMode) {
    throw new Error(`run manifest execution mode mismatch: expected ${expected.executionMode}, got ${executionMode}`)
  }
  if (TERMINAL_STATES.has(state)) throw new Error(`terminal run manifest cannot be resumed: ${state}`)
  if (!RESUMABLE_STATES.has(state)) {
    throw new Error(`run manifest state ${state} has no safely resumable root ownership`)
  }
  const rootThreadId = nonEmpty(value.rootThreadId)
  if (!rootThreadId) throw new Error("resumable run manifest is missing rootThreadId")
  const restartAttempts = value.restartAttempts === undefined ? 0 : Number(value.restartAttempts)
  if (!Number.isSafeInteger(restartAttempts) || restartAttempts < 0) {
    throw new Error("run manifest has invalid restartAttempts")
  }
  const startedAt = timestamp(value.startedAt, "startedAt")
  const wholeRunDeadlineAt = timestamp(value.wholeRunDeadlineAt, "wholeRunDeadlineAt")
  const lastSemanticProgressAt = timestamp(value.lastSemanticProgressAt, "lastSemanticProgressAt")
  if (Date.parse(wholeRunDeadlineAt) <= Date.parse(startedAt)) {
    throw new Error("run manifest wholeRunDeadlineAt must be after startedAt")
  }
  const drainDeadlineAt = value.drainDeadlineAt === undefined
    ? undefined
    : timestamp(value.drainDeadlineAt, "drainDeadlineAt")
  if ((state === "ROOT_DRAINING" || state === "FINALIZING") && !drainDeadlineAt) {
    throw new Error(`run manifest state ${state} is missing drainDeadlineAt`)
  }
  const finalizationInputProvenanceSha256 = nonEmpty(value.finalizationInputProvenanceSha256)
  const finalizerIdempotencyKey = nonEmpty(value.finalizerIdempotencyKey)
  const finalizationPhase = value.finalizationPhase === "prepared" || value.finalizationPhase === "attested"
    ? value.finalizationPhase
    : undefined
  if (state === "FINALIZING" && (!finalizationInputProvenanceSha256 || !/^[0-9a-f]{64}$/.test(finalizationInputProvenanceSha256) || !finalizationPhase)) {
    throw new Error("run manifest FINALIZING state has incomplete finalization ownership")
  }
  if (finalizationPhase === "attested" && value.finalizerAttestation === undefined) {
    throw new Error("run manifest attested finalization is missing its attestation")
  }
  const parsedReviewContinuation = reviewContinuation(
    value.reviewContinuation,
    runId,
    task,
    state,
    rootThreadId,
    nonEmpty(value.rootTurnId),
  )
  let pendingProviderUsage: ProviderBridgeUsage[] | undefined
  if (value.pendingProviderUsage !== undefined) {
    if (!Array.isArray(value.pendingProviderUsage)) throw new Error("run manifest pendingProviderUsage must be an array")
    pendingProviderUsage = value.pendingProviderUsage.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`run manifest pendingProviderUsage[${index}] is invalid`)
      }
      const candidate = item as Record<string, unknown>
      if (
        typeof candidate.providerId !== "string" || !candidate.providerId ||
        typeof candidate.model !== "string" || !candidate.model ||
        typeof candidate.responseId !== "string" || !candidate.responseId ||
        !Number.isSafeInteger(candidate.totalTokens) || Number(candidate.totalTokens) < 0 ||
        !Number.isSafeInteger(candidate.inputTokens) || Number(candidate.inputTokens) < 0 ||
        !Number.isSafeInteger(candidate.outputTokens) || Number(candidate.outputTokens) < 0
      ) throw new Error(`run manifest pendingProviderUsage[${index}] is invalid`)
      for (const field of ["contextInputTokens", "billableInputTokens", "cachedInputTokens", "cacheWriteInputTokens", "reasoningOutputTokens", "contextWindow"]) {
        if (candidate[field] !== undefined && (!Number.isSafeInteger(candidate[field]) || Number(candidate[field]) < 0)) {
          throw new Error(`run manifest pendingProviderUsage[${index}] has invalid ${field}`)
        }
      }
      for (const field of ["threadId", "turnId"]) {
        if (candidate[field] !== undefined && (typeof candidate[field] !== "string" || !candidate[field])) {
          throw new Error(`run manifest pendingProviderUsage[${index}] has invalid ${field}`)
        }
      }
      return candidate as unknown as ProviderBridgeUsage
    })
  }
  return {
    ...value,
    schemaVersion: 1,
    runId,
    task,
    state,
    execution_mode: executionMode,
    rootThreadId,
    rootTurnId: nonEmpty(value.rootTurnId),
    restartAttempts,
    resumeState: ["idle", "restarting", "resumed", "failed"].includes(String(value.resumeState))
      ? value.resumeState as RunManifest["resumeState"]
      : undefined,
    lastRestartAt: nonEmpty(value.lastRestartAt),
    lastResumeError: nonEmpty(value.lastResumeError),
    rootSessionId: nonEmpty(value.rootSessionId),
    startedAt,
    wholeRunDeadlineAt,
    lastSemanticProgressAt,
    drainDeadlineAt,
    finalizationInputProvenanceSha256,
    finalizerIdempotencyKey,
    finalizationPhase,
    finalizerAttestation: value.finalizerAttestation,
    pendingProviderUsage,
    reviewContinuation: parsedReviewContinuation,
    updatedAt,
  }
}

export function resumeStateFromManifest(manifest: RunManifest): SupervisorResumeState {
  return {
    state: manifest.state as SupervisorResumeState["state"],
    executionMode: manifest.execution_mode,
    rootThreadId: manifest.rootThreadId!,
    rootTurnId: manifest.rootTurnId,
    restartAttempts: manifest.restartAttempts,
    rootSessionId: manifest.rootSessionId,
    startedAt: manifest.startedAt,
    wholeRunDeadlineAt: manifest.wholeRunDeadlineAt,
    lastSemanticProgressAt: manifest.lastSemanticProgressAt,
    drainDeadlineAt: manifest.drainDeadlineAt,
    finalizationInputProvenanceSha256: manifest.finalizationInputProvenanceSha256,
    finalizerIdempotencyKey: manifest.finalizerIdempotencyKey,
    finalizationPhase: manifest.finalizationPhase,
    finalizerAttestation: manifest.finalizerAttestation,
    pendingProviderUsage: manifest.pendingProviderUsage,
    reviewContinuation: manifest.reviewContinuation,
  }
}
