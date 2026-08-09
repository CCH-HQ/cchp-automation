import { expect, test } from "bun:test"
import type { GitHubClient } from "../github/client"
import { hidden, MARKER } from "../types"
import { progressMarkerKey, renderProgress, renderTerminalProgress, sanitizeTaskName, sanitizeTodo, upsertSticky, type Todo } from "./sticky"

// A recording fake: listComments (via paginate) returns the seeded thread;
// create/update record their params and echo an id + html_url.
function fake(listComments: { id: number; body?: string | null; user?: { login?: string } }[] = []) {
  const calls = {
    createComment: [] as Record<string, unknown>[],
    updateComment: [] as Record<string, unknown>[],
    deleteComment: [] as Record<string, unknown>[],
    paginate: [] as { tag: string; params: Record<string, unknown> }[],
  }
  const listRef = Object.assign(() => {}, { __tag: "listComments" })
  const octokit = {
    rest: {
      issues: {
        listComments: listRef,
        createComment: async (p: Record<string, unknown>) => {
          calls.createComment.push(p)
          listComments.push({ id: 999, body: String(p.body ?? ""), user: { login: "cchp[bot]" } })
          return { data: { id: 999, html_url: "https://gh/comments/999" } }
        },
        updateComment: async (p: Record<string, unknown>) => {
          calls.updateComment.push(p)
          const existing = listComments.find((comment) => comment.id === p.comment_id)
          if (existing) existing.body = String(p.body ?? "")
          return { data: { id: p.comment_id, html_url: `https://gh/comments/${p.comment_id}` } }
        },
        deleteComment: async (p: Record<string, unknown>) => {
          calls.deleteComment.push(p)
          const index = listComments.findIndex((comment) => comment.id === p.comment_id)
          if (index >= 0) listComments.splice(index, 1)
          return { data: {} }
        },
      },
    },
    paginate: async (fn: { __tag: string }, params: Record<string, unknown>) => {
      calls.paginate.push({ tag: fn.__tag, params })
      return fn.__tag === "listComments" ? listComments : []
    },
  } as unknown as GitHubClient
  return { octokit, calls, comments: listComments }
}

// ── upsertSticky: create-vs-edit branch ───────────────────────────────────────
test("upsertSticky: no existing marker → creates a new comment with the marker appended", async () => {
  const { octokit, calls } = fake([])
  const key = MARKER.progress("pr_opened")
  const res = await upsertSticky(octokit, "CCH-HQ/repo", 7, key, "hello world", undefined, "cchp[bot]")
  expect(res).toEqual({ action: "created", id: 999, htmlUrl: "https://gh/comments/999" })
  expect(calls.updateComment.length).toBe(0)
  expect(calls.createComment.length).toBe(1)
  expect(calls.createComment[0]).toMatchObject({
    owner: "CCH-HQ",
    repo: "repo",
    issue_number: 7,
    body: `hello world\n${hidden(key)}`,
  })
  // Marker string is exactly the frozen namespace value.
  expect(calls.createComment[0]!.body).toContain("<!-- cchp-bot:progress:pr_opened -->")
  // paginate probed the right thread.
  expect(calls.paginate[0]).toMatchObject({ tag: "listComments", params: { issue_number: 7 } })
})

test("upsertSticky: existing marker → edits that comment in place, no new comment", async () => {
  const key = MARKER.progress("pr_opened")
  const { octokit, calls } = fake([
    { id: 1, body: "unrelated" },
    { id: 42, body: `stale progress\n${hidden(key)}`, user: { login: "cchp[bot]" } },
  ])
  const res = await upsertSticky(octokit, "CCH-HQ/repo", 7, key, "fresh progress", undefined, "cchp[bot]")
  expect(res).toEqual({ action: "updated", id: 42, htmlUrl: "https://gh/comments/42" })
  expect(calls.createComment.length).toBe(0)
  expect(calls.updateComment.length).toBe(1)
  expect(calls.updateComment[0]).toMatchObject({
    comment_id: 42,
    body: `fresh progress\n${hidden(key)}`,
  })
})

