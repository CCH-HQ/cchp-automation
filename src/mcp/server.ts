#!/usr/bin/env bun
// The agent's curated GitHub tool surface — a custom Octokit-backed MCP server
// (DESIGN §6, ADR 0003). It replaces the official `github/github-mcp-server`
// (Go, 100+ tools, a second unpinned client) with ~two-dozen least-privilege ops
// wired through the ONE engine Octokit client (throttling + retry + pinned API
// version, `makeOctokit`). No `gh` / `curl` / hand GraphQL: every tool that
// touches GitHub goes through the shared client.
//
// Layering: this file is a thin MCP transport + input-validation shell. The
// publication behaviour lives in `src/publish/*` (sticky / inline / structured /
// review / check-run / meta / merge) and is reused verbatim — the fork gate
// (merge.ts), the auto-approve kill-switch (review.ts), fingerprint dedup +
// patch-anchor validation (inline.ts) and the frozen comment markers (types.ts)
// are NOT reimplemented here. Reads and low-level mutations that have no
// publisher go straight to Octokit and RETURN their data as text (they never
// write files — the review pipeline owns artifacts).
//
// Validation posture mirrors the retired `.github/cchp-bot/mcp/inline-comment-server.mjs`:
// each tool exposes a JSON-Schema `inputSchema`, arguments are validated before any
// API call, and failures come back as `{ isError: true, content:[{type:"text",
// text:"error: …"}] }` — the model gets a readable message, never a thrown crash.
//
// Trust boundary (frozen invariants, DESIGN §8): inline review publication binds
// to the CURRENT run's PR number + head SHA + trusted patch read off disk
// (BOT_PR_NUMBER / BOT_HEAD_SHA / BOT_PATCH_FILE), never to agent-supplied values,
// so a finding can only be anchored to the trusted, base-side diff. Fork PRs are
// reviewed/approved autonomously but NEVER auto-merged (merge.ts / ADR 0004).
import { join } from "node:path"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import { compactWorkflowLog, splitRepo } from "../context"
import { ArtifactStore } from "../codex/artifacts"
import { openRegularFileSnapshot } from "../codex/file-snapshot"
import { ProvenanceLedger } from "../codex/provenance"
import { finalizeReview, selectFinalizerProvenance, type FinalizedMarker } from "../review/finalize"
import { ARTIFACTS, MARKER, TASKS, type Task, type Verdict } from "../types"
import { makeOctokit, type GitHubClient, type TokenSource } from "../github/client"
import {
  CHECK_ACTIONS,
  CHECK_RUN_NAME,
  type CheckAction,
  type CheckConclusion,
  type CheckStatus,
  createCheckRun,
  updateCheckRun,
} from "../publish/checkrun"
import {
  type InlineComment,
  normalizeFingerprint,
  postReviewBatch,
  postStructuredComment,
  type StructuredInput,
  updateStructuredComment,
} from "../publish/inline"
import {
  addLgtmLabel,
  addTriageLabel,
  closePrOrIssue,
  commentFile,
  lock as lockConversation,
  postComment,
  postPrTitleNote,
  setPrTitle,
} from "../publish/meta"
import { mergePr } from "../publish/merge"
import { autoApproveDisabled, type ReviewComment, submitReview } from "../publish/review"
import { upsertSticky } from "../publish/sticky"
import { makeBrokerGitHubClient } from "./github-broker"
import {
  DISCUSSION_ADD_COMMENT,
  DISCUSSION_QUERY,
  DISCUSSION_UPDATE_COMMENT,
  MINIMIZE_COMMENT,
  RESOLVE_THREAD_MUTATION,
  REVIEW_THREADS_QUERY,
  ROADMAP_ADD_ITEM,
  ROADMAP_ARCHIVE_ITEM,
  ROADMAP_CREATE_STATUS_FIELD,
  ROADMAP_DISCOVERY_QUERY,
  ROADMAP_MOVE_ITEM,
  ROADMAP_PROJECT_DESCRIPTION,
  ROADMAP_PROJECT_README,
  ROADMAP_STATUS_OPTIONS,
  ROADMAP_UPDATE_PROJECT,
  ROADMAP_UPDATE_STATUS_FIELD,
} from "./graphql-contract"

export const SERVER_NAME = "cchp_github"
export const SERVER_VERSION = "1.0.0"

// Frozen validators reused from the source MCP server / inline.ts (kept local so
// input validation is self-contained; the publishers re-validate authoritatively).
const STICKY_KEY_RE = /^[a-z0-9][a-z0-9:._-]{0,63}$/
const VERDICTS: Verdict[] = ["COMMENT", "REQUEST_CHANGES", "APPROVE"]
// The REST reactions API's full content enum ('+1' 👍 is the "review ran clean" ack).
const REACTION_CONTENTS = ["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"] as const
const CHECK_STATUSES: CheckStatus[] = ["queued", "in_progress", "completed"]
const CHECK_CONCLUSIONS: CheckConclusion[] = ["success", "neutral", "failure", "action_required", "cancelled"]
const MINIMIZE_CLASSIFIERS = ["SPAM", "ABUSE", "OFF_TOPIC"] as const
const PR_OPENED_TOOL_NAMES = new Set([
  "write_review_artifact",
  "write_plan",
  "write_reply",
  "post_structured_comment",
  "post_inline_review",
  "submit_pr_review",
  "add_reaction",
  "get_pr_diff",
  "get_failed_logs",
  "get_pr_context",
  "list_review_threads",
  "resolve_review_thread",
  "set_pr_title",
  "post_title_note",
  "close",
  "lock",
  "add_triage_label",
  "search_issues_and_prs",
  "get_issue_context",
  "get_actor_permission",
  "delete_issue_comment",
  "delete_review_comment",
  "minimize_comment",
  "list_comment_reactions",
  "roadmap_graphql",
  "roadmap_add_item",
  "roadmap_move_item",
  "roadmap_archive_item",
])

const TOOL_NAMES_BY_TASK: Record<Task, ReadonlySet<string>> = {
  engage: new Set([
    "write_plan", "write_reply", "upsert_sticky_comment", "post_structured_comment", "update_structured_comment",
    "set_pr_title", "post_comment", "comment_file", "close", "lock", "add_triage_label", "add_label", "remove_label",
    "set_milestone", "add_reaction", "get_pr_diff", "get_pr_context", "search_issues_and_prs", "get_issue_context",
    "get_actor_permission", "delete_issue_comment", "delete_review_comment", "minimize_comment", "list_comment_reactions",
    "list_review_threads", "resolve_review_thread", "get_discussion", "add_discussion_comment", "update_discussion_comment",
    "create_pull_request", "list_milestones", "create_milestone", "close_milestone", "roadmap_graphql", "roadmap_add_item",
    "roadmap_move_item", "roadmap_archive_item", "git_fetch", "git_push", "install_web_dependencies",
  ]),
  pr_opened: PR_OPENED_TOOL_NAMES,
  lgtm_merge: new Set(["write_reply", "post_comment", "post_structured_comment", "add_lgtm_label", "merge_pr", "get_pr_context", "get_actor_permission"]),
  ci_fix: new Set([
    "write_plan", "write_reply", "upsert_sticky_comment", "post_structured_comment", "update_structured_comment", "post_comment",
    "comment_file", "get_failed_logs", "get_pr_diff", "get_pr_context", "search_issues_and_prs", "get_issue_context",
    "get_actor_permission", "create_check_run", "update_check_run", "rerun_workflow_run", "cancel_workflow_run", "create_pull_request",
    "git_fetch", "git_push", "install_web_dependencies",
  ]),
  release_notes: new Set([
    "write_reply", "search_issues_and_prs", "get_issue_context", "set_issue_title", "list_milestones", "create_milestone",
    "close_milestone", "set_milestone", "list_releases", "get_release", "compare_commits", "update_release_notes",
    "roadmap_graphql", "roadmap_add_item", "roadmap_move_item", "roadmap_archive_item",
  ]),
  roadmap_item: new Set([
    "write_reply", "search_issues_and_prs", "get_issue_context", "get_pr_context", "set_issue_title", "list_milestones",
    "create_milestone", "close_milestone", "set_milestone", "roadmap_graphql", "roadmap_add_item", "roadmap_move_item",
    "roadmap_archive_item",
  ]),
  roadmap_sync: new Set([
    "write_reply", "search_issues_and_prs", "get_issue_context", "get_pr_context", "set_issue_title", "list_milestones",
    "create_milestone", "close_milestone", "set_milestone", "roadmap_graphql", "roadmap_add_item", "roadmap_move_item",
    "roadmap_archive_item", "roadmap_bootstrap_status_schema",
  ]),
  reaction_execute: new Set([
    "write_plan", "write_reply", "update_structured_comment", "search_issues_and_prs", "get_issue_context", "get_actor_permission",
    "create_pull_request", "git_fetch", "git_push", "install_web_dependencies",
  ]),
  manual: new Set(["git_fetch", "git_push", "install_web_dependencies"]),
  dispatch: new Set(["git_fetch", "git_push", "install_web_dependencies"]),
}

// ── module deps + injection seams (all default to the real world; tests override) ──

/** What the server needs to run. `env` is injectable so run bindings and the
 * kill-switch are unit-testable without real process state. */
export interface ServerDeps {
  octokit: GitHubClient
  /** `owner/name` of the repository the run targets (BOT_REPO). */
  repo: string
  /** Defaults to `process.env`; the source of BOT_* run bindings + the kill-switch. */
  env?: Record<string, string | undefined>
  runtime?: {
    gitFetch(args: Record<string, never>): Promise<unknown>
    gitPush(args: Record<string, never>): Promise<unknown>
    installWebDependencies(args: { mode: "frozen" | "update" }): Promise<unknown>
  }
}

/** One registered tool: its advertised schema plus a handler that returns the text
 *  payload (or throws an `Error` whose message becomes the `error: …` tool result). */
