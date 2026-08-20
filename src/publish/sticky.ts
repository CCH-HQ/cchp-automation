// Sticky Comment publication (DESIGN §7 / glossary "Sticky Comment"): one
// bot-authored comment kept unique per purpose by a hidden `cchp-bot:<key>`
// Marker and upserted (find-by-marker, then edit-or-create) instead of
// duplicated. This Octokit implementation preserves the historical Progress
// Comment contract while the supervisor owns the live todo mirror. The marker
// strings + checklist rendering are the frozen contract and are preserved
// byte-for-byte via the shared `types.ts` helpers.
//
// The primitive is stateless: the plugin's cross-call caches (looked / commentId
// / lastBody dedup, first-plan-is-root gating) are the caller's concern — they
// live in the supervisor, not in this publish operation.
import { splitRepo } from "../context"
import type { GitHubClient } from "../github/client"
import { BRAND_FOOTER_PREFIX, LOGO_HEADING } from "./inline"
import { hidden, MARKER } from "../types"

/** One task-list entry mirrored from the agent's `update_plan` (structural shape;
 *  the real objects carry more fields we ignore). */
export interface Todo {
  content?: unknown
  status?: string
}

/** Strip HTML comments so todo content can never spoof a sticky / fingerprint /
 *  action Marker, collapse whitespace, and clamp length — verbatim port of the
 *  progress plugin's `sanitize`. Loops to a fixed point so nested markers
 *  (`<!<!--x-->-- … -->`) cannot survive a single-pass strip. */
export function sanitizeTodo(text: unknown): string {
  let value = String(text ?? "")
  let previous: string
  do {
    previous = value
    value = value.replace(/<!--[\s\S]*?-->/g, "")
  } while (value !== previous)
  return value.replace(/\s+/g, " ").trim().slice(0, 200)
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
/** Ten-cell unicode progress bar: `▰▰▰▱▱▱▱▱▱▱` for 30%. */
export function progressBar(done: number, total: number): string {
  const filled = total > 0 ? Math.round((Math.min(done, total) / total) * 10) : 0
  return "▰".repeat(filled) + "▱".repeat(10 - filled)
}

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
    `### ${LOGO_HEADING} Live progress — \`${task}\``,
    "",
    `\`${progressBar(done, todos.length)}\` **${done}/${todos.length}**`,
    "",
    ...items,
    "",
    "---",
    `<sub>${BRAND_FOOTER_PREFIX} · Auto-updated from the agent's task list while it works. This comment is informational; findings and replies are posted separately.</sub>`,
  ].join("\n")
}

export interface TerminalProgress {
  state: string
  runId: string
  terminalReason?: string
  consumedTokens?: number
  tokenLimit?: number
  reservedTokens?: number
  responsesInFlight?: number
  codexVersion?: string
  executionMode?: "native_v2" | "explicit_child"
  cleanupOutcome?: string
  finalMessage?: string
}

function sanitizeTerminalMessage(value: unknown): string {
  let text = String(value ?? "")
  let previous: string
  do {
    previous = text
    text = text.replace(/<!--[\s\S]*?-->/g, "")
  } while (text !== previous)
  return text.trim().slice(0, 16_000)
}

