// Narrowed PR/issue metadata writes, ported from `.github/cchp-bot/review-meta.sh`
// (gh → Octokit, ADR 0003). ONLY the non-merge subcommands are ported here:
// pr-title, pr-comment, pr-comment-file, pr-close, pr-lock, pr-triage-label,
// pr-lgtm-label. `pr-merge` is deliberately NOT ported — auto-merge stays with the
// human owner behind the fork gate (ADR 0004).
//
// The bash script's env/task wrapping stays with the caller: it resolved BOT_REPO
// / BOT_PR_NUMBER from env, read reply.md off disk, applied the fork/task op
// allow-list (fork pr_opened/lgtm_merge/engage can only touch the current PR), and
// gated the review-fingerprint path. Those are routing concerns — classify.ts
// already owns the fork trust boundary. These functions are the Octokit writes
// plus the per-argument input validation the script performed inline.
//
// NOTE: `requireText` preserves the script's shell-metacharacter blocklist. It was
// defence-in-depth for `exec gh … "$arg"`; Octokit sends values as JSON body
// fields (no shell), so the blocklist is now belt-and-suspenders and rejects some
// legitimate text (e.g. a title containing `&`). It is kept for behaviour fidelity
// and can be relaxed deliberately later.
import { splitRepo } from "../context"
import type { GitHubClient } from "../github/client"

// review-meta.sh `require_text` forbidden shell characters.
const FORBIDDEN_SHELL_CHARS = ["<", ">", "|", ";", "&", "$", "`", "\\"]

/** Port of review-meta.sh `require_text`: non-empty, ≤ `max` chars, single line,
 *  and free of shell metacharacters. Throws on violation. */
export function requireText(value: string, max: number, label: string): void {
  if (!value || value.length > max) throw new Error(`invalid ${label} length`)
  if (value.includes("\n") || value.includes("\r")) throw new Error(`${label} must be one line`)
  for (const ch of FORBIDDEN_SHELL_CHARS) {
    if (value.includes(ch)) throw new Error(`${label} contains a forbidden shell character`)
  }
}

/** Port of review-meta.sh `require_number`: a positive integer (`^[1-9][0-9]*$`). */
function requireNumber(n: number): void {
  if (!Number.isInteger(n) || n < 1) throw new Error("invalid number")
}

/** `pr-title`: set the PR title (≤256, one line). `gh pr edit --title` →
 *  `pulls.update`. */
export async function setPrTitle(
  octokit: GitHubClient,
  repo: string,
  prNumber: number,
  title: string,
): Promise<void> {
  requireNumber(prNumber)
  requireText(title, 256, "title")
  const { owner, name } = splitRepo(repo)
  await octokit.rest.pulls.update({ owner, repo: name, pull_number: prNumber, title })
}

/** Result of a comment write. */
export interface CommentResult {
  id: number
  url: string
}

/** `pr-comment`: post a short one-line top-level comment (≤4096). `gh pr comment
 *  --body` → `issues.createComment`. Multi-line bodies go through `commentFile`. */
export async function postComment(
  octokit: GitHubClient,
  repo: string,
  issueNumber: number,
  comment: string,
): Promise<CommentResult> {
  requireNumber(issueNumber)
  requireText(comment, 4096, "comment")
  const { owner, name } = splitRepo(repo)
  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo: name,
    issue_number: issueNumber,
    body: comment,
  })
  return { id: data.id, url: data.html_url }
}

/** `pr-comment-file`: post a multi-line top-level comment from a file body (size
 *  1..65536 bytes; no shell/one-line constraints). `gh pr comment --body-file` →
 *  `issues.createComment`. The caller reads the file (reply.md) and its
 *  symlink/existence guards; this validates size + writes. */
export async function commentFile(
  octokit: GitHubClient,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<CommentResult> {
  requireNumber(issueNumber)
  const size = Buffer.byteLength(body, "utf8")
  if (size < 1 || size > 65536) throw new Error("reply file size must be 1..65536 bytes")
  const { owner, name } = splitRepo(repo)
  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo: name,
    issue_number: issueNumber,
    body,
  })
  return { id: data.id, url: data.html_url }
}

