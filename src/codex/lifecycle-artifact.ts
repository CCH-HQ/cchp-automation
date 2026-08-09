#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { progressMarkerKey } from "../publish/sticky"
import { directoryIdentity, durableCreateFile } from "./durable-file"
import { exitCodeFor } from "./exit"
import { ChildGraph } from "./graph"
import { openRegularFileSnapshot } from "./file-snapshot"
import {
  parseSupervisorTerminal,
  resolveWorkflowTerminal,
  workflowStepOutcomes,
  type WorkflowStepOutcomes,
} from "./finalize-workflow-progress"
import { readProgressPublicationSnapshot } from "./progress-publication"
import { parseTodoLedger } from "./progress"
import { readWorkflowFinalization } from "./workflow-finalization"
import { readWorkflowRuntimeSnapshot } from "./workflow-runtime-snapshot"

type Env = Record<string, string | undefined>

function positiveInt(value: unknown): number | undefined {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : undefined
}

function subject(env: Env): Record<string, unknown> {
  const repository = env.BOT_REPO ?? env.GH_REPO ?? "unknown/unknown"
  for (const [kind, key] of [["pull_request", "BOT_PR_NUMBER"], ["issue", "BOT_ISSUE_NUMBER"], ["discussion", "BOT_DISCUSSION_NUMBER"]] as const) {
    const number = positiveInt(env[key])
    if (number) return { repository, kind, number }
  }
  const workflowRun = env.BOT_TASK === "ci_fix" ? positiveInt(env.CCHP_WORKFLOW_RUN_ID ?? env.BOT_RUN_ID) : undefined
  if (workflowRun) return { repository, kind: "workflow_run", number: workflowRun }
  return { repository, kind: "repository" }
}

type JsonReadResult =
  | { state: "absent" }
  | { state: "invalid" }
  | { state: "valid"; value: Record<string, unknown> }

function readJson(path: string): JsonReadResult {
  try {
    const parsed = JSON.parse(openRegularFileSnapshot(path).bytes.toString("utf8")) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { state: "valid", value: parsed as Record<string, unknown> }
      : { state: "invalid" }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "invalid" }
  }
}

function workflowProjection(outcomes: WorkflowStepOutcomes, env: Env): Record<string, string> {
  return {
    write: outcomes.needsWrite ? outcomes.write || "did_not_run" : "not_required",
    install: outcomes.install || "did_not_run",
    prepare: outcomes.prepare || "did_not_run",
    scan: outcomes.scan || "did_not_run",
    capability: outcomes.capability || "did_not_run",
    supervisor: outcomes.supervisor || "did_not_run",
    progress_finalizer: env.CCHP_FINALIZER_OUTCOME || "did_not_run",
    ...Object.fromEntries(Object.entries(outcomes.lifecycle ?? {}).map(([name, outcome]) => [`lifecycle_${name}`, outcome])),
  }
}

function childProjection(workdir: string): Record<string, unknown> {
  const path = join(workdir, "ctx", "codex", "graph.jsonl")
  let edges: ReturnType<ChildGraph["edges"]> = []
  let ledger = "absent"
  if (existsSync(path)) {
    try {
      edges = ChildGraph.fromSnapshot(openRegularFileSnapshot(path).bytes, path).edges()
      ledger = "valid"
    } catch {
      ledger = "invalid"
    }
  }
  const byTransport = { native_v2: 0, explicit_child: 0 }
  const byTerminalState: Record<string, number> = { completed: 0, failed: 0, timed_out: 0, interrupted: 0, lost: 0 }
  let open = 0
  for (const edge of edges) {
    byTransport[edge.transport]++
    if (edge.state === "open") open++
    else if (edge.terminalState) byTerminalState[edge.terminalState]++
  }
  return {
    ledger,
    total: edges.length,
    open,
    closed: edges.length - open,
    by_transport: byTransport,
    by_terminal_state: byTerminalState,
  }
}

function progressProjection(
  workdir: string,
  marker: string,
): { projection: Record<string, unknown>; sha256: string | null; commentId?: number; action?: "created" | "updated" } {
  const path = join(workdir, "ctx", "codex", "progress-publication.json")
  if (!existsSync(path)) return { projection: { ledger: "absent", publication: "unknown", finalized: false }, sha256: null }
  try {
    const snapshot = readProgressPublicationSnapshot(path, marker)
    if (!snapshot) return { projection: { ledger: "absent", publication: "unknown", finalized: false }, sha256: null }
    return progressRecordProjection(snapshot.record, snapshot.sha256)
  } catch {
    return { projection: { ledger: "invalid", publication: "unknown", finalized: false }, sha256: null }
  }
}

