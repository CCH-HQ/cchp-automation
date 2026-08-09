#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { splitRepo } from "../context"
import { makeOctokit, type GitHubClient } from "../github/client"
import { progressMarkerKey } from "../publish/sticky"
import { hidden, MARKER } from "../types"
import { publishFinalizedReview } from "../publish/finalized-review"
import { openRegularFileSnapshot } from "./file-snapshot"
import { readProgressPublicationSnapshot, recordProgressPublication, seedProgressPublication } from "./progress-publication"
import { createTerminalProgressPublisher, redactRuntimeDiagnostic, requiresReviewFinalization } from "./runtime"
import type { SupervisorResult, SupervisorState } from "./supervisor"
import { readWorkflowRuntimeSnapshot } from "./workflow-runtime-snapshot"
import {
  writeWorkflowFinalization,
  type WorkflowFinalizationRecord,
  type WorkflowReasonCode,
} from "./workflow-finalization"

type Env = Record<string, string | undefined>
type StepName = "write" | "install" | "prepare" | "scan" | "capability" | "supervisor"

const TERMINAL_STATES = new Set<SupervisorState>([
  "SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED", "LOST", "TOKEN_BUDGET_EXCEEDED",
  "NO_PROGRESS_TIMEOUT",
])

const ZERO_USAGE: SupervisorResult["usage"] = {
  acceptedRaw: false,
  consumed: 0,
  limit: 0,
  fraction: 0,
  state: "normal",
  blockingAnomalies: 0,
  responses: 0,
  turns: 0,
  admissionDenials: 0,
}

export interface WorkflowStepOutcomes {
  write: string
  needsWrite: boolean
  install: string
  prepare: string
  scan: string
  capability: string
  supervisor: string
  lifecycle?: Record<string, string>
  cancelled: boolean
}

export interface ResolvedWorkflowTerminal extends Pick<SupervisorResult, "state" | "terminalReason" | "usage"> {
  reasonCode: WorkflowReasonCode
}

