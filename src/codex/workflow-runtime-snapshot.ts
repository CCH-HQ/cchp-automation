#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { progressMarkerKey, trustedBotLogin } from "../publish/sticky"
import { directoryIdentity, durableCreateFile } from "./durable-file"
import { redactRuntimeDiagnostic } from "./diagnostic-redaction"
import { ChildGraph } from "./graph"
import { openRegularFileSnapshot } from "./file-snapshot"
import { parseProgressPublication, type ProgressPublicationRecord } from "./progress-publication"
import { parseTodoLedger } from "./progress"
import type { SupervisorState } from "./supervisor"
import {
  parsePreparedFinalizedReviewPublication,
  type PreparedFinalizedReviewPublication,
} from "../publish/finalized-review"

type Env = Record<string, string | undefined>

const SNAPSHOT_MARKER = "cchp_workflow_runtime_snapshot"
const TERMINAL_STATES = new Set<SupervisorState>([
  "SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED", "LOST", "TOKEN_BUDGET_EXCEEDED",
  "NO_PROGRESS_TIMEOUT",
])

export interface SafeTerminalRecord {
  state: SupervisorState
  exitCode: number
  terminalReason?: string
  finalMessage?: string
  runtime?: { codexVersion: string; executionMode: "native_v2" | "explicit_child" }
  rootThreadPresent: boolean
  rootTurnPresent: boolean
  usage: {
    acceptedRaw: boolean
    consumed: number
    limit: number
    fraction: number
    state: "normal" | "warning" | "throttled" | "exceeded"
    blockingAnomalies: number
    responses: number
    turns: number
    admissionDenials: number
    reservedTokens?: number
    responsesInFlight?: number
  }
}

export interface RuntimeTodoProjection {
  ledger: "absent" | "invalid" | "valid"
  revision: number
  total: number
  completed: number
  in_progress: number
  pending: number
  cancelled: number
}

export interface RuntimeChildrenProjection {
  ledger: "absent" | "invalid" | "valid"
  total: number
  open: number
  closed: number
  by_transport: { native_v2: number; explicit_child: number }
  by_terminal_state: { completed: number; failed: number; timed_out: number; interrupted: number; lost: number }
}

export interface RuntimeReviewSummaryProjection {
  ledger: "absent" | "invalid" | "valid"
  repository?: string
  prNumber?: number
  headSha?: string
  ownerLogin?: string
  primaryCommentId?: number
  parts?: Array<{ commentId: number; marker: string; sha256: string }>
  inlineComments?: Array<{
    commentId: number
    fingerprint: string
    commitId: string
    path: string
    line: number
    side: "LEFT" | "RIGHT"
    startLine?: number
    startSide?: "LEFT" | "RIGHT"
    bodySha256: string
  }>
  formalReview?: { reviewId: number; commitId: string; state: string; bodySha256: string }
}

export interface WorkflowRuntimeSnapshot {
  schemaVersion: 1
  marker: typeof SNAPSHOT_MARKER
  identity: {
    githubRunId: string
    githubRunAttempt: string
    engineRunId: string
    task: string
    progressMarker: string
    codexVersion?: string
    executionMode?: "native_v2" | "explicit_child"
  }
  terminal: {
    ledger: "absent" | "invalid" | "valid"
    sha256: string | null
    record?: SafeTerminalRecord
  }
  progress: {
    ledger: "absent" | "invalid" | "valid"
    sha256: string | null
    record?: ProgressPublicationRecord
  }
  todo: RuntimeTodoProjection
  children: RuntimeChildrenProjection
  reviewSummary: RuntimeReviewSummaryProjection
  preparedReview: {
    ledger: "absent" | "invalid" | "valid"
    sha256: string | null
    record?: PreparedFinalizedReviewPublication
  }
  capturedAt: string
}

function finiteNonNegative(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

function safeInteger(value: unknown, fallback = 0): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback
}

function diagnosticSecrets(env: Env): string[] {
  return Object.entries(env)
    .filter(([key, value]) => /(?:token|secret|password|private[_-]?key|api[_-]?key)/i.test(key) && Boolean(value))
    .map(([, value]) => value!)
}