function progressRecordProjection(
  value: NonNullable<ReturnType<typeof readProgressPublicationSnapshot>>["record"],
  sha256: string,
): { projection: Record<string, unknown>; sha256: string; commentId?: number; action?: "created" | "updated" } {
  return {
    projection: {
      ledger: "valid",
      ...(value.commentId ? { comment_id: value.commentId } : {}),
      ...(value.action ? { last_action: value.action } : {}),
      created_count: value.createdCount,
      updated_count: value.updatedCount,
      finalized: value.finalized,
      publication: value.publication,
    },
    sha256,
    ...(value.commentId ? { commentId: value.commentId } : {}),
    ...(value.action ? { action: value.action } : {}),
  }
}

function todoProjection(workdir: string): Record<string, unknown> {
  const snapshot = readJson(join(workdir, "ctx", "codex", "todo.json"))
  const empty = { revision: 0, total: 0, completed: 0, in_progress: 0, pending: 0, cancelled: 0 }
  if (snapshot.state === "absent") return { ledger: "absent", ...empty }
  if (snapshot.state === "invalid") return { ledger: "invalid", ...empty }
  let ledger
  try {
    ledger = parseTodoLedger(snapshot.value)
  } catch {
    return { ledger: "invalid", ...empty }
  }
  const counts = { completed: 0, in_progress: 0, pending: 0, cancelled: 0 }
  for (const item of ledger.todos) {
    const status = item.status
    if (status === "completed" || status === "in_progress" || status === "cancelled") counts[status]++
    else counts.pending++
  }
  return { ledger: "valid", revision: ledger.revision, total: ledger.todos.length, ...counts }
}

function usageProjection(terminal: Record<string, unknown> | undefined, fallback: ReturnType<typeof resolveWorkflowTerminal>["usage"]): Record<string, unknown> {
  const raw = terminal?.usage && typeof terminal.usage === "object" && !Array.isArray(terminal.usage)
    ? terminal.usage as Record<string, unknown>
    : {}
  const metric = (key: string, defaultValue: number): number => Number.isSafeInteger(raw[key]) && Number(raw[key]) >= 0
    ? Number(raw[key])
    : defaultValue
  const state = raw.state === "normal" || raw.state === "warning" || raw.state === "throttled" || raw.state === "exceeded"
    ? raw.state
    : fallback.state
  return {
    consumed: metric("consumed", fallback.consumed),
    reserved: metric("reservedTokens", fallback.reservedTokens ?? 0),
    in_flight: metric("responsesInFlight", fallback.responsesInFlight ?? 0),
    limit: metric("limit", fallback.limit),
    state,
    responses: metric("responses", fallback.responses),
    turns: metric("turns", fallback.turns),
    blocking_anomalies: metric("blockingAnomalies", fallback.blockingAnomalies),
    admission_denials: metric("admissionDenials", fallback.admissionDenials),
    response_limit: metric("responseLimit", 0),
    input_tokens: metric("inputTokens", 0),
    context_input_tokens: metric("contextInputTokens", 0),
    cached_input_tokens: metric("cachedInputTokens", 0),
    output_tokens: metric("outputTokens", 0),
    reasoning_output_tokens: metric("reasoningOutputTokens", 0),
    max_response_tokens: metric("maxResponseTokens", 0),
    max_context_input_tokens: metric("maxContextInputTokens", 0),
  }
}

