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
import { lstatSync, readFileSync } from "node:fs"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import { splitRepo } from "../context"
import { fileTokenGetter, makeOctokit, type GitHubClient, type TokenSource } from "../github/client"
import {
  CHECK_ACTIONS,
  type CheckAction,
  type CheckConclusion,
  type CheckStatus,
  createCheckRun,
  updateCheckRun,
} from "../publish/checkrun"
import {
  type InlineComment,
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
  setPrTitle,
} from "../publish/meta"
import { mergePr } from "../publish/merge"
import { autoApproveDisabled, type ReviewComment, submitReview } from "../publish/review"
import { upsertSticky } from "../publish/sticky"
import { MARKER, type Verdict } from "../types"

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

// ── module deps + injection seams (all default to the real world; tests override) ──

/** What the server needs to run. `env` and `readTrustedPatch` are injectable so the
 *  env-bound inline path + the kill-switch are unit-testable without disk or real env. */
export interface ServerDeps {
  octokit: GitHubClient
  /** `owner/name` of the repository the run targets (BOT_REPO). */
  repo: string
  /** Defaults to `process.env`; the source of BOT_* run bindings + the kill-switch. */
  env?: Record<string, string | undefined>
  /** Reads the trusted current-PR patch (defaults to the BOT_PATCH_FILE disk read). */
  readTrustedPatch?: () => string
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

/** Default trusted-patch reader: the source MCP server's `trustedPatch` disk read —
 *  BOT_PATCH_FILE must be a regular (non-symlink) file with commentable content.
 *  Emptiness / no-hunk is re-checked authoritatively by `postReviewBatch`. */
function defaultReadTrustedPatch(env: Record<string, string | undefined>): string {
  const file = env.BOT_PATCH_FILE
  if (!file) throw new Error("BOT_PATCH_FILE is not configured; inline publication is unavailable")
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("trusted patch file is not a regular file")
  const text = readFileSync(file, "utf8")
  if (!text.trim()) throw new Error("trusted patch is empty")
  return text
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

// Inline review comment anchor+finding (batch item).
const INLINE_COMMENT_ITEM: object = {
  type: "object",
  properties: {
    path: { type: "string", description: "Repository-relative file path" },
    line: { type: "integer", description: "Line number in the diff" },
    side: { type: "string", enum: ["LEFT", "RIGHT"] },
    start_line: { type: "integer" },
    start_side: { type: "string", enum: ["LEFT", "RIGHT"] },
    body: { type: "string", description: "Comment markdown body" },
    fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$", description: "Stable root-cause SHA-256 fingerprint" },
  },
  required: ["path", "line", "body", "fingerprint"],
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
  const readTrustedPatch = deps.readTrustedPatch ?? (() => defaultReadTrustedPatch(env))
  const ns = () => splitRepo(repo)

  return [
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
      inputSchema: schema(
        {
          issue_number: intProp("PR or issue number to comment on"),
          sticky_key: { type: "string", pattern: STICKY_KEY_RE.source, description: "Optional: upsert an existing cchp-bot:<sticky_key> comment" },
          ...STRUCTURED_PROPS,
        },
        ["issue_number", "summary"],
      ),
      handler: async (a) => {
        const res = await postStructuredComment(octokit, repo, reqInt(a, "issue_number"), {
          ...structuredInput(a),
          sticky_key: optStr(a, "sticky_key"),
        })
        return JSON.stringify(res)
      },
    },
    {
      name: "update_structured_comment",
      description: "Re-render and replace an existing bot comment by id (e.g. acknowledge an action selection, mark items done).",
      inputSchema: schema({ comment_id: intProp("Existing comment id to overwrite"), ...STRUCTURED_PROPS }, ["comment_id", "summary"]),
      handler: async (a) => {
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
          comments: { type: "array", minItems: 1, description: "1..50 confirmed inline findings", items: INLINE_COMMENT_ITEM },
          summary: strProp("Optional review-level summary body"),
        },
        ["comments"],
      ),
      handler: async (a) => {
        if (!Array.isArray(a.comments) || a.comments.length === 0) throw new Error("comments must be a non-empty array")
        const res = await postReviewBatch(octokit, repo, {
          prNumber: reqEnvInt(env, "BOT_PR_NUMBER"),
          headSha: reqEnv(env, "BOT_HEAD_SHA"),
          patch: readTrustedPatch(),
          comments: a.comments as InlineComment[],
          summary: optStr(a, "summary"),
        })
        return JSON.stringify(res)
      },
    },
    {
      name: "submit_pr_review",
      description:
        "Submit the formal Pull Request Review verdict (COMMENT / REQUEST_CHANGES / APPROVE). The agent chooses autonomously incl. on fork PRs; the org-var kill-switch (CCHP_DISABLE_AUTO_APPROVE) downgrades an APPROVE to a COMMENT.",
      inputSchema: schema(
        {
          pr_number: intProp("Pull request number"),
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
        ["pr_number", "event", "body"],
      ),
      handler: async (a) => {
        const prNumber = reqInt(a, "pr_number")
        const event = reqStr(a, "event")
        if (!VERDICTS.includes(event as Verdict)) throw new Error(`event must be one of ${VERDICTS.join(", ")}`)
        if (a.comments != null && !Array.isArray(a.comments)) throw new Error("comments must be an array")
        const res = await submitReview(octokit, repo, prNumber, {
          event: event as Verdict,
          body: reqStr(a, "body"),
          ...(a.comments ? { comments: a.comments as ReviewComment[] } : {}),
          autoApproveDisabled: autoApproveDisabled(env),
        })
        return JSON.stringify(res)
      },
    },
    {
      name: "create_check_run",
      description: "Open a queued Check Run (machine-readable review-run status) with external_id = the internal run id. Returns the new check_run_id.",
      inputSchema: schema(
        { name: strProp("Check run name"), head_sha: strProp("Commit SHA to attach the run to"), external_id: strProp("Internal run id (external_id)") },
        ["name", "head_sha", "external_id"],
      ),
      handler: async (a) => {
        const id = await createCheckRun(octokit, repo, {
          name: reqStr(a, "name"),
          headSha: reqStr(a, "head_sha"),
          externalId: reqStr(a, "external_id"),
        })
        return JSON.stringify({ check_run_id: id })
      },
    },
    {
      name: "update_check_run",
      description:
        "Advance/complete a Check Run: status (queued/in_progress/completed), an optional conclusion, an output title+summary, and up to 3 review-run action buttons (action_keys: applyFixes/deepReReview/dismiss).",
      inputSchema: schema(
        {
          check_run_id: intProp("Check run id from create_check_run"),
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
        ["check_run_id", "status", "title", "summary"],
      ),
      handler: async (a) => {
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
        await updateCheckRun(octokit, repo, reqInt(a, "check_run_id"), {
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
      inputSchema: schema({ pr_number: intProp("Pull request number"), title: strProp("New title") }, ["pr_number", "title"]),
      handler: async (a) => {
        await setPrTitle(octokit, repo, reqInt(a, "pr_number"), reqStr(a, "title"))
        return "title updated"
      },
    },
    {
      name: "post_comment",
      description: "Post a short single-line top-level comment (≤4096 chars) on a PR or issue.",
      inputSchema: schema({ issue_number: intProp("PR or issue number"), comment: strProp("One-line comment body") }, ["issue_number", "comment"]),
      handler: async (a) => JSON.stringify(await postComment(octokit, repo, reqInt(a, "issue_number"), reqStr(a, "comment"))),
    },
    {
      name: "comment_file",
      description: "Post a multi-line top-level comment (1..65536 bytes) on a PR or issue.",
      inputSchema: schema({ issue_number: intProp("PR or issue number"), body: strProp("Multi-line comment body") }, ["issue_number", "body"]),
      handler: async (a) => JSON.stringify(await commentFile(octokit, repo, reqInt(a, "issue_number"), reqStr(a, "body"))),
    },
    {
      name: "close",
      description: "Post a closing comment (≤512 chars, single line) then close the PR or issue.",
      inputSchema: schema({ number: intProp("PR or issue number"), reason: strProp("Closing comment") }, ["number", "reason"]),
      handler: async (a) => {
        await closePrOrIssue(octokit, repo, reqInt(a, "number"), reqStr(a, "reason"))
        return "closed"
      },
    },
    {
      name: "lock",
      description: "Lock the conversation with a reason (spam / off_topic / resolved / too_heated).",
      inputSchema: schema(
        { number: intProp("PR or issue number"), reason: enumProp(["spam", "off_topic", "resolved", "too_heated"], "Lock reason") },
        ["number", "reason"],
      ),
      handler: async (a) => {
        await lockConversation(octokit, repo, reqInt(a, "number"), reqStr(a, "reason"))
        return "locked"
      },
    },
    {
      name: "add_triage_label",
      description: "Ensure + add a triage label (spam / invalid, fixed colors) to a PR.",
      inputSchema: schema({ pr_number: intProp("Pull request number"), label: enumProp(["spam", "invalid"], "Triage label") }, ["pr_number", "label"]),
      handler: async (a) => {
        await addTriageLabel(octokit, repo, reqInt(a, "pr_number"), reqStr(a, "label"))
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
        "Merge a same-repo PR (squash by default). Fork PRs (head_repo_full_name != this repo, or null) are NEVER auto-merged — a maintainer merges manually (ADR 0004). Returns {merged, reason?}.",
      inputSchema: schema(
        {
          pr_number: intProp("Pull request number"),
          head_repo_full_name: { type: ["string", "null"], description: "PR head repo full name (owner/name), or null for a deleted fork" },
          method: enumProp(["squash", "merge", "rebase"], "Merge method (default squash)"),
        },
        ["pr_number", "head_repo_full_name"],
      ),
      handler: async (a) => {
        const head = a.head_repo_full_name
        if (head !== null && typeof head !== "string") throw new Error("head_repo_full_name must be a string or null")
        const method = optStr(a, "method")
        if (method && !["squash", "merge", "rebase"].includes(method)) throw new Error("method must be squash, merge, or rebase")
        const res = await mergePr(octokit, repo, reqInt(a, "pr_number"), {
          headRepoFullName: head,
          ...(method ? { method: method as "squash" | "merge" | "rebase" } : {}),
        })
        return JSON.stringify(res)
      },
    },

    // ── Reads (raw Octokit; return data as text, never write files) ─────────
    {
      name: "get_pr_diff",
      description: "Fetch the unified diff for a PR (raw text).",
      inputSchema: schema({ pr_number: intProp("Pull request number") }, ["pr_number"]),
      handler: async (a) => {
        const { owner, name } = ns()
        const res = await octokit.rest.pulls.get({
          owner,
          repo: name,
          pull_number: reqInt(a, "pr_number"),
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
              return coerceText((res as { data?: unknown }).data)
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
      inputSchema: schema({ pr_number: intProp("Pull request number") }, ["pr_number"]),
      handler: async (a) => {
        const prNumber = reqInt(a, "pr_number")
        const { owner, name } = ns()
        const { data: pr } = await octokit.rest.pulls.get({ owner, repo: name, pull_number: prNumber })
        const [files, reviews] = await Promise.all([
          octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo: name, pull_number: prNumber, per_page: 100 }),
          octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo: name, pull_number: prNumber, per_page: 100 }),
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
          },
          null,
          2,
        )
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
      inputSchema: schema(
        { number: intProp("PR or issue number to react to"), content: enumProp(REACTION_CONTENTS, "Reaction emoji") },
        ["number", "content"],
      ),
      handler: async (a) => {
        const content = reqStr(a, "content")
        if (!REACTION_CONTENTS.includes(content as (typeof REACTION_CONTENTS)[number])) {
          throw new Error(`content must be one of ${REACTION_CONTENTS.join(", ")}`)
        }
        const { owner, name } = ns()
        await octokit.rest.reactions.createForIssue({
          owner,
          repo: name,
          issue_number: reqInt(a, "number"),
          content: content as (typeof REACTION_CONTENTS)[number],
        })
        return "reaction added"
      },
    },
    {
      name: "list_review_threads",
      description:
        "List ALL inline review threads on a PR (every reviewer, human or bot) with thread node id, path/line, isResolved/isOutdated, and each comment's author + body (JSON). Use before publication to dedup semantically against OTHER reviewers' findings: a root cause already reported by someone else gets NO new inline comment — record it in the summary comment instead.",
      inputSchema: schema({ pr_number: intProp("Pull request number") }, ["pr_number"]),
      handler: async (a) => {
        const prNumber = reqInt(a, "pr_number")
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
      name: "roadmap_graphql",
      description:
        "Thin GraphQL passthrough for the low-frequency roadmap operations the typed tools don't cover (resolving project / Status field / option node ids, integer-number lookups, full reconcile per roadmap-policy). Runs one operation via the shared client; returns the raw JSON response.",
      inputSchema: schema(
        {
          query: strProp("A single GraphQL query or mutation"),
          variables: { type: "object", description: "Optional GraphQL variables" },
        },
        ["query"],
      ),
      handler: async (a) => {
        const variables = a.variables
        if (variables != null && (typeof variables !== "object" || Array.isArray(variables))) {
          throw new Error("variables must be an object")
        }
        const data = await octokit.graphql(reqStr(a, "query"), (variables as Record<string, unknown>) ?? {})
        return JSON.stringify(data)
      },
    },
  ]
}

// Standard Projects v2 mutations (fixed operations; contract per ADR 0006).
const ROADMAP_ADD_ITEM = `mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}`
const ROADMAP_MOVE_ITEM = `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}`

// Review-thread dedup surface (fixed operations): read every reviewer's inline
// threads, resolve a confirmed-duplicate thread. Comments are capped at 50 per
// thread — dedup needs the opening claim, not a full transcript.
const REVIEW_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){pullRequest(number:$number){
    reviewThreads(first:100,after:$cursor){
      pageInfo{hasNextPage endCursor}
      nodes{id isResolved isOutdated path line startLine
        comments(first:50){nodes{databaseId author{login} body createdAt}}}}}}}`
const RESOLVE_THREAD_MUTATION = `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}`

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

/** Prefer the sidecar-rotated token file (CCHP_GH_TOKEN_FILE, path injected by
 *  run.sh) so a >1h session never authenticates with an expired token; fall back
 *  to the original static GH_TOKEN behaviour when no file is configured. */
export function resolveTokenSource(env: Record<string, string | undefined>): TokenSource {
  const file = env.CCHP_GH_TOKEN_FILE
  const token = env.GH_TOKEN
  if (file) return fileTokenGetter(file, token)
  if (!token) throw new Error("GH_TOKEN is required")
  return token
}

/** Runnable entry: build the one Octokit client for BOT_REPO and serve over stdio. */
export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const repo = env.BOT_REPO
  if (!repo) throw new Error("BOT_REPO is required")
  const octokit = makeOctokit(resolveTokenSource(env))
  const { server } = createServer({ octokit, repo, env })
  await server.connect(new StdioServerTransport())
  process.stderr.write(`[cchp-mcp] ${SERVER_NAME} server ready\n`)
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    process.stderr.write(`[cchp-mcp] fatal: ${(err as Error)?.message ?? String(err)}\n`)
    process.exit(1)
  })
}