function engineRunId(workdir: string, task: string, env: Env): string {
  const path = join(workdir, "ctx", "codex", "run-manifest.json")
  if (!existsSync(path)) return env.BOT_RUN_ID || env.GITHUB_RUN_ID || "unknown"
  const value = JSON.parse(openRegularFileSnapshot(path).bytes.toString("utf8")) as Record<string, unknown>
  if (value.schemaVersion !== 1 || typeof value.runId !== "string" || !value.runId) {
    throw new Error("runtime snapshot run manifest identity is invalid")
  }
  if (value.task !== task) throw new Error("runtime snapshot run manifest task mismatch")
  return value.runId
}

function runtimeIdentity(workdir: string): Pick<WorkflowRuntimeSnapshot["identity"], "codexVersion" | "executionMode"> {
  const path = join(workdir, "ctx", "codex", "run-manifest.json")
  if (!existsSync(path)) return {}
  try {
    const value = JSON.parse(openRegularFileSnapshot(path).bytes.toString("utf8")) as Record<string, unknown>
    const codexVersion = typeof value.codexVersion === "string" && value.codexVersion ? value.codexVersion : undefined
    const executionMode = value.execution_mode === "native_v2" || value.execution_mode === "explicit_child"
      ? value.execution_mode
      : undefined
    return {
      ...(codexVersion ? { codexVersion } : {}),
      ...(executionMode ? { executionMode } : {}),
    }
  } catch {
    return {}
  }
}

function safeTerminal(value: unknown, env: Env): SafeTerminalRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.state !== "string" || !TERMINAL_STATES.has(record.state as SupervisorState)) return undefined
  const usage = record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)
    ? record.usage as Record<string, unknown>
    : {}
  const consumed = finiteNonNegative(usage.consumed, -1)
  const limit = finiteNonNegative(usage.limit, -1)
  if (consumed < 0 || limit < 0) return undefined
  const usageState = usage.state === "warning" || usage.state === "throttled" || usage.state === "exceeded"
    ? usage.state
    : "normal"
  const rawReason = typeof record.terminalReason === "string" ? record.terminalReason : undefined
  const terminalReason = rawReason
    ? redactRuntimeDiagnostic(rawReason, diagnosticSecrets(env)).slice(0, 4_096)
    : undefined
  const rawMessage = typeof record.finalMessage === "string" ? record.finalMessage : undefined
  const finalMessage = rawMessage
    ? redactRuntimeDiagnostic(rawMessage, diagnosticSecrets(env)).slice(0, 16_000)
    : undefined
  const runtime = record.runtime && typeof record.runtime === "object" && !Array.isArray(record.runtime)
    ? record.runtime as Record<string, unknown>
    : undefined
  const codexVersion = typeof runtime?.codexVersion === "string" && runtime.codexVersion ? runtime.codexVersion : undefined
  const executionMode = runtime?.executionMode === "native_v2" || runtime?.executionMode === "explicit_child"
    ? runtime.executionMode
    : undefined
  return {
    state: record.state as SupervisorState,
    exitCode: Number.isSafeInteger(record.exitCode) ? Number(record.exitCode) : 0,
    ...(terminalReason ? { terminalReason } : {}),
    ...(finalMessage ? { finalMessage } : {}),
    ...(codexVersion && executionMode ? { runtime: { codexVersion, executionMode } } : {}),
    rootThreadPresent: record.rootThreadPresent === true || (typeof record.rootThreadId === "string" && Boolean(record.rootThreadId)),
    rootTurnPresent: record.rootTurnPresent === true || (typeof record.rootTurnId === "string" && Boolean(record.rootTurnId)),
    usage: {
      acceptedRaw: usage.acceptedRaw === true,
      consumed,
      limit,
      fraction: finiteNonNegative(usage.fraction, limit > 0 ? consumed / limit : 0),
      state: usageState,
      blockingAnomalies: safeInteger(usage.blockingAnomalies),
      responses: safeInteger(usage.responses),
      turns: safeInteger(usage.turns),
      admissionDenials: safeInteger(usage.admissionDenials),
      ...(Number.isSafeInteger(usage.reservedTokens) && Number(usage.reservedTokens) >= 0
        ? { reservedTokens: Number(usage.reservedTokens) }
        : {}),
      ...(Number.isSafeInteger(usage.responsesInFlight) && Number(usage.responsesInFlight) >= 0
        ? { responsesInFlight: Number(usage.responsesInFlight) }
        : {}),
    },
  }
}