export function writeLifecycleArtifact(env: Env = process.env): string {
  const phase = env.CCHP_LIFECYCLE_ARTIFACT_PHASE === "final_candidate" ? "final_candidate" : "primary"
  const workdir = env.BOT_WORKDIR
  const runtimeSnapshotPath = env.CCHP_RUNTIME_SNAPSHOT_PATH
  const runtimeSnapshotSha256 = env.CCHP_RUNTIME_SNAPSHOT_SHA256
  if (!workdir && !runtimeSnapshotPath) throw new Error("BOT_WORKDIR or CCHP_RUNTIME_SNAPSHOT_PATH is required for lifecycle artifact")
  if (Boolean(runtimeSnapshotPath) !== Boolean(runtimeSnapshotSha256)) {
    throw new Error("runtime snapshot path and sha256 must be provided together")
  }
  const runtimeSnapshot = runtimeSnapshotPath
    ? readWorkflowRuntimeSnapshot(runtimeSnapshotPath, runtimeSnapshotSha256!, env)
    : undefined
  const outcomes = workflowStepOutcomes(env)
  const terminalPath = workdir ? join(workdir, "ctx", "codex", "terminal.json") : undefined
  const liveTerminalSnapshot = terminalPath && existsSync(terminalPath) ? openRegularFileSnapshot(terminalPath) : undefined
  const terminalRecord = runtimeSnapshot?.terminal.record as unknown as Record<string, unknown> | undefined ?? (liveTerminalSnapshot
    ? (() => {
        try {
          const value = JSON.parse(liveTerminalSnapshot.bytes.toString("utf8")) as unknown
          return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
        } catch {
          return undefined
        }
      })()
    : undefined)
  const terminalSha256 = runtimeSnapshot?.terminal.sha256 ?? liveTerminalSnapshot?.sha256 ?? null
  const terminal = parseSupervisorTerminal(terminalRecord)
  const result = resolveWorkflowTerminal(outcomes, terminal)
  const checkpointRecord = runtimeSnapshot?.checkpoint?.record as unknown as Record<string, unknown> | undefined
  const evidenceRecord = terminalRecord ?? checkpointRecord
  const marker = progressMarkerKey(env.BOT_TASK || "task")
  const stagedProgressPath = env.CCHP_PROGRESS_PUBLICATION_PATH || (runtimeSnapshotPath
    ? join(dirname(runtimeSnapshotPath), "progress-publication.json")
    : undefined)
  const progress: ReturnType<typeof progressProjection> = stagedProgressPath && existsSync(stagedProgressPath)
    ? (() => {
        try {
          const snapshot = readProgressPublicationSnapshot(stagedProgressPath, marker)
          return snapshot
            ? progressRecordProjection(snapshot.record, snapshot.sha256)
            : { projection: { ledger: "absent", publication: "unknown", finalized: false }, sha256: null }
        } catch {
          return { projection: { ledger: "invalid", publication: "unknown", finalized: false }, sha256: null }
        }
      })()
    : runtimeSnapshot?.progress.ledger === "valid"
      ? progressRecordProjection(runtimeSnapshot.progress.record!, runtimeSnapshot.progress.sha256!)
      : runtimeSnapshot
        ? { projection: { ledger: runtimeSnapshot.progress.ledger, publication: "unknown", finalized: false }, sha256: runtimeSnapshot.progress.sha256 }
        : progressProjection(workdir!, marker)
  let finalizationPublication = "not_required"
  if (env.CCHP_WORKFLOW_FINALIZATION_PATH) {
    const finalization = readWorkflowFinalization(env.CCHP_WORKFLOW_FINALIZATION_PATH).record
    if (finalization.terminalSha256 !== terminalSha256) {
      throw new Error("workflow finalization terminal snapshot hash mismatch")
    }
    if (finalization.resolvedState !== result.state) throw new Error("workflow finalization state mismatch")
    if (finalization.reasonCode !== result.reasonCode) throw new Error("workflow finalization reason code mismatch")
    if (finalization.progressPublicationSha256 !== progress.sha256) {
      throw new Error("workflow finalization progress snapshot hash mismatch")
    }
    if (finalization.commentId !== progress.commentId || finalization.action !== progress.action) {
      throw new Error("workflow finalization progress identity mismatch")
    }
    if (
      finalization.publication === "published" &&
      (progress.projection.publication !== "published" || progress.projection.finalized !== true)
    ) throw new Error("workflow finalization publication semantics mismatch")
    finalizationPublication = finalization.publication
  }
  const directory = env.CCHP_LIFECYCLE_ARTIFACT_DIR || (runtimeSnapshotPath
    ? join(dirname(runtimeSnapshotPath), "actions-lifecycle")
    : join(workdir!, "ctx", "actions-lifecycle"))
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const runId = env.BOT_RUN_ID || env.GITHUB_RUN_ID || "unknown"
  const resolvedFromSupervisor = Boolean(terminal) && result.state === terminal!.state && [
    "supervisor_succeeded",
    "workflow_cancelled",
    "supervisor_timeout",
    "token_budget_exceeded",
    "supervisor_failed",
  ].includes(result.reasonCode)
  const report = {
    schema_version: 2,
    artifact_kind: "cchp_actions_lifecycle",
    artifact_phase: phase,
    authority: phase === "primary" ? "provisional" : "pre_transport_bound",
    run: {
      github_run_id: env.GITHUB_RUN_ID || "unknown",
      github_run_attempt: positiveInt(env.GITHUB_RUN_ATTEMPT) ?? 1,
      engine_run_id: runtimeSnapshot?.identity.engineRunId ?? runId,
      task: env.BOT_TASK || "unknown",
      updated_at: new Date().toISOString(),
    },
    subject: subject(env),
    progress_comment: progress.projection,
    todo: runtimeSnapshot?.todo ?? todoProjection(workdir!),
    root: {
      state: result.state,
      exit_code: exitCodeFor(
        result.state,
        resolvedFromSupervisor && Number.isSafeInteger(terminalRecord?.exitCode) ? Number(terminalRecord?.exitCode) : 0,
      ),
      thread_present: evidenceRecord?.rootThreadPresent === true || (typeof evidenceRecord?.rootThreadId === "string" && Boolean(evidenceRecord.rootThreadId)),
      turn_present: evidenceRecord?.rootTurnPresent === true || (typeof evidenceRecord?.rootTurnId === "string" && Boolean(evidenceRecord.rootTurnId)),
      reason_code: result.reasonCode,
    },
    children: runtimeSnapshot?.children ?? childProjection(workdir!),
    usage: usageProjection(evidenceRecord, result.usage),
    runtime: {
      codex_version: runtimeSnapshot?.identity.codexVersion ?? (terminalRecord?.runtime as { codexVersion?: string } | undefined)?.codexVersion ?? null,
      execution_mode: runtimeSnapshot?.identity.executionMode ?? (terminalRecord?.runtime as { executionMode?: string } | undefined)?.executionMode ?? null,
      cleanup: outcomes.lifecycle?.environment_cleanup ?? null,
    },
    workflow: { ...workflowProjection(outcomes, env), finalization_record: finalizationPublication },
    runtime_snapshot: runtimeSnapshotPath
      ? { source: "trusted_staging", sha256: runtimeSnapshotSha256 }
      : { source: "live_workdir", sha256: null },
  }
  const content = `${JSON.stringify(report, null, 2)}\n`
  const sha256 = createHash("sha256").update(content).digest("hex")
  const fileRunId = (env.GITHUB_RUN_ID || runId).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "unknown"
  const filename = `cchp-actions-lifecycle-${phase}-${fileRunId}-${positiveInt(env.GITHUB_RUN_ATTEMPT) ?? 1}-${sha256}.json`
  const path = join(directory, filename)
  durableCreateFile(path, content, 0o600, directoryIdentity(directory))
  verifyLifecycleArtifact(path, sha256)
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `path=${path}\nfilename=${filename}\nsha256=${sha256}\n`)
  process.stdout.write(`[lifecycle-artifact] wrote ${path}\n`)
  return path
}