export interface ToolEntry {
  name: string
  description: string
  inputSchema: Tool["inputSchema"]
  handler: (args: Args) => Promise<string>
}

type Args = Record<string, unknown>

// ── argument validators (mirror inline-comment-server.mjs's inline checks) ───

function reqStr(a: Args, key: string): string {
  const v = a[key]
  if (typeof v !== "string" || v.length === 0) throw new Error(`${key} must be a non-empty string`)
  return v
}

function reqOneLine(a: Args, key: string, max: number): string {
  const value = reqStr(a, key)
  if (value.length > max || value.includes("\n") || value.includes("\r")) {
    throw new Error(`${key} must be one line with length 1..${max}`)
  }
  return value
}

function optStr(a: Args, key: string): string | undefined {
  const v = a[key]
  if (v == null) return undefined
  if (typeof v !== "string") throw new Error(`${key} must be a string`)
  return v
}

function reqInt(a: Args, key: string): number {
  const v = a[key]
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`${key} must be a positive integer`)
  return v
}

function reqEnv(env: Record<string, string | undefined>, key: string): string {
  const v = env[key]
  if (!v) throw new Error(`${key} is not set in the run environment`)
  return v
}

function reqEnvInt(env: Record<string, string | undefined>, key: string): number {
  const n = Number(reqEnv(env, key))
  if (!Number.isInteger(n) || n < 1) throw new Error(`${key} must be a positive integer`)
  return n
}

function assertOnlyArgs(args: Args, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed)
  const unexpected = Object.keys(args).filter((key) => !allowedSet.has(key))
  if (unexpected.length) throw new Error(`unexpected arguments: ${unexpected.join(", ")}`)
}

function taskFromEnv(env: Record<string, string | undefined>): Task {
  const value = env.BOT_TASK
  if (!value || !(TASKS as readonly string[]).includes(value)) {
    throw new Error(`unsupported BOT_TASK: ${value || "<empty>"}`)
  }
  return value as Task
}

/** `pr_opened` tools are bound to the current trusted PR. Target fields are not
 * advertised, and a raw MCP caller that still supplies one must match exactly. */
function trustedPrNumber(env: Record<string, string | undefined>, a: Args, key: string): number {
  if (env.BOT_TASK !== "pr_opened") return reqInt(a, key)
  const trusted = reqEnvInt(env, "BOT_PR_NUMBER")
  if (a[key] != null && reqInt(a, key) !== trusted) {
    throw new Error(`${key} must match trusted BOT_PR_NUMBER ${trusted}`)
  }
  return trusted
}

function trustedDiscussionNumber(env: Record<string, string | undefined>, a: Args, key: string): number {
  const configured = env.BOT_DISCUSSION_NUMBER
  if (!configured) return reqInt(a, key)
  const trusted = reqEnvInt(env, "BOT_DISCUSSION_NUMBER")
  if (a[key] != null && reqInt(a, key) !== trusted) {
    throw new Error(`${key} must match trusted BOT_DISCUSSION_NUMBER ${trusted}`)
  }
  return trusted
}

const REVIEW_ARTIFACT_NAMES = new Set<string>([
  ARTIFACTS.manifest,
  ARTIFACTS.coverage,
  ARTIFACTS.candidateLedger,
  ARTIFACTS.verificationLedger,
  ARTIFACTS.finalReport,
])

/** Review publication is fail-closed for PR-opened runs. The gate is evaluated
 * immediately before every GitHub review/comment mutation, so a later artifact
 * edit cannot publish an untrusted bundle. Other task types retain the existing
 * conversation-comment behavior. */
function requireReviewFinalized(env: Record<string, string | undefined>): ReviewPublicationBundle | undefined {
  if (env.BOT_TASK !== "pr_opened") return undefined
  const workdir = env.BOT_WORKDIR
  if (!workdir) throw new Error("BOT_WORKDIR is required for pr_opened review publication")
  const artifactDir = env.BOT_REVIEW_ARTIFACT_DIR ?? join(workdir, "ctx", "review")
  const trustedManifest = env.BOT_TRUSTED_REVIEW_MANIFEST ?? join(workdir, "ctx", "review-manifest.json")
  const marker = env.BOT_REVIEW_FINALIZED_MARKER ?? join(workdir, "ctx", ARTIFACTS.finalized)
  const runId = reqEnv(env, "BOT_RUN_ID")
  const provenance = new ProvenanceLedger(join(workdir, "ctx", "codex", "provenance.jsonl"), runId)
  if (!provenance.head) throw new Error("runtime provenance ledger is empty")
  const provenanceSha256 = selectFinalizerProvenance(marker, provenance, provenance.head)
  const finalized = finalizeReview(artifactDir, trustedManifest, marker, {
    repository: reqEnv(env, "BOT_REPO"),
    prNumber: reqEnvInt(env, "BOT_PR_NUMBER"),
    runId,
    provenanceSha256,
    admissionLedgerPath: join(workdir, "ctx", "codex", "review-admission.jsonl"),
  })
  return reviewPublicationBundle(env, finalized)
}

export interface ReviewPublicationBundle {
  report: string
  patch: string
  headSha: string
  formalVerdict: Verdict
  publishableInline: Readonly<Record<string, Readonly<InlineComment>>>
  findingCount: number
}

function canonicalInlineBody(candidate: Record<string, unknown>, verification: Record<string, unknown>): string {
  const trace = Array.isArray(verification.execution_trace) ? verification.execution_trace : []
  return [
    `**${String(verification.severity)} confirmed finding ${JSON.stringify(String(candidate.candidate_id))}**`,
    "",
    `- Verdict: ${JSON.stringify(String(verification.verdict))}`,
    `- Root cause: ${JSON.stringify(String(candidate.root_cause_key))}`,
    `- Trigger: ${JSON.stringify(verification.trigger)}`,
    `- Observable failure: ${JSON.stringify(verification.observable_failure)}`,
    `- Confidence: ${JSON.stringify(verification.confidence)}`,
    "",
    "**Execution trace**",
    ...trace.map((step) => `1. ${JSON.stringify(step)}`),
  ].join("\n")
}

export function reviewPublicationBundle(
  env: Record<string, string | undefined>,
  marker: FinalizedMarker,
): ReviewPublicationBundle {
  const workdir = reqEnv(env, "BOT_WORKDIR")
  const artifactDir = env.BOT_REVIEW_ARTIFACT_DIR ?? join(workdir, "ctx", "review")
  const snapshot = (name: string, expectedSha256: string, label: string) => {
    const value = openRegularFileSnapshot(join(artifactDir, name))
    if (value.sha256 !== expectedSha256) throw new Error(`${label} does not match finalizer attestation`)
    return value.bytes
  }
  const candidates = JSON.parse(snapshot(
    ARTIFACTS.candidateLedger,
    marker.artifacts.candidates,
    "candidate ledger",
  ).toString("utf8")) as Record<string, unknown>
  const verification = JSON.parse(snapshot(
    ARTIFACTS.verificationLedger,
    marker.artifacts.verification,
    "verification ledger",
  ).toString("utf8")) as Record<string, unknown>
  const report = snapshot(ARTIFACTS.finalReport, marker.artifacts.report, "report").toString("utf8")
  const trustedManifestPath = env.BOT_TRUSTED_REVIEW_MANIFEST ?? join(workdir, "ctx", "review-manifest.json")
  const trustedManifestSnapshot = openRegularFileSnapshot(trustedManifestPath)
  if (trustedManifestSnapshot.sha256 !== marker.trusted_manifest_sha256) {
    throw new Error("trusted manifest does not match finalizer attestation")
  }
  const trustedManifest = JSON.parse(trustedManifestSnapshot.bytes.toString("utf8")) as Record<string, unknown>
  const patchRecord = trustedManifest.patch && typeof trustedManifest.patch === "object" && !Array.isArray(trustedManifest.patch)
    ? trustedManifest.patch as Record<string, unknown>
    : {}
  if (typeof patchRecord.path !== "string" || typeof patchRecord.sha256 !== "string") {
    throw new Error("trusted manifest patch binding is incomplete")
  }
  if (patchRecord.sha256 !== marker.patch_sha256) throw new Error("patch hash does not match finalizer attestation")
  if (env.BOT_PATCH_FILE && env.BOT_PATCH_FILE !== patchRecord.path) {
    throw new Error("BOT_PATCH_FILE does not match the finalized trusted manifest")
  }
  const patchSnapshot = openRegularFileSnapshot(patchRecord.path)
  if (patchSnapshot.sha256 !== marker.patch_sha256) throw new Error("patch does not match finalizer attestation")
  const patch = patchSnapshot.bytes.toString("utf8")
  if (!patch.trim()) throw new Error("finalized trusted patch is empty")
  if (env.BOT_HEAD_SHA && env.BOT_HEAD_SHA !== marker.head_sha) {
    throw new Error("BOT_HEAD_SHA does not match the finalized marker head SHA")
  }
  const candidateById = new Map<string, Record<string, unknown>>()
  for (const value of Array.isArray(candidates.candidates) ? candidates.candidates : []) {
    const item = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
    if (typeof item.candidate_id === "string" && typeof item.root_cause_key === "string") {
      candidateById.set(item.candidate_id, item)
    }
  }
  const publishableInline: Record<string, Readonly<InlineComment>> = {}
  let findingCount = 0
  let blocking = false
  for (const value of Array.isArray(verification.verifications) ? verification.verifications : []) {
    const item = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
    const verdict = String(item.verdict ?? "")
    if (!["CONFIRMED_REPRODUCED", "CONFIRMED_STATIC", "HIGH_RISK_UNRESOLVED"].includes(verdict)) continue
    findingCount++
    if (item.severity === "P0" || item.severity === "P1") blocking = true
    if (verdict === "HIGH_RISK_UNRESOLVED") continue
    const candidate = candidateById.get(String(item.candidate_id ?? ""))
    const location = item.location && typeof item.location === "object" && !Array.isArray(item.location)
      ? item.location as Record<string, unknown>
      : {}
    if (!candidate || typeof candidate.root_cause_key !== "string") {
      throw new Error(`confirmed finding ${String(item.candidate_id ?? "<missing>")} has no finalized candidate identity`)
    }
    if (typeof location.file !== "string" || !location.file || !Number.isSafeInteger(location.line) || Number(location.line) < 1) {
      throw new Error(`confirmed finding ${String(item.candidate_id)} has no valid finalized location`)
    }
    const side = location.side == null ? "RIGHT" : String(location.side)
    if (side !== "LEFT" && side !== "RIGHT") throw new Error(`confirmed finding ${String(item.candidate_id)} has an invalid finalized side`)
    if (location.start_side != null && location.start_line == null) {
      throw new Error(`confirmed finding ${String(item.candidate_id)} has start_side without start_line`)
    }
    let startLine: number | undefined
    let startSide: "LEFT" | "RIGHT" | undefined
    if (location.start_line != null) {
      if (!Number.isSafeInteger(location.start_line) || Number(location.start_line) < 1 || Number(location.start_line) > Number(location.line)) {
        throw new Error(`confirmed finding ${String(item.candidate_id)} has an invalid finalized start_line`)
      }
      startLine = Number(location.start_line)
      startSide = location.start_side == null ? side : String(location.start_side) as "LEFT" | "RIGHT"
      if ((startSide !== "LEFT" && startSide !== "RIGHT") || startSide !== side) {
        throw new Error(`confirmed finding ${String(item.candidate_id)} has an invalid finalized start_side`)
      }
    }
    const key = normalizeFingerprint(candidate.root_cause_key)
    if (publishableInline[key]) throw new Error(`confirmed findings reuse finalized fingerprint ${key}`)
    publishableInline[key] = Object.freeze({
      path: location.file,
      line: Number(location.line),
      side,
      ...(startLine == null ? {} : { start_line: startLine, start_side: startSide }),
      body: canonicalInlineBody(candidate, item),
      fingerprint: key,
    })
  }
  return Object.freeze({
    report,
    patch,
    headSha: marker.head_sha,
    formalVerdict: blocking ? "REQUEST_CHANGES" : findingCount === 0 ? "APPROVE" : "COMMENT",
    publishableInline: Object.freeze(publishableInline),
    findingCount,
  })
}

