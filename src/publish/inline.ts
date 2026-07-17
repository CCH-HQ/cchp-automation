// Inline review-comment publication, ported from the custom MCP server
// `.github/cchp-bot/mcp/inline-comment-server.mjs` (gh → Octokit, ADR 0003).
// Two families, both preserving the frozen contract (DESIGN §8):
//
//   * Inline Findings — one confirmed comment per verified issue, anchored to a
//     line/side that is provably present in the trusted current PR patch, with
//     cross-Run fingerprint dedup (`cchp-review-fingerprint:<sha256>`). Single
//     (`createInlineComment`) or one-review batch (`postReviewBatch`). Anchoring
//     uses `line`/`side`/`start_line`/`start_side` — never the deprecated
//     `position`.
//   * Structured conversation comments — pr-agent-style server-side templates
//     (TL;DR, metadata table, collapsible sections, action checklist, footnotes)
//     posted (`postStructuredComment`, optionally sticky-upserted) or re-rendered
//     in place (`updateStructuredComment`).
//
// All free text passes through `sanitizeText`, which strips HTML comments so
// model-provided content can never spoof fingerprint / sticky / action Markers.
//
// The MCP-layer wrapping stays with the caller: the `confirmed` dry-run flag, the
// finalizer gate (`maybeRequireFinalized` — a `pr_opened`-only review-artifact
// check owned by the #5 review pipeline), env resolution (BOT_*), and reading the
// trusted patch file off disk. This module takes the trusted patch as input and
// performs the Octokit publication + dedup.
import { splitRepo } from "../context"
import type { GitHubClient } from "../github/client"
import { findByMarker, hidden, MARKER } from "../types"

// ── frozen validators / thresholds (verbatim from the MCP server) ────────────
export type Side = "LEFT" | "RIGHT"
const SIDES = new Set<Side>(["LEFT", "RIGHT"])
/** A finding Fingerprint is a lowercase SHA-256 hex string. */
export const FINGERPRINT_RE = /^[0-9a-f]{64}$/
// Extracts embedded fingerprint Markers from a comment body. Corresponds exactly
// to `hidden(MARKER.fingerprint(sha))` = `<!-- cchp-review-fingerprint:<sha> -->`.
const FINGERPRINT_MARKER_RE = /<!-- cchp-review-fingerprint:([0-9a-f]{64}) -->/g
const ACTION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const STICKY_KEY_RE = /^[a-z0-9][a-z0-9:._-]{0,63}$/
const COLLAPSE_THRESHOLD = 1200

// ── patch anchoring (trusted current PR patch) ───────────────────────────────

/** A parsed unified-diff patch: path → { LEFT, RIGHT } maps of commentable line
 *  number → hunk index. A line is anchorable iff it appears here. */
export type PatchIndex = Map<string, { LEFT: Map<number, number>; RIGHT: Map<number, number> }>

/** Parse a unified diff into the commentable-line index, verbatim port of the
 *  MCP server's `parsePatch`: tracks old/new line numbers + remaining counts per
 *  hunk so context/added/removed lines land on the right side, and tags each with
 *  a hunk index (used to reject multi-line anchors that cross hunks). */
export function parsePatch(text: string): PatchIndex {
  const files: PatchIndex = new Map()
  let path: string | null = null
  let oldLine = 0
  let newLine = 0
  let oldRemaining = 0
  let newRemaining = 0
  let currentHunk = 0
  for (const raw of text.split("\n")) {
    if (raw.startsWith("+++ b/")) {
      path = raw.slice(6)
      if (!files.has(path)) files.set(path, { LEFT: new Map(), RIGHT: new Map() })
      continue
    }
    const hunk = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunk) {
      currentHunk++
      oldLine = Number(hunk[1])
      newLine = Number(hunk[3])
      oldRemaining = Number(hunk[2] || 1)
      newRemaining = Number(hunk[4] || 1)
      continue
    }
    if (!path || (oldRemaining <= 0 && newRemaining <= 0) || raw.startsWith("\\ No newline")) continue
    const file = files.get(path)!
    const prefix = raw[0]
    if (prefix === " ") {
      if (oldRemaining > 0) file.LEFT.set(oldLine++, currentHunk)
      if (newRemaining > 0) file.RIGHT.set(newLine++, currentHunk)
      oldRemaining--
      newRemaining--
    } else if (prefix === "-") {
      file.LEFT.set(oldLine++, currentHunk)
      oldRemaining--
    } else if (prefix === "+") {
      file.RIGHT.set(newLine++, currentHunk)
      newRemaining--
    }
  }
  return files
}