function todoProjection(workdir: string): RuntimeTodoProjection {
  const empty = { revision: 0, total: 0, completed: 0, in_progress: 0, pending: 0, cancelled: 0 }
  const path = join(workdir, "ctx", "codex", "todo.json")
  if (!existsSync(path)) return { ledger: "absent", ...empty }
  try {
    const ledger = parseTodoLedger(JSON.parse(openRegularFileSnapshot(path).bytes.toString("utf8")))
    const counts = { completed: 0, in_progress: 0, pending: 0, cancelled: 0 }
    for (const item of ledger.todos) {
      if (item.status === "completed" || item.status === "in_progress" || item.status === "cancelled") counts[item.status]++
      else counts.pending++
    }
    return { ledger: "valid", revision: ledger.revision, total: ledger.todos.length, ...counts }
  } catch {
    return { ledger: "invalid", ...empty }
  }
}

function childrenProjection(workdir: string): RuntimeChildrenProjection {
  const empty = {
    total: 0,
    open: 0,
    closed: 0,
    by_transport: { native_v2: 0, explicit_child: 0 },
    by_terminal_state: { completed: 0, failed: 0, timed_out: 0, interrupted: 0, lost: 0 },
  }
  const path = join(workdir, "ctx", "codex", "graph.jsonl")
  if (!existsSync(path)) return { ledger: "absent", ...empty }
  try {
    const edges = ChildGraph.fromSnapshot(openRegularFileSnapshot(path).bytes, path).edges()
    const projection: RuntimeChildrenProjection = { ledger: "valid", ...structuredClone(empty) }
    projection.total = edges.length
    for (const edge of edges) {
      projection.by_transport[edge.transport]++
      if (edge.state === "open") projection.open++
      else {
        projection.closed++
        if (edge.terminalState) projection.by_terminal_state[edge.terminalState]++
      }
    }
    return projection
  } catch {
    return { ledger: "invalid", ...empty }
  }
}