export function verifyLifecycleArtifact(path: string, expectedSha256: string): void {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("expected lifecycle sha256 is invalid")
  const snapshot = openRegularFileSnapshot(path)
  if (snapshot.nlink !== 1) throw new Error("lifecycle artifact must be a single-link regular file")
  if (snapshot.sha256 !== expectedSha256) throw new Error("lifecycle artifact hash mismatch")
  const value = JSON.parse(snapshot.bytes.toString("utf8")) as Record<string, unknown>
  if (
    value.schema_version !== 2 || value.artifact_kind !== "cchp_actions_lifecycle" ||
    !["primary", "final_candidate"].includes(String(value.artifact_phase)) ||
    !["provisional", "pre_transport_bound"].includes(String(value.authority)) ||
    (value.artifact_phase === "primary" && value.authority !== "provisional") ||
    (value.artifact_phase === "final_candidate" && value.authority !== "pre_transport_bound")
  ) throw new Error("lifecycle artifact phase contract is invalid")
}

if (import.meta.main) {
  try {
    if (process.argv[2] === "--verify") {
      const path = process.env.CCHP_LIFECYCLE_ARTIFACT_PATH
      const sha256 = process.env.CCHP_LIFECYCLE_ARTIFACT_SHA256
      if (!path || !sha256) throw new Error("lifecycle verification path and sha256 are required")
      verifyLifecycleArtifact(path, sha256)
      process.stdout.write(`[lifecycle-artifact] verified ${path}\n`)
    } else {
      writeLifecycleArtifact()
    }
  } catch (error) {
    process.stderr.write(`[lifecycle-artifact] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