export function workflowStepOutcomes(env: Env): WorkflowStepOutcomes {
  return {
    write: env.CCHP_WRITE_OUTCOME ?? "",
    needsWrite: env.CCHP_NEEDS_WRITE === "true" || env.CCHP_NEEDS_WRITE === "1",
    install: env.CCHP_INSTALL_OUTCOME ?? "",
    prepare: env.CCHP_PREPARE_OUTCOME ?? "",
    scan: env.CCHP_SCAN_OUTCOME ?? "",
    capability: env.CCHP_CAPABILITY_OUTCOME ?? "",
    supervisor: env.CCHP_SUPERVISOR_OUTCOME ?? "",
    lifecycle: Object.fromEntries([
      ["staging", env.CCHP_LIFECYCLE_STAGING_OUTCOME],
      ["evidence", env.CCHP_LIFECYCLE_EVIDENCE_OUTCOME],
      ["verify", env.CCHP_VERIFY_LIFECYCLE_OUTCOME],
      ["upload", env.CCHP_UPLOAD_LIFECYCLE_OUTCOME],
      ["uploaded_digest", env.CCHP_VERIFY_UPLOADED_LIFECYCLE_OUTCOME],
      ["roundtrip_staging", env.CCHP_LIFECYCLE_ROUNDTRIP_STAGING_OUTCOME],
      ["download", env.CCHP_DOWNLOAD_LIFECYCLE_OUTCOME],
      ["downloaded_digest", env.CCHP_VERIFY_DOWNLOADED_LIFECYCLE_OUTCOME],
      ["runtime_snapshot", env.CCHP_RUNTIME_SNAPSHOT_OUTCOME],
      ["environment_cleanup", env.CCHP_ENVIRONMENT_CLEANUP_OUTCOME],
      ...(env.CCHP_FINAL_CANDIDATE_REQUIRED === "true" ? [
        ["final_staging", env.CCHP_FINAL_LIFECYCLE_STAGING_OUTCOME],
        ["final_evidence", env.CCHP_FINAL_LIFECYCLE_EVIDENCE_OUTCOME],
        ["final_verify", env.CCHP_VERIFY_FINAL_LIFECYCLE_OUTCOME],
        ["final_upload", env.CCHP_UPLOAD_FINAL_LIFECYCLE_OUTCOME],
        ["final_uploaded_digest", env.CCHP_VERIFY_UPLOADED_FINAL_LIFECYCLE_OUTCOME],
        ["final_roundtrip_staging", env.CCHP_FINAL_LIFECYCLE_ROUNDTRIP_STAGING_OUTCOME],
        ["final_download", env.CCHP_DOWNLOAD_FINAL_LIFECYCLE_OUTCOME],
        ["final_downloaded_digest", env.CCHP_VERIFY_DOWNLOADED_FINAL_LIFECYCLE_OUTCOME],
      ] as Array<[string, string | undefined]> : []),
      ["progress_finalizer", env.CCHP_FINALIZER_OUTCOME],
      ...(env.CCHP_PRIMARY_ARTIFACT_INVALID === "true"
        ? [
            ["invalid_primary_cleanup_token", env.CCHP_INVALID_PRIMARY_ARTIFACT_CLEANUP_TOKEN_OUTCOME],
            ["invalid_primary_cleanup", env.CCHP_INVALID_PRIMARY_ARTIFACT_CLEANUP_OUTCOME],
          ] as Array<[string, string | undefined]>
        : []),
      ...(env.CCHP_FINAL_ARTIFACT_INVALID === "true"
        ? [
            ["invalid_final_cleanup_token", env.CCHP_INVALID_FINAL_ARTIFACT_CLEANUP_TOKEN_OUTCOME],
            ["invalid_final_cleanup", env.CCHP_INVALID_FINAL_ARTIFACT_CLEANUP_OUTCOME],
          ] as Array<[string, string | undefined]>
        : []),
    ].filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)),
    cancelled: env.CCHP_JOB_CANCELLED === "true",
  }
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function parseSupervisorTerminal(
  value: unknown,
  redact: (value: string) => string = (value) => redactRuntimeDiagnostic(value, []),
): Pick<SupervisorResult, "state" | "terminalReason" | "usage"> | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const parsed = value as Record<string, unknown>
    if (typeof parsed.state !== "string" || !TERMINAL_STATES.has(parsed.state as SupervisorState)) return undefined
    const state = parsed.state as SupervisorState
    const rawUsage = parsed.usage && typeof parsed.usage === "object" && !Array.isArray(parsed.usage)
      ? parsed.usage as Record<string, unknown>
      : {}
    const consumed = finiteNonNegative(rawUsage.consumed)
    const limit = finiteNonNegative(rawUsage.limit)
    if (consumed == null || limit == null) return undefined
    return {
      state,
      ...(typeof parsed.terminalReason === "string" ? { terminalReason: redact(parsed.terminalReason) } : {}),
      usage: {
        ...ZERO_USAGE,
        consumed,
        limit,
        fraction: limit > 0 ? consumed / limit : 0,
      },
    }
  } catch {
    return undefined
  }
}

export function readSupervisorTerminal(
  path: string,
  redact: (value: string) => string = (value) => redactRuntimeDiagnostic(value, []),
): Pick<SupervisorResult, "state" | "terminalReason" | "usage"> | undefined {
  return readSupervisorTerminalSnapshot(path, redact).terminal
}

export function readSupervisorTerminalSnapshot(
  path: string,
  redact: (value: string) => string = (value) => redactRuntimeDiagnostic(value, []),
): { terminal?: Pick<SupervisorResult, "state" | "terminalReason" | "usage">; sha256: string | null } {
  if (!existsSync(path)) return { sha256: null }
  try {
    const snapshot = openRegularFileSnapshot(path)
    try {
      return {
        terminal: parseSupervisorTerminal(JSON.parse(snapshot.bytes.toString("utf8")), redact),
        sha256: snapshot.sha256,
      }
    } catch {
      return { sha256: snapshot.sha256 }
    }
  } catch {
    return { sha256: null }
  }
}