/** Where a finding is anchored in the diff. */
export interface Anchor {
  path: string
  line: number
  side?: Side
  start_line?: number
  start_side?: Side
}

/** Validate an anchor against the trusted patch (verbatim port of the MCP
 *  server's `validateAnchor`): repo-relative path, positive commentable line,
 *  valid side, and — for multi-line anchors — a same-side start_line ≤ line that
 *  sits in the SAME hunk. Throws on any violation; returns the resolved side. */
export function validateAnchor(a: Anchor, files: PatchIndex): Side {
  if (typeof a.path !== "string" || !a.path || a.path.startsWith("/") || a.path.split("/").includes("..")) {
    throw new Error("path must be repository-relative")
  }
  if (!Number.isInteger(a.line) || a.line < 1) throw new Error("line must be a positive integer")
  const side: Side = a.side || "RIGHT"
  if (!SIDES.has(side)) throw new Error("side must be LEFT or RIGHT")
  const file = files.get(a.path)
  if (!file || !file[side].has(a.line)) throw new Error("line is not commentable in the trusted current PR patch")
  if (a.start_line != null) {
    if (!Number.isInteger(a.start_line) || a.start_line < 1 || a.start_line > a.line) {
      throw new Error("start_line must be a positive integer no greater than line")
    }
    const startSide: Side = a.start_side || side
    if (startSide !== side || !file[startSide].has(a.start_line)) {
      throw new Error("start_line is not commentable on the same patch side")
    }
    if (file[startSide].get(a.start_line) !== file[side].get(a.line)) {
      throw new Error("multi-line comments cannot cross patch hunks")
    }
  }
  return side
}

/** Accept a raw patch string (parse + reject empty / no-hunk) or a pre-parsed
 *  index. Mirrors the MCP server's `trustedPatch` content checks; reading the
 *  patch off disk (BOT_PATCH_FILE, symlink guard) stays with the caller. */
function normalizePatch(patch: string | PatchIndex): PatchIndex {
  if (typeof patch === "string") {
    if (!patch.trim()) throw new Error("trusted patch is empty")
    const files = parsePatch(patch)
    if (files.size === 0) throw new Error("trusted patch has no commentable hunks")
    return files
  }
  if (patch.size === 0) throw new Error("trusted patch has no commentable hunks")
  return patch
}

// ── text sanitization + fingerprint markers ──────────────────────────────────

/** Strip HTML comments from model-provided text — prevents spoofed fingerprint /
 *  sticky / action Markers inside rendered bodies (MCP server's `sanitizeText`). */