export function validateInlinePublication(bundle: ReviewPublicationBundle, comments: InlineComment[]): void {
  const fingerprints = new Set<string>()
  for (const comment of comments) {
    const fingerprint = normalizeFingerprint(comment.fingerprint)
    if (fingerprints.has(fingerprint)) throw new Error("inline finding fingerprint is duplicated in the publication request")
    fingerprints.add(fingerprint)
    const expected = bundle.publishableInline[fingerprint]
    if (!expected) throw new Error("inline finding is not in the finalized confirmed-finding subset")
    const side = comment.side ?? "RIGHT"
    const startSide = comment.start_line == null ? undefined : comment.start_side ?? side
    if (comment.path !== expected.path || comment.line !== expected.line || comment.body !== expected.body ||
      side !== expected.side || comment.start_line !== expected.start_line || startSide !== expected.start_side) {
      throw new Error("inline finding payload does not match the finalized verification ledger")
    }
  }
}

export function materializeInlinePublication(
  bundle: ReviewPublicationBundle,
  fingerprints: readonly string[],
): InlineComment[] {
  if (fingerprints.length === 0) throw new Error("fingerprints must be a non-empty array")
  if (fingerprints.length > 50) throw new Error("at most 50 fingerprints may be published in one review")
  const seen = new Set<string>()
  return fingerprints.map((value) => {
    const fingerprint = normalizeFingerprint(value)
    if (seen.has(fingerprint)) throw new Error("inline finding fingerprint is duplicated in the publication request")
    seen.add(fingerprint)
    const canonical = bundle.publishableInline[fingerprint]
    if (!canonical) throw new Error("inline finding is not in the finalized confirmed-finding subset")
    return canonical as InlineComment
  })
}

/** Coerce Octokit log payloads (string / ArrayBuffer / typed array) to text —
 *  verbatim port of context.ts's `coerceText`. */
function coerceText(data: unknown): string {
  if (data == null) return ""
  if (typeof data === "string") return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8")
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8")
  return String(data)
}

// ── JSON-Schema builders (keep the tool table readable) ──────────────────────

const intProp = (description: string): object => ({ type: "integer", description })
const strProp = (description: string): object => ({ type: "string", description })
const boolProp = (description: string): object => ({ type: "boolean", description })
const enumProp = (values: readonly string[], description: string): object => ({ type: "string", enum: values, description })

function schema(properties: Record<string, object>, required: string[]): Tool["inputSchema"] {
  return { type: "object", properties, required }
}

function prTargetSchema(
  prOpened: boolean,
  key: string,
  description: string,
  properties: Record<string, object>,
  required: string[],
): Tool["inputSchema"] {
  return schema(
    { ...(prOpened ? {} : { [key]: intProp(description) }), ...properties },
    prOpened ? required : [key, ...required],
  )
}

// Structured-comment content fields shared by post_/update_structured_comment
// (the source server's STRUCTURED_FIELDS, minus the transport-only `confirmed`).
const STRUCTURED_PROPS: Record<string, object> = {
  title: strProp("Optional heading"),
  summary: strProp("One-paragraph TL;DR rendered first (required)"),
  tone: {
    type: "string",
    enum: ["note", "tip", "important", "warning", "caution"],
    description: "TL;DR alert tone (GitHub Alert kind); default note",
  },
  metadata: {
    type: "array",
    description: "Key metadata rendered as a compact inline chip row",
    items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } }, required: ["label", "value"] },
  },
  sections: {
    type: "array",
    description: "Content sections; long or collapsed:true sections render as <details>",
    items: {
      type: "object",
      properties: { title: { type: "string" }, body: { type: "string" }, collapsed: { type: "boolean" } },
      required: ["title", "body"],
    },
  },
  actions: {
    type: "array",
    description: "Interactive checklist; a member checking a box re-triggers the bot with that action id (≤10)",
    items: {
      type: "object",
      properties: {
        id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" },
        label: { type: "string" },
        checked: { type: "boolean" },
      },
      required: ["id", "label"],
    },
  },
  footnotes: { type: "array", description: "Explanatory small print rendered at the bottom", items: { type: "string" } },
}

// Structured extractors that hand raw nested arrays to the publishers, which
// validate them authoritatively (renderStructured throws on bad shapes).
function structuredInput(a: Args): StructuredInput {
  return {
    title: optStr(a, "title"),
    summary: reqStr(a, "summary"),
    tone: optStr(a, "tone"),
    metadata: a.metadata as StructuredInput["metadata"],
    sections: a.sections as StructuredInput["sections"],
    actions: a.actions as StructuredInput["actions"],
    footnotes: a.footnotes as StructuredInput["footnotes"],
  }
}

// ── the tool table ───────────────────────────────────────────────────────────

/** Build the full tool registry bound to `deps`. Pure (no I/O) so tests can
 *  inspect the advertised schemas and invoke handlers with a fake Octokit. */