export function resolveWorkflowTerminal(
  outcomes: WorkflowStepOutcomes,
  supervisorTerminal?: Pick<SupervisorResult, "state" | "terminalReason" | "usage">,
): ResolvedWorkflowTerminal {
  if (outcomes.needsWrite && outcomes.write !== "success") {
    if (outcomes.cancelled || outcomes.write === "cancelled") {
      return { state: "CANCELLED", terminalReason: "workflow write credential step was cancelled", usage: ZERO_USAGE, reasonCode: "workflow_cancelled" }
    }
    return {
      state: "FAILED",
      terminalReason: `write credential setup ${outcomes.write || "did not run"}`,
      usage: ZERO_USAGE,
      reasonCode: "write_token_setup_failed",
    }
  }
  const steps: Array<[StepName, string, SupervisorState, WorkflowReasonCode]> = [
    ["install", outcomes.install, "FAILED", "codex_install_failed"],
    ["prepare", outcomes.prepare, "FAILED", "environment_prepare_failed"],
    ["scan", outcomes.scan, "FAILED", "external_scan_failed"],
    ["capability", outcomes.capability, "FAILED", "capability_gate_failed"],
  ]
  for (const [step, outcome, state, reasonCode] of steps) {
    if (outcome === "success") continue
    if (outcomes.cancelled || outcome === "cancelled") {
      return { state: "CANCELLED", terminalReason: `workflow ${step} step was cancelled`, usage: ZERO_USAGE, reasonCode: "workflow_cancelled" }
    }
    const label = step === "install"
      ? "Codex setup"
      : step === "prepare"
        ? "environment preparation"
        : step === "scan"
          ? "external static analysis"
          : "Codex capability gate"
    return { state, terminalReason: `${label} ${outcome || "did not run"}`, usage: ZERO_USAGE, reasonCode }
  }

  const lifecycleReasonCodes: Record<string, WorkflowReasonCode> = {
    staging: "lifecycle_staging_failed",
    evidence: "lifecycle_evidence_failed",
    verify: "lifecycle_verify_failed",
    upload: "lifecycle_upload_failed",
    uploaded_digest: "lifecycle_uploaded_digest_failed",
    roundtrip_staging: "lifecycle_roundtrip_staging_failed",
    download: "lifecycle_download_failed",
    downloaded_digest: "lifecycle_downloaded_digest_failed",
    runtime_snapshot: "runtime_snapshot_failed",
    environment_cleanup: "environment_cleanup_failed",
    final_staging: "final_lifecycle_staging_failed",
    final_evidence: "final_lifecycle_evidence_failed",
    final_verify: "final_lifecycle_verify_failed",
    final_upload: "final_lifecycle_upload_failed",
    final_uploaded_digest: "final_lifecycle_uploaded_digest_failed",
    final_roundtrip_staging: "final_lifecycle_roundtrip_staging_failed",
    final_download: "final_lifecycle_download_failed",
    final_downloaded_digest: "final_lifecycle_downloaded_digest_failed",
    invalid_primary_cleanup_token: "invalid_artifact_cleanup_token_failed",
    invalid_final_cleanup_token: "invalid_artifact_cleanup_token_failed",
    invalid_primary_cleanup: "invalid_primary_artifact_cleanup_failed",
    invalid_final_cleanup: "invalid_final_artifact_cleanup_failed",
    progress_finalizer: "progress_finalizer_failed",
  }
  const lifecycleEntries = Object.entries(outcomes.lifecycle ?? {})
  lifecycleEntries.sort(([left], [right]) => {
    const priority = (name: string) => name.startsWith("invalid_") ? 0 : 1
    return priority(left) - priority(right)
  })
  for (const [name, outcome] of lifecycleEntries) {
    if (outcome === "success") continue
    if (outcomes.cancelled || outcome === "cancelled") {
      return { state: "CANCELLED", terminalReason: `workflow lifecycle ${name} step was cancelled`, usage: ZERO_USAGE, reasonCode: "workflow_cancelled" }
    }
    return {
      state: "FAILED",
      terminalReason: `workflow lifecycle ${name} ${outcome || "did not run"}`,
      usage: ZERO_USAGE,
      reasonCode: lifecycleReasonCodes[name] ?? "supervisor_failed",
    }
  }

  if (outcomes.cancelled || outcomes.supervisor === "cancelled") {
    return { state: "CANCELLED", terminalReason: "Codex supervisor workflow step was cancelled", usage: ZERO_USAGE, reasonCode: "workflow_cancelled" }
  }
  if (supervisorTerminal) {
    if (supervisorTerminal.state === "SUCCEEDED" && outcomes.supervisor !== "success") {
      return {
        state: "FAILED",
        terminalReason: "Codex supervisor wrapper failed after the runtime reported success",
        usage: supervisorTerminal.usage,
        reasonCode: "supervisor_wrapper_failed",
      }
    }
    const reasonCode: WorkflowReasonCode = supervisorTerminal.state === "SUCCEEDED"
      ? "supervisor_succeeded"
      : supervisorTerminal.state === "CANCELLED"
        ? "workflow_cancelled"
        : supervisorTerminal.state === "TIMED_OUT" || supervisorTerminal.state === "NO_PROGRESS_TIMEOUT"
          ? "supervisor_timeout"
          : supervisorTerminal.state === "TOKEN_BUDGET_EXCEEDED"
            ? "token_budget_exceeded"
            : "supervisor_failed"
    return { ...supervisorTerminal, reasonCode }
  }
  return {
    state: "FAILED",
    terminalReason: outcomes.supervisor === "success"
      ? "Codex supervisor completed without a valid terminal artifact"
      : `Codex supervisor ${outcomes.supervisor || "did not run"}`,
    usage: ZERO_USAGE,
    reasonCode: outcomes.supervisor === "success" ? "supervisor_terminal_missing" : "supervisor_failed",
  }
}

