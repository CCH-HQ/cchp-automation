// Sticky Comment publication (DESIGN §7 / glossary "Sticky Comment"): one
// bot-authored comment kept unique per purpose by a hidden `cchp-bot:<key>`
// Marker and upserted (find-by-marker, then edit-or-create) instead of
// duplicated. Ported from `.github/cchp-bot/opencode/plugin/progress-comment.ts`
// (gh → Octokit, ADR 0003), which upserts the Progress Comment — the live todo
// mirror. The marker strings + checklist rendering are the frozen contract and
// are preserved byte-for-byte via the shared `types.ts` helpers.
//
// The primitive is stateless: the plugin's cross-call caches (looked / commentId
// / lastBody dedup, first-todowrite-is-root gating) are the caller's concern —
// they live in the OpenCode plugin loop, not in this publish operation.
import { splitRepo } from "../context"
import type { GitHubClient } from "../github/client"
import { findByMarker, hidden, MARKER } from "../types"

/** One task-list entry mirrored from the agent's `todowrite` (structural shape;
 *  the real objects carry more fields we ignore). */
export interface Todo {
  content?: unknown
  status?: string
}

/** Strip HTML comments so todo content can never spoof a sticky / fingerprint /
 *  action Marker, collapse whitespace, and clamp length — verbatim port of the
 *  progress plugin's `sanitize`. */
export function sanitizeTodo(text: unknown): string {
  return String(text ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)
}

/** Normalize a raw `BOT_TASK` into the marker/heading slug the progress plugin
 *  uses: `(BOT_TASK || "task")` with every non `[a-z0-9_-]` char removed. The
 *  result feeds BOTH `MARKER.progress(task)` and `renderProgress`'s heading, so
 *  the sticky key and the rendered title always agree. */
export function sanitizeTaskName(raw: string | undefined): string {
  return (raw || "task").replace(/[^a-z0-9_-]/gi, "")
}

/** Render the agent's task list as a GitHub checklist — a faithful port of the
 *  progress plugin's `renderTodos`: first 50 items (checked/cancelled/in-progress
 *  glyphs), a `done/total` progress line counting the FULL list, and the fixed
 *  informational footer. Deterministic + pure, so it is unit-tested directly. */
export function renderProgress(todos: readonly Todo[], task: string): string {
  const items = todos.slice(0, 50).map((t) => {
    const content = sanitizeTodo(t?.content) || "(untitled)"
    if (t?.status === "completed") return `- [x] ${content}`
    if (t?.status === "cancelled") return `- [x] ~~${content}~~ (cancelled)`
    if (t?.status === "in_progress") return `- [ ] **${content}** ⏳`
    return `- [ ] ${content}`
  })
  const done = todos.filter((t) => t?.status === "completed").length
  return [
    `### 🤖 Live progress — \`${task}\``,
    "",
    `> ${done}/${todos.length} steps completed`,
    "",
    ...items,
    "",
    "---",
    "<sub>Auto-updated from the agent's task list while it works. This comment is informational; findings and replies are posted separately.</sub>",
  ].join("\n")
}

/** The frozen marker key for a Progress Comment on a given task
 *  (`cchp-bot:progress:<slug>`); the caller passes this to `upsertSticky`. */
export const progressMarkerKey = (task: string): string => MARKER.progress(sanitizeTaskName(task))

/** Whether the sticky comment was edited in place or freshly created. */
export interface StickyResult {
  action: "created" | "updated"
  id: number
  htmlUrl: string
}

/** Upsert one bot-authored Sticky Comment on `issueNumber` (an issue OR a PR —
 *  both use the issues comment endpoint). Appends the hidden `markerKey` Marker
 *  to `body`, then probes the existing comment thread for that Marker
 *  (`paginate(issues.listComments)` + `findByMarker`): edits it if found, else
 *  creates a new one. `markerKey` is the bare key (e.g. `MARKER.progress(task)`
 *  or `MARKER.sticky("cifix")`); `hidden()` wraps it into `<!-- key -->` so the
 *  next Run finds it. Single-`\n` separator, matching the progress plugin. */
export async function upsertSticky(
  octokit: GitHubClient,
  repo: string,
  issueNumber: number,
  markerKey: string,
  body: string,
): Promise<StickyResult> {
  const { owner, name } = splitRepo(repo)
  const full = `${body}\n${hidden(markerKey)}`
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo: name,
    issue_number: issueNumber,
    per_page: 100,
  })
  const existing = findByMarker(comments, markerKey)
  if (existing) {
    const { data } = await octokit.rest.issues.updateComment({
      owner,
      repo: name,
      comment_id: existing.id,
      body: full,
    })
    return { action: "updated", id: data.id, htmlUrl: data.html_url }
  }
  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo: name,
    issue_number: issueNumber,
    body: full,
  })
  return { action: "created", id: data.id, htmlUrl: data.html_url }
}