export function sanitizeText(t: unknown): string {
  return String(t ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim()
}

/** Remove any pre-existing fingerprint Markers from a caller-supplied body so the
 *  single canonical Marker we append is authoritative (MCP `stripFingerprintMarkers`). */
export function stripFingerprintMarkers(body: string): string {
  return body.replace(/<!-- cchp-review-fingerprint:[^>]*-->/g, "")
}

function extractFingerprints(body: string | null | undefined): string[] {
  return [...(body ?? "").matchAll(FINGERPRINT_MARKER_RE)].map((m) => m[1]!)
}

// ── review history (dedup source) ────────────────────────────────────────────

/** A simplified prior comment/review, carrying the Fingerprints it embeds. */
export interface HistoryEntry {
  kind: "inline" | "top_level" | "review"
  id?: number
  path?: string
  line?: number
  side?: string
  start_line?: number
  start_side?: string
  commit_id?: string
  body?: string
  html_url?: string
  user?: string
  created_at?: string
  in_reply_to_id?: number
  fingerprints: string[]
}

// Structural view of the three comment/review shapes we simplify (Octokit returns
// wider objects; the real responses flow in unchanged).
interface RawComment {
  id?: number
  path?: string
  line?: number
  side?: string
  start_line?: number
  start_side?: string
  commit_id?: string
  body?: string | null
  html_url?: string
  user?: { login?: string | null } | null
  created_at?: string
  in_reply_to_id?: number | null
}

const simplify = (items: readonly RawComment[], kind: HistoryEntry["kind"]): HistoryEntry[] =>
  items.map((x) => ({
    kind,
    id: x.id,
    path: x.path,
    line: x.line,
    side: x.side,
    start_line: x.start_line,
    start_side: x.start_side,
    commit_id: x.commit_id,
    body: x.body ?? undefined,
    html_url: x.html_url,
    user: x.user?.login ?? undefined,
    created_at: x.created_at,
    in_reply_to_id: x.in_reply_to_id ?? undefined,
    fingerprints: extractFingerprints(x.body),
  }))

/** Read existing inline comments, top-level comments, and submitted reviews for
 *  the PR, each simplified + tagged with the Fingerprints it embeds — the dedup
 *  corpus (MCP server's `history`). `paginate` flattens pages natively (no
 *  `--slurp` page-of-pages to unroll). */
export async function reviewHistory(octokit: GitHubClient, repo: string, prNumber: number): Promise<HistoryEntry[]> {
  const { owner, name } = splitRepo(repo)
  const [inline, issue, reviews] = await Promise.all([
    octokit.paginate(octokit.rest.pulls.listReviewComments, { owner, repo: name, pull_number: prNumber, per_page: 100 }),
    octokit.paginate(octokit.rest.issues.listComments, { owner, repo: name, issue_number: prNumber, per_page: 100 }),
    octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo: name, pull_number: prNumber, per_page: 100 }),
  ])
  return [
    ...simplify(inline as RawComment[], "inline"),
    ...simplify(issue as RawComment[], "top_level"),
    ...simplify(reviews as RawComment[], "review"),
  ]
}

// ── inline finding publication ───────────────────────────────────────────────

/** One inline finding: an anchor plus its body and stable Fingerprint. */
export interface InlineComment extends Anchor {
  body: string
  fingerprint: string
}

/** Result of a single inline publication: freshly posted, or skipped because the
 *  Fingerprint was already published (dedup). */
export type InlineOutcome = { status: "posted"; url: string } | { status: "already-posted"; ref: string }

export interface CreateInlineOpts {
  prNumber: number
  headSha: string
  /** Raw unified diff or a pre-parsed `PatchIndex` (the trusted current PR patch). */
  patch: string | PatchIndex
  comment: InlineComment
  /** Pre-fetched dedup corpus; fetched via `reviewHistory` when omitted. */
  history?: HistoryEntry[]
}

// One entry in a batch Pull Request Review's `comments` array (line-based anchor).
interface ReviewCommentPayload {
  path: string
  line: number
  side: Side
  body: string
  start_line?: number
  start_side?: Side
}

/** Publish ONE confirmed inline finding: validate body + Fingerprint, anchor it
 *  to the trusted patch, dedup against review history, then post via
 *  `pulls.createReviewComment` (line/side anchoring, HEAD commit). The single
 *  authoritative Fingerprint Marker is appended after stripping any caller-supplied
 *  ones. Returns `already-posted` (no API write) when the Fingerprint already exists. */
export async function createInlineComment(
  octokit: GitHubClient,
  repo: string,
  opts: CreateInlineOpts,
): Promise<InlineOutcome> {
  const { prNumber, headSha, comment } = opts
  if (typeof comment.body !== "string" || !comment.body.trim()) throw new Error("body is required")
  if (!FINGERPRINT_RE.test(comment.fingerprint || "")) throw new Error("fingerprint must be lowercase SHA-256 hex")
  const files = normalizePatch(opts.patch)
  const side = validateAnchor(comment, files)
  const history = opts.history ?? (await reviewHistory(octokit, repo, prNumber))
  const existing = history.find((x) => x.fingerprints.includes(comment.fingerprint))
  if (existing) return { status: "already-posted", ref: existing.html_url ?? String(existing.id ?? "") }
  const { owner, name } = splitRepo(repo)
  const body = `${stripFingerprintMarkers(comment.body).trim()}\n\n${hidden(MARKER.fingerprint(comment.fingerprint))}`
  const { data } = await octokit.rest.pulls.createReviewComment({
    owner,
    repo: name,
    pull_number: prNumber,
    commit_id: headSha,
    body,
    path: comment.path,
    line: comment.line,
    side,
    ...(comment.start_line != null
      ? { start_line: comment.start_line, start_side: comment.start_side || side }
      : {}),
  })
  return { status: "posted", url: data.html_url }
}