async function assertSnapshottedReviewSummary(
  client: GitHubClient,
  runtimeSnapshot: NonNullable<ReturnType<typeof readWorkflowRuntimeSnapshot>>,
  progress: NonNullable<ReturnType<typeof readProgressPublicationSnapshot>>,
): Promise<void> {
  const review = runtimeSnapshot.reviewSummary
  if (
    review.ledger !== "valid" || !review.repository || !review.prNumber || !review.headSha || !review.ownerLogin ||
    !review.primaryCommentId || !review.parts?.length || progress.record.commentId !== review.primaryCommentId
  ) throw new Error("successful finalized review is missing a complete summary manifest")
  const { owner, name } = splitRepo(review.repository)
  const { data: pull } = await client.rest.pulls.get({ owner, repo: name, pull_number: review.prNumber })
  if (pull.state !== "open" || pull.merged || pull.merged_at || pull.head.sha !== review.headSha) {
    throw new Error("successful finalized review target changed before workflow finalization")
  }
  const [comments, inlineComments, reviews] = await Promise.all([
    client.paginate(client.rest.issues.listComments, {
      owner,
      repo: name,
      issue_number: review.prNumber,
      per_page: 100,
    }),
    client.paginate(client.rest.pulls.listReviewComments, {
      owner,
      repo: name,
      pull_number: review.prNumber,
      per_page: 100,
    }),
    client.paginate(client.rest.pulls.listReviews, {
      owner,
      repo: name,
      pull_number: review.prNumber,
      per_page: 100,
    }),
  ])
  const owned = comments.filter((comment) => comment.user?.login === review.ownerLogin)
  const expectedMarkers = new Set(review.parts.map((part) => hidden(part.marker)))
  for (const [index, part] of review.parts.entries()) {
    const marker = hidden(part.marker)
    const matches = owned.filter((comment) => (comment.body ?? "").includes(marker))
    if (
      matches.length !== 1 || matches[0]!.id !== part.commentId ||
      createHash("sha256").update(matches[0]!.body ?? "").digest("hex") !== part.sha256
    ) {
      throw new Error(`successful finalized review summary part ${index + 1} is missing, duplicated, or stale`)
    }
  }
  const summaryMarker = hidden(MARKER.sticky("review-summary"))
  const summaries = owned.filter((comment) => (comment.body ?? "").includes(summaryMarker))
  if (summaries.length !== 1 || summaries[0]!.id !== review.primaryCommentId) {
    throw new Error("successful finalized review summary primary is missing or duplicated")
  }
  if (owned.some((comment) => (comment.body ?? "").includes(hidden(progressMarkerKey("pr_opened"))))) {
    throw new Error("successful finalized review still has an owned live progress comment")
  }
  if (owned.some((comment) => {
    const body = comment.body ?? ""
    return body.includes("<!-- cchp-review-report:") && ![...expectedMarkers].some((marker) => body.includes(marker))
  })) throw new Error("successful finalized review has stale owned summary fragments")
  for (const [index, entry] of (review.inlineComments ?? []).entries()) {
    const marker = hidden(MARKER.fingerprint(entry.fingerprint))
    const matches = inlineComments.filter((comment) =>
      comment.user?.login === review.ownerLogin && (comment.body ?? "").includes(marker),
    )
    const match = matches[0]
    if (
      matches.length !== 1 || !match || match.id !== entry.commentId || match.commit_id !== entry.commitId ||
      match.path !== entry.path || match.line !== entry.line || match.side !== entry.side ||
      (match.start_line ?? undefined) !== entry.startLine || (match.start_side ?? undefined) !== entry.startSide ||
      createHash("sha256").update(match.body ?? "").digest("hex") !== entry.bodySha256
    ) throw new Error(`successful finalized review inline finding ${index + 1} is missing, duplicated, or stale`)
  }
  const formal = review.formalReview!
  const formalMatches = reviews.filter((entry) =>
    entry.user?.login === review.ownerLogin && entry.commit_id === formal.commitId &&
    createHash("sha256").update(entry.body ?? "").digest("hex") === formal.bodySha256,
  )
  if (
    formalMatches.length !== 1 || formalMatches[0]!.id !== formal.reviewId ||
    formalMatches[0]!.state !== formal.state
  ) throw new Error("successful finalized formal review is missing, duplicated, dismissed, or stale")
}