export function buildTools(deps: ServerDeps): ToolEntry[] {
  const { octokit, repo } = deps
  const env = deps.env ?? process.env
  const task = taskFromEnv(env)
  const runtime = deps.runtime
  const prOpened = task === "pr_opened"
  const ns = () => splitRepo(repo)
  const artifactStore = env.BOT_WORKDIR ? new ArtifactStore(env.BOT_WORKDIR) : undefined
  let currentCheckRunId: number | undefined
  let prTitleUpdated = false
  let prTitleNotePosted = false
  let finalizedBundle: ReviewPublicationBundle | undefined
  let finalizedBundleLoaded = false
  const finalizedReview = (): ReviewPublicationBundle | undefined => {
    if (!prOpened) return undefined
    if (!finalizedBundleLoaded) {
      finalizedBundle = requireReviewFinalized(env)
      finalizedBundleLoaded = true
    }
    return finalizedBundle
  }

  const tools: ToolEntry[] = [
    {
      name: "git_fetch",
      description: "Fetch origin through the trusted host-side Git broker. Use this instead of shell git fetch.",
      inputSchema: schema({}, []),
      handler: async (a) => {
        assertOnlyArgs(a, [])
        if (!runtime) throw new Error("trusted runtime Git broker is unavailable")
        return JSON.stringify(await runtime.gitFetch({}))
      },
    },
    {
      name: "git_push",
      description: "Push the current local HEAD to origin through the trusted host-side Git broker. No force push or arbitrary refspec is allowed.",
      inputSchema: schema({}, []),
      handler: async (a) => {
        assertOnlyArgs(a, [])
        if (!runtime) throw new Error("trusted runtime Git broker is unavailable")
        return JSON.stringify(await runtime.gitPush({}))
      },
    },
    {
      name: "install_web_dependencies",
      description: "Install web dependencies in the trusted host process with the private registry credential isolated from Codex.",
      inputSchema: schema({ mode: { type: "string", enum: ["frozen", "update"] } }, ["mode"]),
      handler: async (a) => {
        assertOnlyArgs(a, ["mode"])
        if (!runtime) throw new Error("trusted runtime dependency broker is unavailable")
        const mode = reqStr(a, "mode")
        if (mode !== "frozen" && mode !== "update") throw new Error("mode must be frozen or update")
        return JSON.stringify(await runtime.installWebDependencies({ mode }))
      },
    },
    // ── Codex supervisor artifacts (fixed paths; no generic file write) ─────
    {
      name: "write_review_artifact",
      description:
        "Write one allow-listed review artifact under BOT_WORKDIR/ctx/review. The path is fixed by the supervisor and cannot escape the trusted artifact directory.",
      inputSchema: schema(
        {
          name: { type: "string", enum: [...REVIEW_ARTIFACT_NAMES], description: "Artifact filename" },
          content: strProp("Complete artifact contents"),
        },
        ["name", "content"],
      ),
      handler: async (a) => {
        if (!artifactStore || !env.BOT_WORKDIR) throw new Error("BOT_WORKDIR is required")
        if (env.BOT_TASK !== "pr_opened") throw new Error("review artifacts are only available for pr_opened")
        const name = reqStr(a, "name")
        if (!REVIEW_ARTIFACT_NAMES.has(name)) throw new Error(`artifact name is not allow-listed: ${name}`)
        return JSON.stringify({ path: artifactStore.writeReview(name, reqStr(a, "content")) })
      },
    },
    {
      name: "write_plan",
      description: "Write the planner artifact to the one fixed path BOT_WORKDIR/ctx/plan.md.",
      inputSchema: schema({ content: strProp("Complete plan markdown") }, ["content"]),
      handler: async (a) => {
        if (!artifactStore || !env.BOT_WORKDIR) throw new Error("BOT_WORKDIR is required")
        return JSON.stringify({ path: artifactStore.writePlan(reqStr(a, "content")) })
      },
    },
    {
      name: "write_reply",
      description: "Write the final reply artifact to the one fixed path BOT_WORKDIR/ctx/reply.md.",
      inputSchema: schema({ content: strProp("Complete reply markdown") }, ["content"]),
      handler: async (a) => {
        if (!artifactStore || !env.BOT_WORKDIR) throw new Error("BOT_WORKDIR is required")
        return JSON.stringify({ path: artifactStore.writeReply(reqStr(a, "content")) })
      },
    },
    // ── Publish (delegate to src/publish/) ──────────────────────────────────
    {
      name: "upsert_sticky_comment",
      description:
        "Upsert one bot-authored Sticky Comment (the human overview / progress mirror) on a PR or issue: find the hidden cchp-bot:<sticky_key> marker and edit it in place, else create it.",
      inputSchema: schema(
        {
          issue_number: intProp("PR or issue number to comment on"),
          sticky_key: { type: "string", pattern: STICKY_KEY_RE.source, description: "Upsert key (marker = cchp-bot:<sticky_key>)" },
          body: strProp("Rendered comment markdown (the marker is appended for you)"),
        },
        ["issue_number", "sticky_key", "body"],
      ),
      handler: async (a) => {
        const key = reqStr(a, "sticky_key")
        if (!STICKY_KEY_RE.test(key)) throw new Error("invalid sticky_key")
        const res = await upsertSticky(octokit, repo, reqInt(a, "issue_number"), MARKER.sticky(key), reqStr(a, "body"))
        return JSON.stringify(res)
      },
    },
    {
      name: "post_structured_comment",
      description:
        "Post (or sticky-upsert with sticky_key) a structured top-level comment on a PR/issue: TL;DR summary, metadata table, collapsible sections, action checklist, footnotes.",
      inputSchema: prTargetSchema(
        prOpened,
        "issue_number",
        "PR or issue number to comment on",
        {
          ...(prOpened
            ? {}
            : {
                sticky_key: {
                  type: "string",
                  pattern: STICKY_KEY_RE.source,
                  description: "Optional: upsert an existing cchp-bot:<sticky_key> comment",
                },
              }),
          ...STRUCTURED_PROPS,
        },
        ["summary"],
      ),
      handler: async (a) => {
        const issueNumber = trustedPrNumber(env, a, "issue_number")
        if (prOpened && a.sticky_key != null) throw new Error("sticky_key is supervisor-owned for pr_opened")
        const finalized = finalizedReview()
        const res = await postStructuredComment(octokit, repo, issueNumber, {
          ...(finalized
            ? { title: "Code Review Result", summary: finalized.report }
            : structuredInput(a)),
          sticky_key: prOpened ? "review-summary" : optStr(a, "sticky_key"),
        })
        return JSON.stringify(res)
      },
    },
    {
      name: "update_structured_comment",
      description: "Re-render and replace an existing bot comment by id (e.g. acknowledge an action selection, mark items done).",
      inputSchema: schema({ comment_id: intProp("Existing comment id to overwrite"), ...STRUCTURED_PROPS }, ["comment_id", "summary"]),
      handler: async (a) => {
        finalizedReview()
        const res = await updateStructuredComment(octokit, repo, reqInt(a, "comment_id"), structuredInput(a))
        return JSON.stringify(res)
      },
    },
    {
      name: "post_inline_review",
      description:
        "Post confirmed inline Findings as ONE Pull Request Review (event=COMMENT). Each finding is line/side-anchored to the trusted current PR patch and deduped by fingerprint (already-posted fingerprints are skipped). PR number, head SHA and the trusted patch are bound from the run environment — not from arguments.",
      inputSchema: schema(
        {
          fingerprints: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            description: "Stable root-cause keys or SHA-256 fingerprints for finalized confirmed findings; the server materializes every GitHub payload field",
            items: { type: "string", minLength: 1, maxLength: 512 },
          },
        },
        ["fingerprints"],
      ),
      handler: async (a) => {
        assertOnlyArgs(a, ["fingerprints"])
        const finalized = finalizedReview()
        if (!Array.isArray(a.fingerprints) || !a.fingerprints.every((value) => typeof value === "string" && value.length > 0)) {
          throw new Error("fingerprints must be a non-empty array of strings")
        }
        const canonicalComments = materializeInlinePublication(finalized!, a.fingerprints as string[])
        const res = await postReviewBatch(octokit, repo, {
          prNumber: reqEnvInt(env, "BOT_PR_NUMBER"),
          headSha: finalized!.headSha,
          patch: finalized!.patch,
          comments: canonicalComments,
          summary: finalized!.report,
        })
        return JSON.stringify(res)
      },
    },
    {
      name: "submit_pr_review",
      description:
        "Submit the formal Pull Request Review verdict (COMMENT / REQUEST_CHANGES / APPROVE). The agent chooses autonomously incl. on fork PRs; the org-var kill-switch (CCHP_DISABLE_AUTO_APPROVE) downgrades an APPROVE to a COMMENT.",
      inputSchema: prTargetSchema(
        prOpened,
        "pr_number",
        "Pull request number",
        {
          event: enumProp(VERDICTS, "The verdict"),
          body: strProp("Review body"),
          comments: {
            type: "array",
            description: "Optional inline comments to attach to the review",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                line: { type: "integer" },
                side: { type: "string", enum: ["LEFT", "RIGHT"] },
                start_line: { type: "integer" },
                start_side: { type: "string", enum: ["LEFT", "RIGHT"] },
                body: { type: "string" },
              },
              required: ["path", "line", "body"],
            },
          },
        },
        ["event", "body"],
      ),
      handler: async (a) => {
        const prNumber = trustedPrNumber(env, a, "pr_number")
        const finalized = finalizedReview()
        const event = reqStr(a, "event")
        if (!VERDICTS.includes(event as Verdict)) throw new Error(`event must be one of ${VERDICTS.join(", ")}`)
        if (a.comments != null && !Array.isArray(a.comments)) throw new Error("comments must be an array")
        if (finalized && event !== finalized.formalVerdict) {
          throw new Error(`formal review verdict must match finalized evidence: ${finalized.formalVerdict}`)
        }
        if (finalized && Array.isArray(a.comments) && a.comments.length > 0) {
          throw new Error("pr_opened inline findings must be published through post_inline_review")
        }
        const res = await submitReview(octokit, repo, prNumber, {
          event: event as Verdict,
          body: finalized?.report ?? reqStr(a, "body"),
          headSha: finalized?.headSha ?? reqStr(env, "BOT_HEAD_SHA"),
          ...(a.comments ? { comments: a.comments as ReviewComment[] } : {}),
          autoApproveDisabled: autoApproveDisabled(env),
        })
        return JSON.stringify(res)
      },
    },
    {
      name: "create_check_run",
      description: "Open the run-bound queued CI-fix Check Run. Name, head SHA and external run id are derived from trusted BOT_* metadata.",
      inputSchema: schema({}, []),
      handler: async () => {
        if (currentCheckRunId) throw new Error("create_check_run already succeeded for this run")
        const id = await createCheckRun(octokit, repo, {
          name: CHECK_RUN_NAME,
          headSha: reqEnv(env, "BOT_HEAD_SHA"),
          externalId: reqEnv(env, "BOT_RUN_ID"),
        })
        currentCheckRunId = id
        return JSON.stringify({ check_run_id: id })
      },
    },
    {
      name: "update_check_run",
      description:
        "Advance/complete a Check Run: status (queued/in_progress/completed), an optional conclusion, an output title+summary, and up to 3 review-run action buttons (action_keys: applyFixes/deepReReview/dismiss).",
      inputSchema: schema(
        {
          status: enumProp(CHECK_STATUSES, "Run status"),
          conclusion: enumProp(CHECK_CONCLUSIONS, "Terminal conclusion (when status=completed)"),
          title: strProp("Output title"),
          summary: strProp("Output summary"),
          action_keys: {
            type: "array",
            description: "Curated action buttons to expose (max 3)",
            items: { type: "string", enum: Object.keys(CHECK_ACTIONS) },
          },
        },
        ["status", "title", "summary"],
      ),
      handler: async (a) => {
        assertOnlyArgs(a, ["status", "conclusion", "title", "summary", "action_keys"])
        if (!currentCheckRunId) throw new Error("create_check_run must succeed before update_check_run")
        const status = reqStr(a, "status")
        if (!CHECK_STATUSES.includes(status as CheckStatus)) throw new Error(`status must be one of ${CHECK_STATUSES.join(", ")}`)
        const conclusion = optStr(a, "conclusion")
        if (conclusion && !CHECK_CONCLUSIONS.includes(conclusion as CheckConclusion)) {
          throw new Error(`conclusion must be one of ${CHECK_CONCLUSIONS.join(", ")}`)
        }
        let actions: CheckAction[] | undefined
        if (a.action_keys != null) {
          if (!Array.isArray(a.action_keys)) throw new Error("action_keys must be an array")
          actions = a.action_keys.map((k) => {
            const act = CHECK_ACTIONS[String(k)]
            if (!act) throw new Error(`unknown action key: ${k} (expected one of ${Object.keys(CHECK_ACTIONS).join(", ")})`)
            return act
          })
        }
        await updateCheckRun(octokit, repo, currentCheckRunId, {
          status: status as CheckStatus,
          ...(conclusion ? { conclusion: conclusion as CheckConclusion } : {}),
          title: reqStr(a, "title"),
          summary: reqStr(a, "summary"),
          ...(actions ? { actions } : {}),
        })
        return "check run updated"
      },
    },

    // ── Meta (delegate to src/publish/meta.ts + merge.ts) ───────────────────
    {
      name: "set_pr_title",
      description: "Set the PR title (≤256 chars, single line).",
      inputSchema: prTargetSchema(prOpened, "pr_number", "Pull request number", { title: strProp("New title") }, ["title"]),
      handler: async (a) => {
        if (prOpened && prTitleUpdated) throw new Error("the trusted PR title was already updated in this run")
        await setPrTitle(octokit, repo, trustedPrNumber(env, a, "pr_number"), reqStr(a, "title"))
        if (prOpened) prTitleUpdated = true
        return "title updated"
      },
    },
    {
      name: "post_title_note",
      description: "Post the fixed one-time title-normalization note on the trusted current PR.",
      inputSchema: schema({}, []),
      handler: async (a) => {
        assertOnlyArgs(a, [])
        if (!prOpened) throw new Error("post_title_note is available only for pr_opened")
        if (!prTitleUpdated) throw new Error("set_pr_title must succeed before post_title_note")
        if (prTitleNotePosted) throw new Error("the title-normalization note was already posted in this run")
        const result = await postPrTitleNote(octokit, repo, reqEnvInt(env, "BOT_PR_NUMBER"))
        prTitleNotePosted = true
        return JSON.stringify(result)
      },
    },
    {
      name: "post_comment",
      description: "Post a short single-line top-level comment (≤4096 chars) on a PR or issue.",
      inputSchema: prTargetSchema(
        prOpened,
        "issue_number",
        "PR or issue number",
        { comment: strProp("One-line comment body") },
        ["comment"],
      ),
      handler: async (a) => JSON.stringify(
        await postComment(octokit, repo, trustedPrNumber(env, a, "issue_number"), reqStr(a, "comment")),
      ),
    },
    {
      name: "comment_file",
      description: "Post a multi-line top-level comment (1..65536 bytes) on a PR or issue.",
      inputSchema: prTargetSchema(
        prOpened,
        "issue_number",
        "PR or issue number",
        { body: strProp("Multi-line comment body") },
        ["body"],
      ),
      handler: async (a) => JSON.stringify(
        await commentFile(octokit, repo, trustedPrNumber(env, a, "issue_number"), reqStr(a, "body")),
      ),
    },
    {
      name: "close",
      description: "Post a closing comment (≤512 chars, single line) then close the PR or issue.",
      inputSchema: prTargetSchema(prOpened, "number", "PR or issue number", { reason: strProp("Closing comment") }, ["reason"]),
      handler: async (a) => {
        await closePrOrIssue(
          octokit,
          repo,
          trustedPrNumber(env, a, "number"),
          reqStr(a, "reason"),
          prOpened ? { brokerPurpose: "pr_opened_triage_close" } : {},
        )
        return "closed"
      },
    },
    {
      name: "lock",
      description: "Lock the conversation with a reason (spam / off_topic / resolved / too_heated).",
      inputSchema: prTargetSchema(
        prOpened,
        "number",
        "PR or issue number",
        { reason: enumProp(["spam", "off_topic", "resolved", "too_heated"], "Lock reason") },
        ["reason"],
      ),
      handler: async (a) => {
        await lockConversation(octokit, repo, trustedPrNumber(env, a, "number"), reqStr(a, "reason"))
        return "locked"
      },
    },
    {
      name: "add_triage_label",
      description: "Ensure + add a triage label (spam / invalid, fixed colors) to a PR.",
      inputSchema: prTargetSchema(
        prOpened,
        "pr_number",
        "Pull request number",
        { label: enumProp(["spam", "invalid"], "Triage label") },
        ["label"],
      ),
      handler: async (a) => {
        await addTriageLabel(octokit, repo, trustedPrNumber(env, a, "pr_number"), reqStr(a, "label"))
        return "triage label added"
      },
    },
    {
      name: "add_lgtm_label",
      description: "Ensure + add the LGTM label (green) to a PR. This is the label add only — it does NOT merge.",
      inputSchema: schema({ pr_number: intProp("Pull request number") }, ["pr_number"]),
      handler: async (a) => {
        await addLgtmLabel(octokit, repo, reqInt(a, "pr_number"))
        return "LGTM label added"
      },
    },
    {
      name: "merge_pr",
      description:
        "Merge a same-repo PR (squash by default). The server reads the live PR head repository itself; fork PRs are NEVER auto-merged. Returns {merged, reason?}.",
      inputSchema: schema(
        {
          method: enumProp(["squash", "merge", "rebase"], "Merge method (default squash)"),
        },
        [],
      ),
      handler: async (a) => {
        assertOnlyArgs(a, ["method"])
        const method = optStr(a, "method")
        if (method && !["squash", "merge", "rebase"].includes(method)) throw new Error("method must be squash, merge, or rebase")
        const res = await mergePr(octokit, repo, reqEnvInt(env, "BOT_PR_NUMBER"), {
          ...(method ? { method: method as "squash" | "merge" | "rebase" } : {}),
        })
        return JSON.stringify(res)
      },
    },

    // ── Reads (raw Octokit; return data as text, never write files) ─────────
    {
      name: "get_pr_diff",
      description: "Fetch the unified diff for a PR (raw text).",
      inputSchema: prTargetSchema(prOpened, "pr_number", "Pull request number", {}, []),
      handler: async (a) => {
        const { owner, name } = ns()
        const res = await octokit.rest.pulls.get({
          owner,
          repo: name,
          pull_number: trustedPrNumber(env, a, "pr_number"),
          mediaType: { format: "diff" },
        })
        return String((res as unknown as { data?: unknown }).data ?? "")
      },
    },
    {
      name: "get_failed_logs",
      description: "For a workflow run, return its metadata plus the logs of only its failed jobs (JSON).",
      inputSchema: schema({ run_id: intProp("Workflow run id") }, ["run_id"]),
      handler: async (a) => {
        const runId = reqInt(a, "run_id")
        const { owner, name } = ns()
        const { data: run } = await octokit.rest.actions.getWorkflowRun({ owner, repo: name, run_id: runId })
        const jobs = await octokit.paginate(octokit.rest.actions.listJobsForWorkflowRun, { owner, repo: name, run_id: runId, per_page: 100 })
        const failed = jobs.filter((j) => j.conclusion === "failure")
        const logs = await Promise.all(
          failed.map(async (j) => {
            try {
              const res = await octokit.rest.actions.downloadJobLogsForWorkflowRun({ owner, repo: name, job_id: j.id })
              return compactWorkflowLog(coerceText((res as { data?: unknown }).data))
            } catch (e) {
              return `(logs unavailable for job "${j.name ?? j.id}": ${(e as Error).message})`
            }
          }),
        )
        return JSON.stringify(
          {
            run: {
              id: runId,
              name: run.name,
              status: run.status,
              conclusion: run.conclusion,
              event: run.event,
              head_branch: run.head_branch,
              head_sha: run.head_sha,
              html_url: run.html_url,
            },
            jobs: jobs.map((j) => ({ name: j.name, status: j.status, conclusion: j.conclusion })),
            failed_jobs: failed.map((j, i) => ({ name: j.name, id: j.id, logs: logs[i] || "(no logs captured)" })),
          },
          null,
          2,
        )
      },
    },
    {
      name: "get_pr_context",
      description: "Fetch PR metadata + changed files + submitted reviews (JSON). Lean context read for review/triage.",
      inputSchema: prTargetSchema(prOpened, "pr_number", "Pull request number", {}, []),
      handler: async (a) => {
        const prNumber = trustedPrNumber(env, a, "pr_number")
        const { owner, name } = ns()
        const { data: pr } = await octokit.rest.pulls.get({ owner, repo: name, pull_number: prNumber })
        const [files, reviews, reviewComments] = await Promise.all([
          octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo: name, pull_number: prNumber, per_page: 100 }),
          octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo: name, pull_number: prNumber, per_page: 100 }),
          octokit.paginate(octokit.rest.pulls.listReviewComments, { owner, repo: name, pull_number: prNumber, per_page: 100 }),
        ])
        return JSON.stringify(
          {
            number: pr.number,
            title: pr.title,
            state: pr.state,
            draft: pr.draft,
            author: pr.user?.login ?? null,
            body: pr.body ?? "",
            base: pr.base?.ref,
            head: pr.head?.ref,
            head_sha: pr.head?.sha,
            head_repo_full_name: pr.head?.repo?.full_name ?? null,
            changed_files: pr.changed_files,
            additions: pr.additions,
            deletions: pr.deletions,
            files: files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
            reviews: reviews.map((r) => ({ user: r.user?.login ?? null, state: r.state, submitted_at: r.submitted_at, body: r.body ?? "" })),
            review_comments: reviewComments.map((comment) => ({
              id: comment.id,
              node_id: comment.node_id,
              user: comment.user?.login ?? null,
              path: comment.path,
              line: comment.line,
              body: comment.body,
            })),
          },
          null,
          2,
        )
      },
    },
    {
      name: "search_issues_and_prs",
      description: "Search issues and pull requests in the trusted repository. The repository qualifier is injected by the server and cannot be overridden.",
      inputSchema: schema({ query: strProp("GitHub issue search qualifiers/text, without repo:"), state: enumProp(["open", "closed", "all"], "Optional state filter") }, ["query"]),
      handler: async (a) => {
        const query = reqOneLine(a, "query", 512)
        if (/\brepo:/i.test(query)) throw new Error("query must not contain a repo: qualifier")
        const state = optStr(a, "state") ?? "all"
        if (!["open", "closed", "all"].includes(state)) throw new Error("state must be open, closed, or all")
        const q = `repo:${repo} ${state === "all" ? "" : `is:${state} `}${query}`.trim()
        const items = await octokit.paginate(octokit.rest.search.issuesAndPullRequests, { q, per_page: 100 })
        return JSON.stringify(items.slice(0, 1000).map((item) => ({
          number: item.number,
          node_id: item.node_id,
          title: item.title,
          state: item.state,
          is_pull_request: Boolean(item.pull_request),
          url: item.html_url,
          labels: item.labels,
          user: item.user?.login ?? null,
        })))
      },
    },
    {
      name: "get_issue_context",
      description: "Read one trusted/discovered issue plus every top-level issue comment, including numeric and GraphQL ids required by moderation tools.",
      inputSchema: schema({ issue_number: intProp("Issue number") }, ["issue_number"]),
      handler: async (a) => {
        const issueNumber = reqInt(a, "issue_number")
        const { owner, name } = ns()
        const [{ data: issue }, comments] = await Promise.all([
          octokit.rest.issues.get({ owner, repo: name, issue_number: issueNumber }),
          octokit.paginate(octokit.rest.issues.listComments, { owner, repo: name, issue_number: issueNumber, per_page: 100 }),
        ])
        return JSON.stringify({
          number: issue.number,
          node_id: issue.node_id,
          title: issue.title,
          state: issue.state,
          state_reason: issue.state_reason,
          author: issue.user?.login ?? null,
          body: issue.body ?? "",
          labels: issue.labels,
          assignees: issue.assignees?.map((assignee) => assignee.login) ?? [],
          milestone: issue.milestone ? { number: issue.milestone.number, title: issue.milestone.title, state: issue.milestone.state } : null,
          comments: comments.map((comment) => ({
            id: comment.id,
            node_id: comment.node_id,
            user: comment.user?.login ?? null,
            body: comment.body ?? "",
            created_at: comment.created_at,
          })),
        })
      },
    },
    {
      name: "get_actor_permission",
      description: "Resolve whether an actor has repository write authority, with organization membership as the existing fail-closed fallback.",
      inputSchema: schema({ actor: strProp("GitHub login") }, ["actor"]),
      handler: async (a) => {
        const actor = reqOneLine(a, "actor", 64)
        const { owner, name } = ns()
        try {
          const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo: name, username: actor })
          const permission = String(data.permission ?? "none")
          if (["admin", "maintain", "write"].includes(permission)) {
            return JSON.stringify({ actor, permission, can_write: true, source: "repository" })
          }
        } catch { /* organization membership fallback below */ }
        try {
          await octokit.rest.orgs.checkMembershipForUser({ org: owner, username: actor })
          return JSON.stringify({ actor, permission: "member", can_write: true, source: "organization" })
        } catch {
          return JSON.stringify({ actor, permission: "none", can_write: false, source: "none" })
        }
      },
    },
    {
      name: "set_issue_title",
      description: "Set one trusted/discovered issue title to public product language. This tool never edits pull request titles.",
      inputSchema: schema({ issue_number: intProp("Issue number"), title: strProp("New one-line issue title (max 256 chars)") }, ["issue_number", "title"]),
      handler: async (a) => {
        const { owner, name } = ns()
        const issueNumber = reqInt(a, "issue_number")
        const { data } = await octokit.rest.issues.update({ owner, repo: name, issue_number: issueNumber, title: reqOneLine(a, "title", 256) })
        return JSON.stringify({ number: data.number ?? issueNumber, title: data.title })
      },
    },
    {
      name: "delete_issue_comment",
      description: "Delete one trusted/discovered top-level issue or PR conversation comment.",
      inputSchema: schema({ comment_id: intProp("Issue comment id") }, ["comment_id"]),
      handler: async (a) => {
        const { owner, name } = ns()
        const commentId = reqInt(a, "comment_id")
        await octokit.rest.issues.deleteComment({ owner, repo: name, comment_id: commentId })
        return JSON.stringify({ deleted: true, comment_id: commentId })
      },
    },
    {
      name: "delete_review_comment",
      description: "Delete one trusted/discovered pull request review comment.",
      inputSchema: schema({ comment_id: intProp("Review comment id") }, ["comment_id"]),
      handler: async (a) => {
        const { owner, name } = ns()
        const commentId = reqInt(a, "comment_id")
        await octokit.rest.pulls.deleteReviewComment({ owner, repo: name, comment_id: commentId })
        return JSON.stringify({ deleted: true, comment_id: commentId })
      },
    },
    {
      name: "minimize_comment",
      description: "Minimize one trusted/discovered issue or review comment with a bounded GitHub moderation classifier.",
      inputSchema: schema({ subject_id: strProp("Comment GraphQL node id"), classifier: enumProp(MINIMIZE_CLASSIFIERS, "Moderation classifier") }, ["subject_id", "classifier"]),
      handler: async (a) => {
        const classifier = reqStr(a, "classifier")
        if (!MINIMIZE_CLASSIFIERS.includes(classifier as (typeof MINIMIZE_CLASSIFIERS)[number])) {
          throw new Error(`classifier must be one of ${MINIMIZE_CLASSIFIERS.join(", ")}`)
        }
        const data = (await octokit.graphql(MINIMIZE_COMMENT, { id: reqStr(a, "subject_id"), classifier })) as {
          minimizeComment?: { minimizedComment?: { isMinimized?: boolean; minimizedReason?: string | null } }
        }
        return JSON.stringify(data.minimizeComment?.minimizedComment ?? { isMinimized: true, minimizedReason: classifier })
      },
    },
    {
      name: "list_comment_reactions",
      description: "List all reactions on one trusted/discovered issue comment.",
      inputSchema: schema({ comment_id: intProp("Issue comment id") }, ["comment_id"]),
      handler: async (a) => {
        const { owner, name } = ns()
        const commentId = reqInt(a, "comment_id")
        const reactions = await octokit.paginate(octokit.rest.reactions.listForIssueComment, { owner, repo: name, comment_id: commentId, per_page: 100 })
        return JSON.stringify(reactions.map((reaction) => ({ id: reaction.id, content: reaction.content, user: reaction.user?.login ?? null })))
      },
    },

    // ── Mutations (raw Octokit) ─────────────────────────────────────────────
    {
      name: "add_label",
      description: "Add one or more existing labels to a PR or issue (generic add; use add_triage_label / add_lgtm_label for the managed labels).",
      inputSchema: schema(
        { number: intProp("PR or issue number"), labels: { type: "array", minItems: 1, items: { type: "string" }, description: "Label names to add" } },
        ["number", "labels"],
      ),
      handler: async (a) => {
        const labels = a.labels
        if (!Array.isArray(labels) || labels.length === 0 || !labels.every((l) => typeof l === "string" && l.length > 0)) {
          throw new Error("labels must be a non-empty array of non-empty strings")
        }
        const { owner, name } = ns()
        await octokit.rest.issues.addLabels({ owner, repo: name, issue_number: reqInt(a, "number"), labels: labels as string[] })
        return "labels added"
      },
    },
    {
      name: "remove_label",
      description: "Remove a single label from a PR or issue.",
      inputSchema: schema({ number: intProp("PR or issue number"), label: strProp("Label name to remove") }, ["number", "label"]),
      handler: async (a) => {
        const { owner, name } = ns()
        await octokit.rest.issues.removeLabel({ owner, repo: name, issue_number: reqInt(a, "number"), name: reqStr(a, "label") })
        return "label removed"
      },
    },
    {
      name: "set_milestone",
      description: "Set (by numeric milestone id) or clear (null) the milestone of a PR or issue.",
      inputSchema: schema(
        { number: intProp("PR or issue number"), milestone: { type: ["integer", "null"], description: "Milestone number id, or null to clear" } },
        ["number", "milestone"],
      ),
      handler: async (a) => {
        const m = a.milestone
        let milestone: number | null
        if (m === null) milestone = null
        else if (typeof m === "number" && Number.isInteger(m) && m >= 1) milestone = m
        else throw new Error("milestone must be a positive integer id or null to clear")
        const { owner, name } = ns()
        await octokit.rest.issues.update({ owner, repo: name, issue_number: reqInt(a, "number"), milestone })
        return milestone === null ? "milestone cleared" : "milestone set"
      },
    },
    {
      name: "add_reaction",
      description:
        "Add ONE emoji reaction to a PR or issue body. Convention: after a completed review that confirmed ZERO findings, react '+1' on the PR so the author positively knows the review ran clean (no comment spam).",
      inputSchema: prTargetSchema(
        prOpened,
        "number",
        "PR or issue number to react to",
        { content: enumProp(REACTION_CONTENTS, "Reaction emoji") },
        ["content"],
      ),
      handler: async (a) => {
        const issueNumber = trustedPrNumber(env, a, "number")
        const content = reqStr(a, "content")
        if (!REACTION_CONTENTS.includes(content as (typeof REACTION_CONTENTS)[number])) {
          throw new Error(`content must be one of ${REACTION_CONTENTS.join(", ")}`)
        }
        const finalized = finalizedReview()
        if (finalized && finalized.findingCount !== 0) {
          throw new Error("clean-review reaction is allowed only when finalized evidence has zero findings")
        }
        const { owner, name } = ns()
        await octokit.rest.reactions.createForIssue({
          owner,
          repo: name,
          issue_number: issueNumber,
          content: content as (typeof REACTION_CONTENTS)[number],
        })
        return "reaction added"
      },
    },
    {
      name: "list_review_threads",
      description:
        "List ALL inline review threads on a PR (every reviewer, human or bot) with thread node id, path/line, isResolved/isOutdated, and each comment's author + body (JSON). Use before publication to dedup semantically against OTHER reviewers' findings: a root cause already reported by someone else gets NO new inline comment — record it in the summary comment instead.",
      inputSchema: prTargetSchema(prOpened, "pr_number", "Pull request number", {}, []),
      handler: async (a) => {
        const prNumber = trustedPrNumber(env, a, "pr_number")
        const { owner, name } = ns()
        const threads: unknown[] = []
        let cursor: string | null = null
        do {
          const data = (await octokit.graphql(REVIEW_THREADS_QUERY, {
            owner,
            name,
            number: prNumber,
            cursor,
          })) as {
            repository?: {
              pullRequest?: {
                reviewThreads?: {
                  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
                  nodes?: unknown[]
                }
              }
            }
          }
          const conn = data?.repository?.pullRequest?.reviewThreads
          threads.push(...(conn?.nodes ?? []))
          cursor = conn?.pageInfo?.hasNextPage ? (conn.pageInfo.endCursor ?? null) : null
        } while (cursor)
        return JSON.stringify({ pr_number: prNumber, threads }, null, 2)
      },
    },
    {
      name: "resolve_review_thread",
      description:
        "Resolve one inline review thread by its GraphQL node id (from list_review_threads). Use ONLY to dedup: when two or more reviewers reported the SAME root cause, resolve the less correct/less precise duplicates and keep exactly one canonical thread open. Never resolve a thread that raises a distinct unaddressed issue.",
      inputSchema: schema({ thread_id: strProp("Review thread node id (from list_review_threads)") }, ["thread_id"]),
      handler: async (a) => {
        const data = (await octokit.graphql(RESOLVE_THREAD_MUTATION, { id: reqStr(a, "thread_id") })) as {
          resolveReviewThread?: { thread?: { id?: string; isResolved?: boolean } }
        }
        return JSON.stringify({
          thread_id: data?.resolveReviewThread?.thread?.id ?? null,
          is_resolved: data?.resolveReviewThread?.thread?.isResolved ?? false,
        })
      },
    },
    {
      name: "get_discussion",
      description: "Read the trusted repository discussion and all top-level comments through a fixed GraphQL query.",
      inputSchema: schema({ number: intProp("Discussion number") }, ["number"]),
      handler: async (a) => {
        const number = trustedDiscussionNumber(env, a, "number")
        const { owner, name } = ns()
        let cursor: string | null = null
        let discussion: Record<string, unknown> | undefined
        const comments: unknown[] = []
        do {
          const data = (await octokit.graphql(DISCUSSION_QUERY, { owner, name, number, cursor })) as {
            repository?: { discussion?: {
              id?: string
              number?: number
              title?: string
              comments?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: unknown[] }
            } | null } | null
          }
          const current = data.repository?.discussion
          if (!current) throw new Error(`discussion #${number} was not found`)
          discussion ??= { id: current.id, number: current.number, title: current.title }
          comments.push(...(current.comments?.nodes ?? []))
          cursor = current.comments?.pageInfo?.hasNextPage ? current.comments.pageInfo.endCursor ?? null : null
        } while (cursor)
        return JSON.stringify({ ...discussion, comments })
      },
    },
    {
      name: "add_discussion_comment",
      description: "Add one comment to a discussion id returned by get_discussion.",
      inputSchema: schema({ discussion_id: strProp("Discussion node id"), body: strProp("Comment markdown") }, ["discussion_id", "body"]),
      handler: async (a) => {
        const data = (await octokit.graphql(DISCUSSION_ADD_COMMENT, {
          id: reqStr(a, "discussion_id"),
          body: reqStr(a, "body"),
        })) as { addDiscussionComment?: { comment?: { id?: string } } }
        return JSON.stringify({ comment_id: data.addDiscussionComment?.comment?.id ?? null })
      },
    },
    {
      name: "update_discussion_comment",
      description: "Update one discussion comment id returned by get_discussion or add_discussion_comment.",
      inputSchema: schema({ comment_id: strProp("Discussion comment node id"), body: strProp("Replacement markdown") }, ["comment_id", "body"]),
      handler: async (a) => {
        const data = (await octokit.graphql(DISCUSSION_UPDATE_COMMENT, {
          id: reqStr(a, "comment_id"),
          body: reqStr(a, "body"),
        })) as { updateDiscussionComment?: { comment?: { id?: string } } }
        return JSON.stringify({ comment_id: data.updateDiscussionComment?.comment?.id ?? null })
      },
    },
    {
      name: "rerun_workflow_run",
      description: "Re-run a workflow run (all jobs, or only failed jobs when failed_only=true).",
      inputSchema: schema({ run_id: intProp("Workflow run id"), failed_only: boolProp("Re-run only the failed jobs") }, ["run_id"]),
      handler: async (a) => {
        const runId = reqInt(a, "run_id")
        const failedOnly = a.failed_only === true
        const { owner, name } = ns()
        if (failedOnly) await octokit.rest.actions.reRunWorkflowFailedJobs({ owner, repo: name, run_id: runId })
        else await octokit.rest.actions.reRunWorkflow({ owner, repo: name, run_id: runId })
        return failedOnly ? "failed jobs re-run requested" : "workflow re-run requested"
      },
    },
    {
      name: "cancel_workflow_run",
      description: "Cancel an in-progress workflow run.",
      inputSchema: schema({ run_id: intProp("Workflow run id") }, ["run_id"]),
      handler: async (a) => {
        const { owner, name } = ns()
        await octokit.rest.actions.cancelWorkflowRun({ owner, repo: name, run_id: reqInt(a, "run_id") })
        return "workflow run cancel requested"
      },
    },
    {
      name: "create_pull_request",
      description: "Create a pull request in the trusted repository after the head branch has been pushed.",
      inputSchema: schema({
        base: strProp("Base branch"),
        head: strProp("Head branch in the trusted repository"),
        title: strProp("Pull request title"),
        body: strProp("Pull request body"),
      }, ["base", "head", "title", "body"]),
      handler: async (a) => {
        const { owner, name } = ns()
        const { data } = await octokit.rest.pulls.create({
          owner,
          repo: name,
          base: reqStr(a, "base"),
          head: reqStr(a, "head"),
          title: reqStr(a, "title"),
          body: reqStr(a, "body"),
        })
        return JSON.stringify({ number: data.number, url: data.html_url })
      },
    },
    {
      name: "list_milestones",
      description: "List every open and closed milestone in the trusted repository.",
      inputSchema: schema({}, []),
      handler: async () => {
        const { owner, name } = ns()
        const milestones = await octokit.paginate(octokit.rest.issues.listMilestones, {
          owner,
          repo: name,
          state: "all",
          per_page: 100,
        })
        return JSON.stringify(milestones.map((milestone) => ({
          number: milestone.number,
          title: milestone.title,
          state: milestone.state,
          due_on: milestone.due_on,
        })))
      },
    },
    {
      name: "create_milestone",
      description: "Create a milestone after list_milestones proves that it does not already exist.",
      inputSchema: schema({ title: strProp("Milestone title"), description: strProp("Milestone description") }, ["title", "description"]),
      handler: async (a) => {
        const { owner, name } = ns()
        const { data } = await octokit.rest.issues.createMilestone({
          owner,
          repo: name,
          title: reqStr(a, "title"),
          description: reqStr(a, "description"),
        })
        return JSON.stringify({ number: data.number, title: data.title, state: data.state })
      },
    },
    {
      name: "close_milestone",
      description: "Close a milestone number returned by list_milestones or create_milestone.",
      inputSchema: schema({ milestone_number: intProp("Milestone number") }, ["milestone_number"]),
      handler: async (a) => {
        const { owner, name } = ns()
        const { data } = await octokit.rest.issues.updateMilestone({
          owner,
          repo: name,
          milestone_number: reqInt(a, "milestone_number"),
          state: "closed",
        })
        return JSON.stringify({ number: data.number, state: data.state })
      },
    },
    {
      name: "list_releases",
      description: "List releases in the trusted repository for release-note comparison.",
      inputSchema: schema({}, []),
      handler: async () => {
        const { owner, name } = ns()
        const releases = await octokit.paginate(octokit.rest.repos.listReleases, { owner, repo: name, per_page: 100 })
        return JSON.stringify(releases.map((release) => ({
          id: release.id,
          tag_name: release.tag_name,
          name: release.name,
          draft: release.draft,
          prerelease: release.prerelease,
          created_at: release.created_at,
        })))
      },
    },
    {
      name: "get_release",
      description: "Read one release by tag. release_notes runs are bound to BOT_RELEASE_TAG.",
      inputSchema: schema({ tag: strProp("Release tag") }, ["tag"]),
      handler: async (a) => {
        const { owner, name } = ns()
        const tag = env.BOT_TASK === "release_notes" ? reqEnv(env, "BOT_RELEASE_TAG") : reqStr(a, "tag")
        if (a.tag != null && reqStr(a, "tag") !== tag) throw new Error(`tag must match trusted BOT_RELEASE_TAG ${tag}`)
        const { data } = await octokit.rest.repos.getReleaseByTag({ owner, repo: name, tag })
        return JSON.stringify({
          id: data.id,
          tag_name: data.tag_name,
          name: data.name,
          body: data.body,
          draft: data.draft,
          prerelease: data.prerelease,
          created_at: data.created_at,
        })
      },
    },
    {
      name: "compare_commits",
      description: "Compare two refs in the trusted repository and return commit/file metadata for release notes.",
      inputSchema: schema({ base: strProp("Base ref"), head: strProp("Head ref") }, ["base", "head"]),
      handler: async (a) => {
        const { owner, name } = ns()
        const { data } = await octokit.rest.repos.compareCommits({ owner, repo: name, base: reqStr(a, "base"), head: reqStr(a, "head") })
        return JSON.stringify({
          status: data.status,
          ahead_by: data.ahead_by,
          behind_by: data.behind_by,
          total_commits: data.total_commits,
          commits: data.commits.map((commit) => ({
            sha: commit.sha,
            message: commit.commit.message,
            author: commit.author?.login ?? commit.commit.author?.name ?? null,
          })),
          files: data.files?.map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
          })) ?? [],
        })
      },
    },
    {
      name: "update_release_notes",
      description: "Replace the trusted release body after get_release has established its release id.",
      inputSchema: schema({ tag: strProp("Release tag"), body: strProp("Complete replacement release body") }, ["tag", "body"]),
      handler: async (a) => {
        const { owner, name } = ns()
        const tag = env.BOT_TASK === "release_notes" ? reqEnv(env, "BOT_RELEASE_TAG") : reqStr(a, "tag")
        if (reqStr(a, "tag") !== tag) throw new Error(`tag must match trusted BOT_RELEASE_TAG ${tag}`)
        const current = await octokit.rest.repos.getReleaseByTag({ owner, repo: name, tag })
        const { data } = await octokit.rest.repos.updateRelease({
          owner,
          repo: name,
          release_id: current.data.id,
          body: reqStr(a, "body"),
        })
        return JSON.stringify({ id: data.id, tag_name: data.tag_name, url: data.html_url })
      },
    },
    {
      name: "roadmap_add_item",
      description:
        "Add an issue/PR (by its GraphQL content node id) to a Projects v2 roadmap board (addProjectV2ItemById). Returns the new project item id. Resolve project_id/content_id first with a read (or roadmap_graphql).",
      inputSchema: schema(
        { project_id: strProp("ProjectV2 node id"), content_id: strProp("Issue/PR content node id") },
        ["project_id", "content_id"],
      ),
      handler: async (a) => {
        const data = (await octokit.graphql(ROADMAP_ADD_ITEM, {
          p: reqStr(a, "project_id"),
          c: reqStr(a, "content_id"),
        })) as { addProjectV2ItemById?: { item?: { id?: string } } }
        return JSON.stringify({ item_id: data?.addProjectV2ItemById?.item?.id ?? null })
      },
    },
    {
      name: "roadmap_move_item",
      description:
        "Move a roadmap item to a Status column: set its single-select field value (updateProjectV2ItemFieldValue). Needs the project/item/field/option node ids (resolve via roadmap_graphql or a read).",
      inputSchema: schema(
        {
          project_id: strProp("ProjectV2 node id"),
          item_id: strProp("ProjectV2 item node id"),
          field_id: strProp("Single-select field (Status) node id"),
          option_id: strProp("Target single-select option id (the column)"),
        },
        ["project_id", "item_id", "field_id", "option_id"],
      ),
      handler: async (a) => {
        const data = (await octokit.graphql(ROADMAP_MOVE_ITEM, {
          p: reqStr(a, "project_id"),
          i: reqStr(a, "item_id"),
          f: reqStr(a, "field_id"),
          o: reqStr(a, "option_id"),
        })) as { updateProjectV2ItemFieldValue?: { projectV2Item?: { id?: string } } }
        return JSON.stringify({ item_id: data?.updateProjectV2ItemFieldValue?.projectV2Item?.id ?? null })
      },
    },
    {
      name: "roadmap_archive_item",
      description: "Archive one Projects v2 item using project/item ids returned by roadmap_graphql.",
      inputSchema: schema({ project_id: strProp("ProjectV2 node id"), item_id: strProp("Project item node id") }, ["project_id", "item_id"]),
      handler: async (a) => {
        const data = (await octokit.graphql(ROADMAP_ARCHIVE_ITEM, {
          p: reqStr(a, "project_id"),
          i: reqStr(a, "item_id"),
        })) as { archiveProjectV2Item?: { item?: { id?: string } } }
        return JSON.stringify({ item_id: data.archiveProjectV2Item?.item?.id ?? null })
      },
    },
    {
      name: "roadmap_bootstrap_status_schema",
      description:
        "Create or repair the trusted roadmap Status field and normalize the trusted project description/readme. Project and field ids must come from roadmap_graphql discovery.",
      inputSchema: schema(
        {
          project_id: strProp("Trusted ProjectV2 node id"),
          status_field_id: strProp("Existing Status field id; omit to create it"),
        },
        ["project_id"],
      ),
      handler: async (a) => {
        assertOnlyArgs(a, ["project_id", "status_field_id"])
        const projectId = reqStr(a, "project_id")
        const statusFieldId = optStr(a, "status_field_id")
        const options = ROADMAP_STATUS_OPTIONS.map(({ name, color, description }) => ({ name, color, description }))
        let resolvedStatusFieldId = statusFieldId
        if (statusFieldId) {
          const data = await octokit.graphql(ROADMAP_UPDATE_STATUS_FIELD, { f: statusFieldId, opts: options }) as {
            updateProjectV2Field?: { projectV2Field?: { id?: string } }
          }
          resolvedStatusFieldId = data.updateProjectV2Field?.projectV2Field?.id ?? statusFieldId
        } else {
          const data = await octokit.graphql(ROADMAP_CREATE_STATUS_FIELD, { p: projectId, opts: options }) as {
            createProjectV2Field?: { projectV2Field?: { id?: string } }
          }
          resolvedStatusFieldId = data.createProjectV2Field?.projectV2Field?.id
          if (!resolvedStatusFieldId) throw new Error("GitHub did not return the created Status field id")
        }
        await octokit.graphql(ROADMAP_UPDATE_PROJECT, {
          p: projectId,
          description: ROADMAP_PROJECT_DESCRIPTION,
          readme: ROADMAP_PROJECT_README,
        })
        return JSON.stringify({ project_id: projectId, status_field_id: resolvedStatusFieldId, created: !statusFieldId })
      },
    },
    {
      name: "roadmap_graphql",
      description:
        "Read one page of the trusted Projects v2 roadmap with the fixed discovery query. Repository owner and project number are derived from trusted BOT_* metadata.",
      inputSchema: schema(
        {
          cursor: strProp("Optional page cursor returned by the previous page"),
        },
        [],
      ),
      handler: async (a) => {
        assertOnlyArgs(a, ["cursor"])
        const { owner } = ns()
        const data = await octokit.graphql(ROADMAP_DISCOVERY_QUERY, {
          owner,
          number: reqEnvInt(env, "BOT_ROADMAP_PROJECT"),
          cursor: optStr(a, "cursor") ?? null,
        })
        return JSON.stringify(data)
      },
    },
  ]
  const allowed = TOOL_NAMES_BY_TASK[task]
  return tools.filter((tool) => allowed.has(tool.name))
}