/** `pr-close`: post a closing comment (≤512, one line) then close. Works for a PR
 *  or an issue — both are issues (`gh pr close --comment` → `issues.createComment`
 *  + `issues.update{state:closed}`). */
export async function closePrOrIssue(
  octokit: GitHubClient,
  repo: string,
  number: number,
  reason: string,
): Promise<void> {
  requireNumber(number)
  requireText(reason, 512, "reason")
  const { owner, name } = splitRepo(repo)
  await octokit.rest.issues.createComment({ owner, repo: name, issue_number: number, body: reason })
  await octokit.rest.issues.update({ owner, repo: name, issue_number: number, state: "closed" })
}

// review-meta.sh `pr-lock` reasons. The script's vocabulary is the gh/GraphQL
// LockReason form (underscores); the REST API `lock_reason` uses hyphen/space, so
// map to it while keeping the same accepted input tokens + resulting lock.
const LOCK_REASON_REST: Record<string, "off-topic" | "resolved" | "spam" | "too heated"> = {
  spam: "spam",
  off_topic: "off-topic",
  resolved: "resolved",
  too_heated: "too heated",
}

/** `pr-lock`: lock the conversation with a valid reason
 *  (`spam` | `off_topic` | `resolved` | `too_heated`). `gh issue lock --reason` →
 *  `issues.lock`. */
export async function lock(octokit: GitHubClient, repo: string, number: number, reason: string): Promise<void> {
  requireNumber(number)
  const restReason = LOCK_REASON_REST[reason]
  if (!restReason) throw new Error("invalid lock reason")
  const { owner, name } = splitRepo(repo)
  await octokit.rest.issues.lock({ owner, repo: name, issue_number: number, lock_reason: restReason })
}

// review-meta.sh `pr-triage-label` labels + their fixed colors.
const TRIAGE_COLORS: Record<string, string> = { spam: "b60205", invalid: "e4e669" }

/** Ensure a label exists (create with `color` if missing), then no-op if present —
 *  the script's `gh label view || gh label create --force`. An existing label's
 *  color is left untouched (create only fires when `getLabel` 404s). */
async function ensureLabel(octokit: GitHubClient, repo: string, label: string, color: string): Promise<void> {
  const { owner, name } = splitRepo(repo)
  try {
    await octokit.rest.issues.getLabel({ owner, repo: name, name: label })
    return
  } catch {
    // Missing (404) or lookup failed — create it below.
  }
  await octokit.rest.issues.createLabel({ owner, repo: name, name: label, color })
}

/** `pr-triage-label`: ensure + add a triage label (`spam` | `invalid`, fixed
 *  colors) to the PR. `gh pr edit --add-label` → `issues.addLabels`. */
export async function addTriageLabel(
  octokit: GitHubClient,
  repo: string,
  prNumber: number,
  label: string,
): Promise<void> {
  requireNumber(prNumber)
  const color = TRIAGE_COLORS[label]
  if (!color) throw new Error("invalid triage label")
  await ensureLabel(octokit, repo, label, color)
  const { owner, name } = splitRepo(repo)
  await octokit.rest.issues.addLabels({ owner, repo: name, issue_number: prNumber, labels: [label] })
}

const LGTM_LABEL = "LGTM"
const LGTM_COLOR = "0e8a16"

/** `pr-lgtm-label`: ensure + add the `LGTM` label (color 0e8a16) to the PR. This
 *  is the label-add only — it does NOT merge (that is `pr-merge`, deliberately
 *  unported: the human owner merges behind the fork gate). */
export async function addLgtmLabel(octokit: GitHubClient, repo: string, prNumber: number): Promise<void> {
  requireNumber(prNumber)
  await ensureLabel(octokit, repo, LGTM_LABEL, LGTM_COLOR)
  const { owner, name } = splitRepo(repo)
  await octokit.rest.issues.addLabels({ owner, repo: name, issue_number: prNumber, labels: [LGTM_LABEL] })
}