function reviewSummaryProjection(workdir: string, env: Env): RuntimeReviewSummaryProjection {
  const path = join(workdir, "ctx", "codex", "review-publication.json")
  if (!existsSync(path)) return { ledger: "absent" }
  try {
    const value = JSON.parse(openRegularFileSnapshot(path).bytes.toString("utf8")) as Record<string, unknown>
    const parts = Array.isArray(value.summaryParts) ? value.summaryParts : []
    const repository = typeof value.repository === "string" ? value.repository : ""
    const prNumber = Number.isSafeInteger(value.prNumber) ? Number(value.prNumber) : 0
    const headSha = typeof value.headSha === "string" ? value.headSha : ""
    const ownerLogin = trustedBotLogin(env)
    const primaryCommentId = Number.isSafeInteger(value.summaryCommentId) ? Number(value.summaryCommentId) : 0
    const inlineComments = (Array.isArray(value.inlineComments) ? value.inlineComments : []).map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid inline attestation")
      const record = entry as Record<string, unknown>
      const commentId = Number.isSafeInteger(record.commentId) ? Number(record.commentId) : 0
      const fingerprint = typeof record.fingerprint === "string" ? record.fingerprint : ""
      const commitId = typeof record.commitId === "string" ? record.commitId : ""
      const path = typeof record.path === "string" ? record.path : ""
      const line = Number.isSafeInteger(record.line) ? Number(record.line) : 0
      const side: "LEFT" | "RIGHT" | undefined = record.side === "LEFT" || record.side === "RIGHT" ? record.side : undefined
      const startLine = record.startLine === undefined ? undefined : Number(record.startLine)
      const startSide: "LEFT" | "RIGHT" | undefined = record.startSide === undefined
        ? undefined
        : record.startSide === "LEFT" || record.startSide === "RIGHT" ? record.startSide : undefined
      const bodySha256 = typeof record.bodySha256 === "string" ? record.bodySha256 : ""
      if (
        commentId <= 0 || !/^[a-f0-9]{64}$/.test(fingerprint) || commitId !== headSha || !path || line <= 0 || !side ||
        (startLine !== undefined && (!Number.isSafeInteger(startLine) || startLine <= 0 || !startSide)) ||
        !/^[a-f0-9]{64}$/.test(bodySha256)
      ) throw new Error("invalid inline attestation")
      return { commentId, fingerprint, commitId, path, line, side, ...(startLine === undefined ? {} : { startLine, startSide }), bodySha256 }
    })
    const formalValue = value.formalReview
    if (!formalValue || typeof formalValue !== "object" || Array.isArray(formalValue)) throw new Error("invalid formal review attestation")
    const formalRecord = formalValue as Record<string, unknown>
    const formalReview = {
      reviewId: Number.isSafeInteger(formalRecord.reviewId) ? Number(formalRecord.reviewId) : 0,
      commitId: typeof formalRecord.commitId === "string" ? formalRecord.commitId : "",
      state: typeof formalRecord.state === "string" ? formalRecord.state : "",
      bodySha256: typeof formalRecord.bodySha256 === "string" ? formalRecord.bodySha256 : "",
    }
    const parsedParts = parts.map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) throw new Error("invalid summary part")
      const record = part as Record<string, unknown>
      const commentId = Number.isSafeInteger(record.commentId) ? Number(record.commentId) : 0
      const marker = typeof record.marker === "string" ? record.marker : ""
      const sha256 = typeof record.sha256 === "string" ? record.sha256 : ""
      if (commentId <= 0 || !/^cchp-review-report:[A-Za-z0-9._:-]+$/.test(marker) || !/^[a-f0-9]{64}$/.test(sha256)) {
        throw new Error("invalid summary part")
      }
      return { commentId, marker, sha256 }
    })
    if (
      value.schemaVersion !== 2 || value.phase !== "complete" || !repository || prNumber <= 0 || !headSha ||
      !ownerLogin || primaryCommentId <= 0 || !parsedParts.length || parsedParts[0]!.commentId !== primaryCommentId ||
      new Set(parsedParts.map((part) => part.commentId)).size !== parsedParts.length ||
      new Set(parsedParts.map((part) => part.marker)).size !== parsedParts.length ||
      new Set(inlineComments.map((entry) => entry.commentId)).size !== inlineComments.length ||
      new Set(inlineComments.map((entry) => entry.fingerprint)).size !== inlineComments.length ||
      formalReview.reviewId <= 0 || formalReview.commitId !== headSha || !formalReview.state || !/^[a-f0-9]{64}$/.test(formalReview.bodySha256) ||
      (env.BOT_REPO || env.GH_REPO) !== repository || Number(env.BOT_PR_NUMBER) !== prNumber || env.BOT_HEAD_SHA !== headSha
    ) return { ledger: "invalid" }
    return { ledger: "valid", repository, prNumber, headSha, ownerLogin, primaryCommentId, parts: parsedParts, inlineComments, formalReview }
  } catch {
    return { ledger: "invalid" }
  }
}

function preparedReviewProjection(workdir: string, env: Env): WorkflowRuntimeSnapshot["preparedReview"] {
  const path = join(workdir, "ctx", "codex", "prepared-review-publication.json")
  if (!existsSync(path)) return { ledger: "absent", sha256: null }
  try {
    const snapshot = openRegularFileSnapshot(path)
    if (snapshot.nlink !== 1) throw new Error("prepared review publication must have one link")
    const record = parsePreparedFinalizedReviewPublication(JSON.parse(snapshot.bytes.toString("utf8")))
    const repository = env.BOT_REPO || env.GH_REPO
    const prNumber = Number(env.BOT_PR_NUMBER)
    const headSha = env.BOT_HEAD_SHA
    const runId = engineRunId(workdir, env.BOT_TASK || "unknown", env)
    if (
      env.BOT_TASK !== "pr_opened" || !repository || !Number.isSafeInteger(prNumber) || prNumber <= 0 || !headSha ||
      record.repository !== repository || record.prNumber !== prNumber || record.marker.head_sha !== headSha ||
      record.marker.run_id !== runId
    ) throw new Error("prepared review publication target mismatch")
    return {
      ledger: "valid",
      sha256: snapshot.sha256,
      record,
    }
  } catch {
    return { ledger: "invalid", sha256: null }
  }
}

