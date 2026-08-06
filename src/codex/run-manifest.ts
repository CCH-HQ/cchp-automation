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

export interface SupervisorResumeState {
  state: "ROOT_RUNNING" | "ROOT_DRAINING" | "FINALIZING"
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
}

export interface RunManifest {
  schemaVersion: 1
  runId: string
  task: string
  state: SupervisorState
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
  expected: { runId?: string; task?: string } = {},
): RunManifest | undefined {
  const path = runManifestPath(workdir)
  if (!existsSync(path)) return undefined
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("run manifest must be a regular file")
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  const runId = nonEmpty(value.runId)
  const task = nonEmpty(value.task)
  const state = value.state as SupervisorState
  const updatedAt = nonEmpty(value.updatedAt)
  if (
    value.schemaVersion !== 1 || !runId || !task || !updatedAt ||
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
    updatedAt,
  }
}

export function resumeStateFromManifest(manifest: RunManifest): SupervisorResumeState {
  return {
    state: manifest.state as SupervisorResumeState["state"],
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
  }
}