// ── MCP wiring ───────────────────────────────────────────────────────────────

/** Strip handlers to the advertised tool definitions (the tools/list payload). */
export function toolDefinitions(tools: ToolEntry[]): Tool[] {
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
}

/** Dispatch one tools/call: find the tool, run it, and shape the result. Unknown
 *  tools and thrown validation/API errors come back as `isError` text results
 *  (never a transport-level crash), mirroring the source server's error shape. */
export async function callTool(tools: ToolEntry[], name: string, args: Args): Promise<CallToolResult> {
  const tool = tools.find((t) => t.name === name)
  if (!tool) return { isError: true, content: [{ type: "text", text: `error: unknown tool: ${name}` }] }
  try {
    const text = await tool.handler(args)
    return { content: [{ type: "text", text }] }
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `error: ${(e as Error).message}` }] }
  }
}

/** Build the MCP `Server` with the tool registry wired to `deps`. Returns both the
 *  server (ready to `.connect(transport)`) and the tool table (for inspection/tests). */
export function createServer(deps: ServerDeps): { server: Server; tools: ToolEntry[] } {
  const tools = buildTools(deps)
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions(tools) }))
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    callTool(tools, req.params.name, (req.params.arguments ?? {}) as Args),
  )
  return { server, tools }
}

/** Direct/standalone entry fallback. Production Codex sessions use the
 * supervisor-owned broker and its in-memory rotating token instead. */