function captureTerminal(workdir: string, env: Env): WorkflowRuntimeSnapshot["terminal"] {
  const path = join(workdir, "ctx", "codex", "terminal.json")
  if (!existsSync(path)) return { ledger: "absent", sha256: null }
  let snapshot
  try {
    snapshot = openRegularFileSnapshot(path)
  } catch {
    return { ledger: "invalid", sha256: null }
  }
  try {
    const record = safeTerminal(JSON.parse(snapshot.bytes.toString("utf8")), env)
    return record
      ? { ledger: "valid", sha256: snapshot.sha256, record }
      : { ledger: "invalid", sha256: snapshot.sha256 }
  } catch {
    return { ledger: "invalid", sha256: snapshot.sha256 }
  }
}

function captureProgress(workdir: string, marker: string): WorkflowRuntimeSnapshot["progress"] {
  const path = join(workdir, "ctx", "codex", "progress-publication.json")
  if (!existsSync(path)) return { ledger: "absent", sha256: null }
  let snapshot
  try {
    snapshot = openRegularFileSnapshot(path)
  } catch {
    return { ledger: "invalid", sha256: null }
  }
  try {
    const record = parseProgressPublication(JSON.parse(snapshot.bytes.toString("utf8")), marker)
    return { ledger: "valid", sha256: snapshot.sha256, record }
  } catch {
    return { ledger: "invalid", sha256: snapshot.sha256 }
  }
}

function validateProjectionCounts(value: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) throw new Error(`runtime snapshot ${key} is invalid`)
  }
}