/** Result of a batch publication. */
export type BatchOutcome =
  | { status: "posted"; url: string; posted: number; skipped: number }
  | { status: "already-posted"; total: number }

export interface PostBatchOpts {
  prNumber: number
  headSha: string
  patch: string | PatchIndex
  comments: InlineComment[]
  summary?: string
  history?: HistoryEntry[]
}

/** Publish many confirmed findings as ONE Pull Request Review (`event: COMMENT`,
 *  single API call), verbatim gates from the MCP server's `post_review_batch`:
 *  1..50 comments; every comment's body + Fingerprint validated and anchor checked
 *  (even duplicates, before the dedup skip); already-posted Fingerprints (in
 *  history OR earlier in this batch) skipped. Returns `already-posted` with no API
 *  write when every Fingerprint was previously published. */
export async function postReviewBatch(octokit: GitHubClient, repo: string, opts: PostBatchOpts): Promise<BatchOutcome> {
  const { prNumber, headSha, comments } = opts
  if (!Array.isArray(comments) || comments.length === 0) throw new Error("comments must be a non-empty array")
  if (comments.length > 50) throw new Error("at most 50 comments per batch")
  const files = normalizePatch(opts.patch)
  const history = opts.history ?? (await reviewHistory(octokit, repo, prNumber))
  const seen = new Set(history.flatMap((x) => x.fingerprints))
  const localSeen = new Set<string>()
  const payload: ReviewCommentPayload[] = []
  let skipped = 0
  for (const c of comments) {
    if (typeof c.body !== "string" || !c.body.trim()) throw new Error("each comment requires a body")
    if (!FINGERPRINT_RE.test(c.fingerprint || "")) throw new Error("each comment requires a lowercase SHA-256 fingerprint")
    const side = validateAnchor(c, files)
    if (seen.has(c.fingerprint) || localSeen.has(c.fingerprint)) {
      skipped++
      continue
    }
    localSeen.add(c.fingerprint)
    const entry: ReviewCommentPayload = {
      path: c.path,
      line: c.line,
      side,
      body: `${stripFingerprintMarkers(c.body).trim()}\n\n${hidden(MARKER.fingerprint(c.fingerprint))}`,
    }
    if (c.start_line != null) {
      entry.start_line = c.start_line
      entry.start_side = c.start_side || side
    }
    payload.push(entry)
  }
  if (payload.length === 0) return { status: "already-posted", total: comments.length }
  const { owner, name } = splitRepo(repo)
  const summary = sanitizeText(opts.summary ?? "")
  const { data } = await octokit.rest.pulls.createReview({
    owner,
    repo: name,
    pull_number: prNumber,
    commit_id: headSha,
    event: "COMMENT",
    comments: payload,
    ...(summary ? { body: summary } : {}),
  })
  return { status: "posted", url: data.html_url, posted: payload.length, skipped }
}

// ── structured conversation comments (pr-agent-style server-side templates) ──

/** Structured-comment content (the MCP server's shared STRUCTURED_FIELDS, minus
 *  the transport-only `confirmed` flag). */
export interface StructuredInput {
  title?: string
  summary: string
  metadata?: { label: string; value: string }[]
  sections?: { title: string; body: string; collapsed?: boolean }[]
  actions?: { id: string; label: string; checked?: boolean }[]
  footnotes?: string[]
}

/** Render a structured comment body — verbatim port of the MCP server's
 *  `renderStructured`: title, required TL;DR summary, metadata table, sections
 *  (auto-`<details>` past `COLLAPSE_THRESHOLD` or when `collapsed:true`), an
 *  action checklist carrying `cchp-action:<id>` Markers (≤10, ids validated), and
 *  footnotes. Every field is sanitized; throws on missing summary / empty section
 *  / invalid action id / too many actions. */