test("upsertSticky: a different marker in the thread is NOT matched (create, not edit)", async () => {
  const { octokit, calls } = fake([{ id: 5, body: `other\n${hidden(MARKER.progress("ci_fix"))}` }])
  const res = await upsertSticky(octokit, "CCH-HQ/repo", 7, MARKER.progress("pr_opened"), "body", undefined, "cchp[bot]")
  expect(res.action).toBe("created")
  expect(calls.updateComment.length).toBe(0)
  expect(calls.createComment.length).toBe(1)
})

test("upsertSticky: foreign marker owner is never edited", async () => {
  const key = MARKER.progress("pr_opened")
  const { octokit, calls } = fake([{ id: 9, body: `old\n${hidden(key)}`, user: { login: "attacker" } }])
  const result = await upsertSticky(octokit, "CCH-HQ/repo", 7, key, "fresh", undefined, "cchp[bot]")
  expect(result?.action).toBe("created")
  expect(calls.updateComment).toHaveLength(0)
  expect(calls.createComment).toHaveLength(1)
})

test("upsertSticky: a foreign marker cannot shadow a later bot-owned sticky", async () => {
  const key = MARKER.progress("pr_opened")
  const { octokit, calls, comments } = fake([
    { id: 1, body: `forged\n${hidden(key)}`, user: { login: "attacker" } },
    { id: 2, body: `old\n${hidden(key)}`, user: { login: "cchp[bot]" } },
  ])
  expect(await upsertSticky(octokit, "CCH-HQ/repo", 7, key, "fresh", undefined, "cchp[bot]"))
    .toEqual({ action: "updated", id: 2, htmlUrl: "https://gh/comments/2" })
  expect(calls.createComment).toHaveLength(0)
  expect(calls.updateComment.map((call) => call.comment_id)).toEqual([2])
  expect(calls.deleteComment).toHaveLength(0)
  expect(comments.find((comment) => comment.id === 1)?.body).toBe(`forged\n${hidden(key)}`)
})

test("upsertSticky: bot-owned duplicates converge without touching foreign markers", async () => {
  const key = MARKER.progress("pr_opened")
  const { octokit, calls, comments } = fake([
    { id: 1, body: `forged-one\n${hidden(key)}`, user: { login: "attacker" } },
    { id: 10, body: `old-one\n${hidden(key)}`, user: { login: "cchp[bot]" } },
    { id: 2, body: `forged-two\n${hidden(key)}`, user: { login: "attacker" } },
    { id: 11, body: `old-two\n${hidden(key)}`, user: { login: "cchp[bot]" } },
  ])
  expect(await upsertSticky(octokit, "CCH-HQ/repo", 7, key, "latest", undefined, "cchp[bot]"))
    .toEqual({ action: "updated", id: 10, htmlUrl: "https://gh/comments/10" })
  expect(calls.updateComment.map((call) => call.comment_id)).toEqual([10])
  expect(calls.deleteComment.map((call) => call.comment_id)).toEqual([11])
  expect(comments.map((comment) => comment.id)).toEqual([1, 10, 2])
  expect(comments.find((comment) => comment.id === 1)?.body).toContain("forged-one")
  expect(comments.find((comment) => comment.id === 2)?.body).toContain("forged-two")
})

test("upsertSticky: missing trusted owner fails before any GitHub request", async () => {
  const { octokit, calls } = fake()
  await expect(upsertSticky(octokit, "CCH-HQ/repo", 7, MARKER.progress("pr_opened"), "body", undefined, ""))
    .rejects.toThrow("trusted bot login is required")
  expect(calls.paginate).toHaveLength(0)
  expect(calls.createComment).toHaveLength(0)
  expect(calls.updateComment).toHaveLength(0)
  expect(calls.deleteComment).toHaveLength(0)
})