export function parseWorkflowRuntimeSnapshot(value: unknown, env: Env = {}): WorkflowRuntimeSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("runtime snapshot must be an object")
  const snapshot = value as WorkflowRuntimeSnapshot
  if (snapshot.schemaVersion !== 1 || snapshot.marker !== SNAPSHOT_MARKER) throw new Error("unsupported runtime snapshot schema")
  if (!snapshot.identity || typeof snapshot.identity !== "object") throw new Error("runtime snapshot identity is missing")
  for (const key of ["githubRunId", "githubRunAttempt", "engineRunId", "task", "progressMarker"] as const) {
    if (typeof snapshot.identity[key] !== "string" || !snapshot.identity[key]) throw new Error(`runtime snapshot identity ${key} is invalid`)
  }
  if (snapshot.identity.codexVersion !== undefined &&
      (typeof snapshot.identity.codexVersion !== "string" || !snapshot.identity.codexVersion)) {
    throw new Error("runtime snapshot Codex version is invalid")
  }
  if (snapshot.identity.executionMode !== undefined &&
      snapshot.identity.executionMode !== "native_v2" && snapshot.identity.executionMode !== "explicit_child") {
    throw new Error("runtime snapshot execution mode is invalid")
  }
  const expected = {
    githubRunId: env.GITHUB_RUN_ID,
    githubRunAttempt: env.GITHUB_RUN_ATTEMPT,
    engineRunId: env.CCHP_ENGINE_RUN_ID,
    task: env.BOT_TASK,
    progressMarker: env.BOT_TASK ? progressMarkerKey(env.BOT_TASK) : undefined,
  }
  for (const [key, wanted] of Object.entries(expected)) {
    if (wanted && snapshot.identity[key as keyof typeof snapshot.identity] !== wanted) {
      throw new Error(`runtime snapshot identity ${key} mismatch`)
    }
  }
  for (const source of [snapshot.terminal, snapshot.progress]) {
    if (!source || !["absent", "invalid", "valid"].includes(source.ledger)) throw new Error("runtime snapshot ledger state is invalid")
    if (source.sha256 !== null && (typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256))) {
      throw new Error("runtime snapshot source hash is invalid")
    }
    if (source.ledger === "valid" && (!source.record || !source.sha256)) throw new Error("runtime snapshot valid source is incomplete")
  }
  const terminal = snapshot.terminal.record ? safeTerminal(snapshot.terminal.record, {}) : undefined
  if (snapshot.terminal.ledger === "valid" && !terminal) throw new Error("runtime snapshot terminal record is invalid")
  const progress = snapshot.progress.record
    ? parseProgressPublication(snapshot.progress.record, snapshot.identity.progressMarker)
    : undefined
  if (snapshot.progress.ledger === "valid" && !progress) throw new Error("runtime snapshot progress record is invalid")
  if (!snapshot.todo || !["absent", "invalid", "valid"].includes(snapshot.todo.ledger)) throw new Error("runtime snapshot todo is invalid")
  validateProjectionCounts(snapshot.todo as unknown as Record<string, unknown>, ["revision", "total", "completed", "in_progress", "pending", "cancelled"])
  if (snapshot.todo.total !== snapshot.todo.completed + snapshot.todo.in_progress + snapshot.todo.pending + snapshot.todo.cancelled) {
    throw new Error("runtime snapshot todo counts are inconsistent")
  }
  if (!snapshot.children || !["absent", "invalid", "valid"].includes(snapshot.children.ledger)) throw new Error("runtime snapshot children are invalid")
  validateProjectionCounts(snapshot.children as unknown as Record<string, unknown>, ["total", "open", "closed"])
  if (snapshot.children.total !== snapshot.children.open + snapshot.children.closed) throw new Error("runtime snapshot child counts are inconsistent")
  for (const count of Object.values(snapshot.children.by_transport ?? {})) if (!Number.isSafeInteger(count) || count < 0) throw new Error("runtime snapshot child transport count is invalid")
  for (const count of Object.values(snapshot.children.by_terminal_state ?? {})) if (!Number.isSafeInteger(count) || count < 0) throw new Error("runtime snapshot child terminal count is invalid")
  const reviewSummary = snapshot.reviewSummary ?? { ledger: "absent" as const }
  if (!["absent", "invalid", "valid"].includes(reviewSummary.ledger)) {
    throw new Error("runtime snapshot review summary is invalid")
  }
  if (reviewSummary.ledger === "valid") {
    const review = reviewSummary
    if (
      !review.repository || !review.ownerLogin || !review.headSha || !Number.isSafeInteger(review.prNumber) || Number(review.prNumber) <= 0 ||
      !Number.isSafeInteger(review.primaryCommentId) || Number(review.primaryCommentId) <= 0 || !review.parts?.length ||
      review.parts[0]!.commentId !== review.primaryCommentId || new Set(review.parts.map((part) => part.commentId)).size !== review.parts.length
      || new Set(review.parts.map((part) => part.marker)).size !== review.parts.length
      || !Array.isArray(review.inlineComments) || !review.formalReview
    ) throw new Error("runtime snapshot review summary is incomplete")
    for (const part of review.parts) {
      if (!Number.isSafeInteger(part.commentId) || part.commentId <= 0 || !/^cchp-review-report:[A-Za-z0-9._:-]+$/.test(part.marker) || !/^[a-f0-9]{64}$/.test(part.sha256)) {
        throw new Error("runtime snapshot review summary part is invalid")
      }
    }
    if (
      new Set(review.inlineComments.map((entry) => entry.commentId)).size !== review.inlineComments.length ||
      new Set(review.inlineComments.map((entry) => entry.fingerprint)).size !== review.inlineComments.length
    ) throw new Error("runtime snapshot inline attestation is duplicated")
    for (const entry of review.inlineComments) {
      if (
        !Number.isSafeInteger(entry.commentId) || entry.commentId <= 0 || !/^[a-f0-9]{64}$/.test(entry.fingerprint) ||
        entry.commitId !== review.headSha || !entry.path || !Number.isSafeInteger(entry.line) || entry.line <= 0 ||
        !["LEFT", "RIGHT"].includes(entry.side) || !/^[a-f0-9]{64}$/.test(entry.bodySha256)
      ) throw new Error("runtime snapshot inline attestation is invalid")
    }
    if (
      !Number.isSafeInteger(review.formalReview.reviewId) || review.formalReview.reviewId <= 0 ||
      review.formalReview.commitId !== review.headSha || !review.formalReview.state ||
      !/^[a-f0-9]{64}$/.test(review.formalReview.bodySha256)
    ) throw new Error("runtime snapshot formal review attestation is invalid")
  }
  const preparedReview = snapshot.preparedReview ?? { ledger: "absent" as const, sha256: null }
  if (!["absent", "invalid", "valid"].includes(preparedReview.ledger)) {
    throw new Error("runtime snapshot prepared review is invalid")
  }
  if (preparedReview.ledger === "valid") {
    if (!preparedReview.record || !/^[a-f0-9]{64}$/.test(preparedReview.sha256 ?? "")) {
      throw new Error("runtime snapshot prepared review is incomplete")
    }
    const prepared = parsePreparedFinalizedReviewPublication(preparedReview.record)
    if (prepared.marker.run_id !== snapshot.identity.engineRunId) {
      throw new Error("runtime snapshot prepared review run mismatch")
    }
    const expectedRepository = env.BOT_REPO || env.GH_REPO
    if (expectedRepository && prepared.repository !== expectedRepository) {
      throw new Error("runtime snapshot prepared review repository mismatch")
    }
    if (env.BOT_PR_NUMBER && prepared.prNumber !== Number(env.BOT_PR_NUMBER)) {
      throw new Error("runtime snapshot prepared review PR mismatch")
    }
    if (env.BOT_HEAD_SHA && prepared.marker.head_sha !== env.BOT_HEAD_SHA) {
      throw new Error("runtime snapshot prepared review head mismatch")
    }
    if (reviewSummary.ledger === "valid" && preparedReview.record.repository !== reviewSummary.repository) {
      throw new Error("runtime snapshot prepared and published review targets disagree")
    }
  } else if (preparedReview.record !== undefined || preparedReview.sha256 !== null) {
    throw new Error("runtime snapshot invalid prepared review carries trusted data")
  }
  if (typeof snapshot.capturedAt !== "string" || Number.isNaN(Date.parse(snapshot.capturedAt))) throw new Error("runtime snapshot timestamp is invalid")
  return {
    ...snapshot,
    terminal: { ...snapshot.terminal, ...(terminal ? { record: terminal } : {}) },
    progress: { ...snapshot.progress, ...(progress ? { record: progress } : {}) },
    reviewSummary,
    preparedReview,
  }
}