export function resolveTokenSource(env: Record<string, string | undefined>): TokenSource {
  const token = env.GH_TOKEN
  if (!token) throw new Error("GH_TOKEN is required")
  return token
}

/** Runnable entry: build the one Octokit client for BOT_REPO and serve over stdio. */
export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const repo = env.BOT_REPO
  if (!repo) throw new Error("BOT_REPO is required")
  const brokerClient = env.CCHP_GITHUB_BROKER_SOCKET && env.CCHP_GITHUB_BROKER_TOKEN
    ? makeBrokerGitHubClient(env.CCHP_GITHUB_BROKER_SOCKET, env.CCHP_GITHUB_BROKER_TOKEN)
    : undefined
  const octokit = brokerClient ?? makeOctokit(resolveTokenSource(env))
  const { server } = createServer({
    octokit,
    repo,
    env,
    ...(brokerClient ? { runtime: (brokerClient as unknown as { cchp: ServerDeps["runtime"] }).cchp! } : {}),
  })
  await server.connect(new StdioServerTransport())
  process.stderr.write(`[cchp-mcp] ${SERVER_NAME} server ready\n`)
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    process.stderr.write(`[cchp-mcp] fatal: ${(err as Error)?.message ?? String(err)}\n`)
    process.exit(1)
  })
}
