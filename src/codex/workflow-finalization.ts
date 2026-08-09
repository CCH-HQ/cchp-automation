import { dirname } from "node:path"
import { mkdirSync } from "node:fs"
import type { SupervisorState } from "./supervisor"
import { durableWriteFile } from "./durable-file"
import { openRegularFileSnapshot } from "./file-snapshot"

const TERMINAL_STATES = new Set<SupervisorState>([
  "SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED", "LOST", "TOKEN_BUDGET_EXCEEDED",
  "NO_PROGRESS_TIMEOUT",
])

export const WORKFLOW_REASON_CODES = [
  "supervisor_succeeded",
  "workflow_cancelled",
  "write_token_setup_failed",
  "codex_install_failed",
  "environment_prepare_failed",
  "external_scan_failed",
  "capability_gate_failed",
  "supervisor_wrapper_failed",
  "supervisor_terminal_missing",
  "supervisor_failed",
  "supervisor_timeout",
  "token_budget_exceeded",
  "lifecycle_staging_failed",
  "lifecycle_evidence_failed",
  "lifecycle_verify_failed",
  "lifecycle_upload_failed",
  "lifecycle_uploaded_digest_failed",
  "lifecycle_roundtrip_staging_failed",
  "lifecycle_download_failed",
  "lifecycle_downloaded_digest_failed",
  "runtime_snapshot_failed",
  "environment_cleanup_failed",
  "final_lifecycle_staging_failed",
  "final_lifecycle_evidence_failed",
  "final_lifecycle_verify_failed",
  "final_lifecycle_upload_failed",
  "final_lifecycle_uploaded_digest_failed",
  "final_lifecycle_roundtrip_staging_failed",
  "final_lifecycle_download_failed",
  "final_lifecycle_downloaded_digest_failed",
  "invalid_artifact_cleanup_token_failed",
  "invalid_primary_artifact_cleanup_failed",
  "invalid_final_artifact_cleanup_failed",
  "progress_finalizer_failed",
] as const

export type WorkflowReasonCode = typeof WORKFLOW_REASON_CODES[number]

export interface WorkflowFinalizationRecord {
  schemaVersion: 1
  terminalSha256: string | null
  resolvedState: SupervisorState
  reasonCode: WorkflowReasonCode
  publication: "published" | "skipped" | "failed"
  progressPublicationSha256: string | null
  commentId?: number
  action?: "created" | "updated"
  recordedAt: string
}

function sha256(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : value === null ? null : ""
}

export function parseWorkflowFinalization(value: unknown): WorkflowFinalizationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workflow finalization record must be an object")
  const record = value as Partial<WorkflowFinalizationRecord>
  const terminalSha256 = sha256(record.terminalSha256)
  const progressPublicationSha256 = sha256(record.progressPublicationSha256)
  if (terminalSha256 === "" || progressPublicationSha256 === "") throw new Error("workflow finalization hash is invalid")
  if (record.schemaVersion !== 1) throw new Error("unsupported workflow finalization schema")
  if (typeof record.resolvedState !== "string" || !TERMINAL_STATES.has(record.resolvedState)) {
    throw new Error("workflow finalization state is invalid")
  }
  if (!WORKFLOW_REASON_CODES.includes(record.reasonCode as WorkflowReasonCode)) {
    throw new Error("workflow finalization reason code is invalid")
  }
  const fixedReason = record.resolvedState === "SUCCEEDED"
    ? "supervisor_succeeded"
    : record.resolvedState === "CANCELLED"
      ? "workflow_cancelled"
      : record.resolvedState === "TIMED_OUT" || record.resolvedState === "NO_PROGRESS_TIMEOUT"
        ? "supervisor_timeout"
        : record.resolvedState === "TOKEN_BUDGET_EXCEEDED"
          ? "token_budget_exceeded"
          : undefined
  if (fixedReason && record.reasonCode !== fixedReason) {
    throw new Error("workflow finalization state and reason code are inconsistent")
  }
  if (record.resolvedState !== "SUCCEEDED" && record.reasonCode === "supervisor_succeeded") {
    throw new Error("workflow finalization state and reason code are inconsistent")
  }
  if (record.publication !== "published" && record.publication !== "skipped" && record.publication !== "failed") {
    throw new Error("workflow finalization publication is invalid")
  }
  const commentId = Number.isSafeInteger(record.commentId) && Number(record.commentId) > 0 ? Number(record.commentId) : undefined
  const action = record.action === "created" || record.action === "updated" ? record.action : undefined
  if (record.commentId !== undefined && !commentId) throw new Error("workflow finalization comment id is invalid")
  if (record.action !== undefined && !action) throw new Error("workflow finalization action is invalid")
  if (Boolean(commentId) !== Boolean(action)) throw new Error("workflow finalization comment id and action must be paired")
  if (record.publication === "published" && (!progressPublicationSha256 || !commentId || !action)) {
    throw new Error("published workflow finalization is incomplete")
  }
  if (typeof record.recordedAt !== "string" || !record.recordedAt || Number.isNaN(Date.parse(record.recordedAt))) {
    throw new Error("workflow finalization timestamp is invalid")
  }
  return {
    schemaVersion: 1,
    terminalSha256,
    resolvedState: record.resolvedState,
    reasonCode: record.reasonCode as WorkflowReasonCode,
    publication: record.publication,
    progressPublicationSha256,
    ...(commentId ? { commentId } : {}),
    ...(action ? { action } : {}),
    recordedAt: record.recordedAt,
  }
}

export function readWorkflowFinalization(path: string): { record: WorkflowFinalizationRecord; sha256: string } {
  const snapshot = openRegularFileSnapshot(path)
  return {
    record: parseWorkflowFinalization(JSON.parse(snapshot.bytes.toString("utf8"))),
    sha256: snapshot.sha256,
  }
}

export function writeWorkflowFinalization(path: string, record: WorkflowFinalizationRecord): void {
  const parsed = parseWorkflowFinalization(record)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  durableWriteFile(path, `${JSON.stringify(parsed, null, 2)}\n`)
}