export function writeWorkflowRuntimeSnapshot(env: Env = process.env): { path: string; sha256: string } {
  const workdir = env.BOT_WORKDIR
  const path = env.CCHP_RUNTIME_SNAPSHOT_PATH
  if (!workdir) throw new Error("BOT_WORKDIR is required for runtime snapshot")
  if (!path) throw new Error("CCHP_RUNTIME_SNAPSHOT_PATH is required for runtime snapshot")
  const task = env.BOT_TASK || "unknown"
  const marker = progressMarkerKey(task)
  const snapshot: WorkflowRuntimeSnapshot = {
    schemaVersion: 1,
    marker: SNAPSHOT_MARKER,
    identity: {
      githubRunId: env.GITHUB_RUN_ID || "unknown",
      githubRunAttempt: env.GITHUB_RUN_ATTEMPT || "1",
      engineRunId: engineRunId(workdir, task, env),
      task,
      progressMarker: marker,
      ...runtimeIdentity(workdir),
    },
    terminal: captureTerminal(workdir, env),
    progress: captureProgress(workdir, marker),
    todo: todoProjection(workdir),
    children: childrenProjection(workdir),
    reviewSummary: reviewSummaryProjection(workdir, env),
    preparedReview: preparedReviewProjection(workdir, env),
    capturedAt: new Date().toISOString(),
  }
  parseWorkflowRuntimeSnapshot(snapshot, env)
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const content = `${JSON.stringify(snapshot, null, 2)}\n`
  const expectedSha256 = createHash("sha256").update(content).digest("hex")
  durableCreateFile(path, content, 0o600, directoryIdentity(parent))
  const written = openRegularFileSnapshot(path)
  if (written.nlink !== 1) throw new Error("runtime snapshot must be a single-link regular file")
  if (written.sha256 !== expectedSha256) throw new Error("runtime snapshot changed after durable creation")
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `path=${path}\nsha256=${written.sha256}\n`)
  return { path, sha256: written.sha256 }
}

export function readWorkflowRuntimeSnapshot(path: string, expectedSha256: string, env: Env = {}): WorkflowRuntimeSnapshot {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("expected runtime snapshot sha256 is invalid")
  const snapshot = openRegularFileSnapshot(path)
  if (snapshot.nlink !== 1) throw new Error("runtime snapshot must be a single-link regular file")
  if (snapshot.sha256 !== expectedSha256) throw new Error("runtime snapshot hash mismatch")
  return parseWorkflowRuntimeSnapshot(JSON.parse(snapshot.bytes.toString("utf8")), env)
}

if (import.meta.main) {
  try {
    const result = writeWorkflowRuntimeSnapshot()
    process.stdout.write(`[workflow-runtime-snapshot] wrote ${result.path}\n`)
  } catch (error) {
    process.stderr.write(`[workflow-runtime-snapshot] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