function escapeTerminalDetail(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

const TERMINAL_SUMMARY_COLLAPSE_THRESHOLD = 1_200

export function renderTerminalProgress(task: string, terminal: TerminalProgress): string {
  void task
  const reason = sanitizeTodo(terminal.terminalReason)
  const usage = terminal.consumedTokens == null
    ? undefined
    : `${terminal.consumedTokens.toLocaleString("en-US")}${terminal.tokenLimit == null ? "" : ` / ${terminal.tokenLimit.toLocaleString("en-US")}`} tokens`
  const finalMessage = sanitizeTerminalMessage(terminal.finalMessage)
  const mode = terminal.executionMode === "native_v2"
    ? "native-v2"
    : terminal.executionMode === "explicit_child" ? "explicit-exec" : undefined
  if (terminal.state === "SUCCEEDED") {
    const summary = finalMessage || "CCHP Automation 已完成。"
    const summaryBody = summary.length > TERMINAL_SUMMARY_COLLAPSE_THRESHOLD
      ? [
          "<details>",
          "<summary><sub>运行结果摘要</sub></summary>",
          "",
          summary,
          "",
          "</details>",
        ]
      : summary
    return [`### ${LOGO_HEADING} CCHP Automation`, "", summaryBody].flat().join("\n")
  }

  const details = [
    `State: \`${sanitizeTodo(terminal.state) || "UNKNOWN"}\``,
    `Run: \`${sanitizeTodo(terminal.runId) || "unknown"}\``,
    ...(usage ? [`Usage: ${usage}`] : []),
    ...(terminal.reservedTokens == null ? [] : [`Reserved: ${terminal.reservedTokens.toLocaleString("en-US")} tokens`]),
    ...(terminal.responsesInFlight == null ? [] : [`In flight: ${terminal.responsesInFlight.toLocaleString("en-US")} responses`]),
    ...(terminal.codexVersion ? [`Codex: \`${sanitizeTodo(terminal.codexVersion)}\``] : []),
    ...(mode ? [`Mode: \`${mode}\``] : []),
    ...(terminal.cleanupOutcome ? [`Cleanup: \`${sanitizeTodo(terminal.cleanupOutcome)}\``] : []),
    ...(reason ? [`Reason: ${reason}`] : []),
    ...(finalMessage ? [`Response: ${finalMessage}`] : []),
  ].map(escapeTerminalDetail)
  return [
    `### ${LOGO_HEADING} CCHP Automation`,
    "",
    "CCHP Automation 遇到了内部错误。",
    "",
    "<details>",
    "<summary><sub>技术细节</sub></summary>",
    "",
    `<sub>${details.join("<br>\n")}</sub>`,
    "",
    "</details>",
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
export function trustedBotLogin(env: Record<string, string | undefined> = process.env): string | undefined {
  const explicit = env.BOT_GIT_NAME || env.BOT_LOGIN
  if (explicit) return explicit
  return env.BOT_SLUG ? `${env.BOT_SLUG}[bot]` : undefined
}

type StickyComment = { id: number; body?: string | null; user?: { login?: string | null } | null; html_url?: string }

export function upsertSticky(
  octokit: GitHubClient,
  repo: string,
  issueNumber: number,
  markerKey: string,
  body: string,
  signal?: AbortSignal,
  ownerLogin?: string,
): Promise<StickyResult>
export function upsertSticky(
  octokit: GitHubClient,
  repo: string,
  issueNumber: number,
  markerKey: string,
  body: string,
  beforeMutation: () => Promise<boolean>,
  signal?: AbortSignal,
  ownerLogin?: string,
): Promise<StickyResult | undefined>
export async function upsertSticky(
  octokit: GitHubClient,
  repo: string,
  issueNumber: number,
  markerKey: string,
  body: string,
  beforeMutationOrSignal?: (() => Promise<boolean>) | AbortSignal,
  signalOrOwner?: AbortSignal | string,
  ownerLogin?: string,
): Promise<StickyResult | undefined> {
  const beforeMutation = typeof beforeMutationOrSignal === "function" ? beforeMutationOrSignal : undefined
  const requestSignal = typeof beforeMutationOrSignal === "function"
    ? (typeof signalOrOwner === "string" ? undefined : signalOrOwner)
    : (typeof beforeMutationOrSignal === "undefined" ? (typeof signalOrOwner === "string" ? undefined : signalOrOwner) : beforeMutationOrSignal)
  const effectiveOwnerLogin = typeof signalOrOwner === "string" ? signalOrOwner : ownerLogin ?? trustedBotLogin()
  if (!effectiveOwnerLogin) throw new Error("trusted bot login is required for sticky publication")
  const { owner, name } = splitRepo(repo)
  const full = `${body}\n${hidden(markerKey)}`
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo: name,
    issue_number: issueNumber,
    per_page: 100,
    ...(requestSignal ? { request: { signal: requestSignal } } : {}),
  }) as unknown as StickyComment[]
  const marker = hidden(markerKey)
  const owned = comments.filter((comment) =>
    (comment.body ?? "").includes(marker) && comment.user?.login === effectiveOwnerLogin)
  const primary = owned[0]
  const duplicates = owned.slice(1)
  if (beforeMutation && !await beforeMutation()) return undefined
  let result: StickyResult
  if (primary) {
    const { data } = await octokit.rest.issues.updateComment({
      owner,
      repo: name,
      comment_id: primary.id,
      body: full,
      ...(requestSignal ? { request: { signal: requestSignal } } : {}),
    })
    result = { action: "updated", id: data.id, htmlUrl: data.html_url }
  } else {
    const { data } = await octokit.rest.issues.createComment({
      owner,
      repo: name,
      issue_number: issueNumber,
      body: full,
      ...(requestSignal ? { request: { signal: requestSignal } } : {}),
    })
    result = { action: "created", id: data.id, htmlUrl: data.html_url }
  }
  for (const duplicate of duplicates) {
    if (beforeMutation && !await beforeMutation()) {
      throw new Error("sticky publication target changed during duplicate cleanup")
    }
    await octokit.rest.issues.deleteComment({
      owner,
      repo: name,
      comment_id: duplicate.id,
      ...(requestSignal ? { request: { signal: requestSignal } } : {}),
    })
  }
  return result
}