export function renderStructured(a: StructuredInput): string {
  const parts: string[] = []
  if (a.title) parts.push(`### ${sanitizeText(a.title)}`)
  const summary = sanitizeText(a.summary)
  if (!summary) throw new Error("summary is required")
  parts.push(`> **TL;DR** — ${summary}`)
  if (Array.isArray(a.metadata) && a.metadata.length) {
    const rows = a.metadata.map((m) => `| **${sanitizeText(m.label)}** | ${sanitizeText(m.value)} |`)
    parts.push(["|    |    |", "| --- | --- |", ...rows].join("\n"))
  }
  for (const s of a.sections || []) {
    const title = sanitizeText(s.title)
    const body = sanitizeText(s.body)
    if (!title || !body) throw new Error("each section requires title and body")
    const collapse = s.collapsed === true || (s.collapsed !== false && body.length > COLLAPSE_THRESHOLD)
    parts.push(
      collapse
        ? `<details>\n<summary><b>${title}</b></summary>\n\n${body}\n\n</details>`
        : `#### ${title}\n\n${body}`,
    )
  }
  if (Array.isArray(a.actions) && a.actions.length) {
    if (a.actions.length > 10) throw new Error("at most 10 actions per menu")
    const items = a.actions.map((x) => {
      if (typeof x.id !== "string" || !ACTION_ID_RE.test(x.id)) throw new Error(`invalid action id: ${x.id}`)
      return `- [${x.checked === true ? "x" : " "}] ${sanitizeText(x.label)} ${hidden(MARKER.action(x.id))}`
    })
    parts.push(
      `#### Actions\n\n${items.join("\n")}\n\n<sub>☑️ Check a box and the bot picks it up automatically (repo members only). Completed items reset so they can be re-triggered.</sub>`,
    )
  }
  if (Array.isArray(a.footnotes) && a.footnotes.length) {
    parts.push(`---\n${a.footnotes.map((f) => `<sub>${sanitizeText(f)}</sub>`).join("\n<br>")}`)
  }
  return parts.join("\n\n")
}

/** Outcome of a structured-comment publication. */
export type StructuredOutcome = { status: "posted" | "updated"; url: string }

export interface PostStructuredInput extends StructuredInput {
  /** When set, upsert: an existing bot comment carrying `cchp-bot:<sticky_key>`
   *  is edited instead of a new comment being posted. */
  sticky_key?: string
}

/** Post (or sticky-upsert) a structured top-level comment on `issueNumber` (a PR
 *  or issue — both use the issues comment endpoint; the caller resolves the target
 *  to a number). Port of the MCP server's `upsertStructured`: with `sticky_key`
 *  it probes for the `cchp-bot:<key>` Marker and edits in place if found, else
 *  posts anew; the Marker is appended (double-`\n`, matching the source) so the
 *  next Run finds it. */
export async function postStructuredComment(
  octokit: GitHubClient,
  repo: string,
  issueNumber: number,
  input: PostStructuredInput,
): Promise<StructuredOutcome> {
  const { owner, name } = splitRepo(repo)
  const body = renderStructured(input)
  let markerKey = ""
  if (input.sticky_key != null) {
    if (!STICKY_KEY_RE.test(input.sticky_key)) throw new Error("invalid sticky_key")
    markerKey = MARKER.sticky(input.sticky_key)
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo: name,
      issue_number: issueNumber,
      per_page: 100,
    })
    // Same sticky probe as `sticky.ts` (types.ts `findByMarker`, the canonical
    // "sticky upsert probe"); the source MCP server used a full-marker `.includes`,
    // identical for well-formed keys.
    const existing = findByMarker(comments, markerKey)
    if (existing) {
      const { data } = await octokit.rest.issues.updateComment({
        owner,
        repo: name,
        comment_id: existing.id,
        body: `${body}\n\n${hidden(markerKey)}`,
      })
      return { status: "updated", url: data.html_url }
    }
  }
  const full = markerKey ? `${body}\n\n${hidden(markerKey)}` : body
  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo: name,
    issue_number: issueNumber,
    body: full,
  })
  return { status: "posted", url: data.html_url }
}

/** Re-render and replace an existing bot comment by id (e.g. acknowledge an
 *  action-menu selection, mark items done) — port of `update_structured_comment`.
 *  Unlike the sticky post path this appends no Marker; it overwrites the body. */
export async function updateStructuredComment(
  octokit: GitHubClient,
  repo: string,
  commentId: number,
  input: StructuredInput,
): Promise<StructuredOutcome> {
  if (!Number.isInteger(commentId) || commentId < 1) throw new Error("comment_id must be a positive integer")
  const { owner, name } = splitRepo(repo)
  const body = renderStructured(input)
  const { data } = await octokit.rest.issues.updateComment({
    owner,
    repo: name,
    comment_id: commentId,
    body,
  })
  return { status: "updated", url: data.html_url }
}