export async function finalizeWorkflowProgress(
  env: Env = process.env,
  client?: GitHubClient,
): Promise<"published" | "skipped"> {
  const token = env.GH_TOKEN
  if (!token && !client) throw new Error("GH_TOKEN is required for workflow progress finalization")
  const github = client ?? makeOctokit(token!)
  const workdir = env.BOT_WORKDIR
  const runtimeSnapshotPath = env.CCHP_RUNTIME_SNAPSHOT_PATH
  const runtimeSnapshotSha256 = env.CCHP_RUNTIME_SNAPSHOT_SHA256
  if (!workdir && !runtimeSnapshotPath) throw new Error("BOT_WORKDIR or CCHP_RUNTIME_SNAPSHOT_PATH is required for workflow progress finalization")
  if (Boolean(runtimeSnapshotPath) !== Boolean(runtimeSnapshotSha256)) {
    throw new Error("runtime snapshot path and sha256 must be provided together")
  }
  const redact = (value: string) => redactRuntimeDiagnostic(value, token ? [token] : [])
  const marker = progressMarkerKey(env.BOT_TASK ?? "task")
  const runtimeSnapshot = runtimeSnapshotPath
    ? readWorkflowRuntimeSnapshot(runtimeSnapshotPath, runtimeSnapshotSha256!, env)
    : undefined
  const terminalSnapshot = runtimeSnapshot
    ? {
        terminal: runtimeSnapshot.terminal.record
          ? parseSupervisorTerminal(runtimeSnapshot.terminal.record, redact)
          : undefined,
        sha256: runtimeSnapshot.terminal.sha256,
      }
    : readSupervisorTerminalSnapshot(join(workdir!, "ctx", "codex", "terminal.json"), redact)
  const result = resolveWorkflowTerminal(workflowStepOutcomes(env), terminalSnapshot.terminal)
  const stagedProgressPath = env.CCHP_PROGRESS_PUBLICATION_PATH || (runtimeSnapshotPath
    ? join(dirname(runtimeSnapshotPath), "progress-publication.json")
    : undefined)
  const publicationEnv = stagedProgressPath
    ? { ...env, CCHP_PROGRESS_PUBLICATION_PATH: stagedProgressPath }
    : env
  if (
    stagedProgressPath && runtimeSnapshot?.progress.ledger === "valid" &&
    !existsSync(stagedProgressPath)
  ) {
    seedProgressPublication(stagedProgressPath, runtimeSnapshot.progress.record!, runtimeSnapshot.progress.sha256!)
  }
  const progressEvidence = (): ReturnType<typeof readProgressPublicationSnapshot> => {
    if (stagedProgressPath && existsSync(stagedProgressPath)) {
      return readProgressPublicationSnapshot(stagedProgressPath, marker)
    }
    if (runtimeSnapshot?.progress.ledger === "valid") {
      return { record: runtimeSnapshot.progress.record!, sha256: runtimeSnapshot.progress.sha256! }
    }
    return workdir
      ? readProgressPublicationSnapshot(join(workdir, "ctx", "codex", "progress-publication.json"), marker)
      : undefined
  }
  let publication: WorkflowFinalizationRecord["publication"] = "skipped"
  let didPublish = false
  let publicationError: unknown
  const bindSnapshottedSummary = requiresReviewFinalization(env) && result.state === "SUCCEEDED"
  const deferSuccessPublication = env.CCHP_DEFER_SUCCESS_PUBLICATION === "true" && result.state === "SUCCEEDED"
  let progress: ReturnType<typeof readProgressPublicationSnapshot>
  try {
    progress = progressEvidence()
  } catch (error) {
    publication = "failed"
    publicationError = error
  }
  try {
    if (publicationError) throw publicationError
    if (deferSuccessPublication) {
      publication = "skipped"
      process.stderr.write("[workflow-finalizer] deferring successful progress publication until final transport\n")
    } else if (bindSnapshottedSummary) {
      if (!runtimeSnapshot) throw new Error("successful finalized review requires a trusted runtime snapshot")
      if (runtimeSnapshot.reviewSummary.ledger === "valid") {
        if (!progress || progress.record.publication !== "published" || !progress.record.finalized) {
          throw new Error("successful finalized review is missing durable summary publication evidence")
        }
        await assertSnapshottedReviewSummary(github, runtimeSnapshot, progress)
        publication = "published"
        process.stderr.write("[workflow-finalizer] finalized review already owns the successful PR summary\n")
      } else if (runtimeSnapshot.preparedReview.ledger === "valid" && runtimeSnapshot.preparedReview.record) {
        const prepared = runtimeSnapshot.preparedReview.record
        await publishFinalizedReview({
          octokit: github,
          repository: prepared.repository,
          prNumber: prepared.prNumber,
          marker: prepared.marker,
          bundle: prepared.bundle,
          idempotencyKey: prepared.idempotencyKey,
          statePath: env.CCHP_REVIEW_PUBLICATION_PATH || join(dirname(runtimeSnapshotPath!), "review-publication.json"),
          env: publicationEnv,
          forbiddenValues: () => token ? [token] : [],
          onSummaryPublished: (published) => recordProgressPublication(publicationEnv, marker, published, true),
        })
        progress = progressEvidence()
        if (!progress || progress.record.publication !== "published" || !progress.record.finalized) {
          throw new Error("authoritative finalized review publication did not persist summary evidence")
        }
        publication = "published"
      } else {
        throw new Error("successful finalized review is missing prepared or published review evidence")
      }
    } else {
      const publish = createTerminalProgressPublisher(publicationEnv, github, redact)
      if (!publish) {
        process.stderr.write("[workflow-finalizer] no trusted progress target; nothing to finalize\n")
      } else {
        didPublish = await publish(result)
        publication = didPublish ? "published" : "skipped"
      }
    }
  } catch (error) {
    publication = "failed"
    publicationError = error
  }

  if (!bindSnapshottedSummary) {
    try {
      progress = progressEvidence()
    } catch (error) {
      publication = "failed"
      publicationError ??= error
    }
  }
  const finalizationPath = env.CCHP_WORKFLOW_FINALIZATION_PATH || (runtimeSnapshotPath
    ? join(dirname(runtimeSnapshotPath), "workflow-finalization.json")
    : join(workdir!, "ctx", "codex", "workflow-finalization.json"))
  writeWorkflowFinalization(finalizationPath, {
    schemaVersion: 1,
    terminalSha256: terminalSnapshot.sha256,
    resolvedState: result.state,
    reasonCode: result.reasonCode,
    publication,
    progressPublicationSha256: progress?.sha256 ?? null,
    ...(progress?.record.commentId ? { commentId: progress.record.commentId } : {}),
    ...(progress?.record.action ? { action: progress.record.action } : {}),
    recordedAt: new Date().toISOString(),
  })
  if (publicationError) throw publicationError
  if (env.CCHP_ENFORCE_RESOLVED_STATE === "true" && result.state !== "SUCCEEDED") {
    process.exitCode = 1
  }
  process.stderr.write(`[workflow-finalizer] ${publication} state=${result.state}\n`)
  return didPublish ? "published" : "skipped"
}

if (import.meta.main) {
  finalizeWorkflowProgress().catch((error) => {
    process.stderr.write(`[workflow-finalizer] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