// ── renderProgress (Progress Comment renderer — faithful port) ─────────────────
test("renderProgress: renders the checklist with status glyphs + a done/total header", () => {
  const todos: Todo[] = [
    { content: "step one", status: "completed" },
    { content: "step two", status: "in_progress" },
    { content: "step three", status: "pending" },
    { content: "abandoned", status: "cancelled" },
  ]
  const s = renderProgress(todos, "pr_opened")
  expect(s).toContain("Live progress — `pr_opened`")
  expect(s).toContain("cchp-logo.svg") // branded heading
  expect(s).toContain("`▰▰▰▱▱▱▱▱▱▱` **1/4**") // 10-cell bar, full-list total
  expect(s).toContain("- [x] step one")
  expect(s).toContain("- [ ] **step two** ⏳")
  expect(s).toContain("- [ ] step three")
  expect(s).toContain("- [x] ~~abandoned~~ (cancelled)")
  expect(s).toContain("Auto-updated from the agent's task list")
})

test("renderProgress: empty content falls back to (untitled)", () => {
  expect(renderProgress([{ content: "", status: "pending" }], "t")).toContain("- [ ] (untitled)")
})

test("renderProgress: caps items at 50 but counts the full total in the header", () => {
  const todos: Todo[] = Array.from({ length: 60 }, (_, i) => ({ content: `item-${i}`, status: "pending" }))
  const s = renderProgress(todos, "big")
  expect(s).toContain("`▱▱▱▱▱▱▱▱▱▱` **0/60**")
  expect(s).toContain("- [ ] item-49") // 50th (index 49) rendered
  expect(s).not.toContain("item-50") // 51st (index 50) dropped
})

test("renderTerminalProgress: renders the supervisor state, reason and usage", () => {
  const body = renderTerminalProgress("ci_fix", {
    state: "TOKEN_BUDGET_EXCEEDED",
    runId: "31183142455",
    terminalReason: "token budget exceeded <!-- cchp-bot:spoof -->",
    consumedTokens: 2_053_049,
    tokenLimit: 2_000_000,
    reservedTokens: 0,
    responsesInFlight: 0,
    codexVersion: "0.146.0",
    executionMode: "native_v2",
    cleanupOutcome: "success",
    finalMessage: "Inspection complete. <!-- cchp-bot:spoof -->",
  })
  expect(body).toContain("Run complete — `ci_fix`")
  expect(body).toContain("`TOKEN_BUDGET_EXCEEDED`")
  expect(body).toContain("`31183142455`")
  expect(body).toContain("2,053,049 / 2,000,000 tokens")
  expect(body).toContain("**Reserved:** 0 tokens")
  expect(body).toContain("**In flight:** 0 responses")
  expect(body).toContain("**Codex:** `0.146.0`")
  expect(body).toContain("**Mode:** `native-v2`")
  expect(body).toContain("**Cleanup:** `success`")
  expect(body).toContain("Inspection complete.")
  expect(body).toContain("token budget exceeded")
  expect(body).not.toContain("cchp-bot:spoof")
})

// ── sanitizeTodo (marker-spoof defence) ────────────────────────────────────────
test("sanitizeTodo: strips HTML comments, collapses whitespace, clamps to 200", () => {
  expect(sanitizeTodo("foo <!-- cchp-action:evil --> bar")).toBe("foo bar")
  expect(sanitizeTodo("foo <!<!--x-->-- cchp-action:nested-spoof --> bar")).toBe("foo bar")
  expect(sanitizeTodo("a\n\n b\tc")).toBe("a b c")
  expect(sanitizeTodo("x".repeat(250)).length).toBe(200)
  expect(sanitizeTodo(null)).toBe("")
})

// ── task-name normalization + marker key ───────────────────────────────────────
test("sanitizeTaskName + progressMarkerKey: slugify the task and build the frozen key", () => {
  expect(sanitizeTaskName(undefined)).toBe("task")
  expect(sanitizeTaskName("pr opened!")).toBe("propened")
  expect(sanitizeTaskName("ci_fix")).toBe("ci_fix")
  expect(progressMarkerKey("pr opened!")).toBe("cchp-bot:progress:propened")
  expect(progressMarkerKey("ci_fix")).toBe(MARKER.progress("ci_fix"))
})
