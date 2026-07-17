import { expect, test } from "bun:test"
import type { GitHubClient } from "../github/client"
import { hidden, MARKER } from "../types"
import { progressMarkerKey, renderProgress, sanitizeTaskName, sanitizeTodo, upsertSticky, type Todo } from "./sticky"

// A recording fake: listComments (via paginate) returns the seeded thread;
// create/update record their params and echo an id + html_url.
function fake(listComments: { id: number; body?: string | null }[] = []) {
  const calls = {
    createComment: [] as Record<string, unknown>[],
    updateComment: [] as Record<string, unknown>[],
    paginate: [] as { tag: string; params: Record<string, unknown> }[],
  }
  const listRef = Object.assign(() => {}, { __tag: "listComments" })
  const octokit = {
    rest: {
      issues: {
        listComments: listRef,
        createComment: async (p: Record<string, unknown>) => {
          calls.createComment.push(p)
          return { data: { id: 999, html_url: "https://gh/comments/999" } }
        },
        updateComment: async (p: Record<string, unknown>) => {
          calls.updateComment.push(p)
          return { data: { id: p.comment_id, html_url: `https://gh/comments/${p.comment_id}` } }
        },
      },
    },
    paginate: async (fn: { __tag: string }, params: Record<string, unknown>) => {
      calls.paginate.push({ tag: fn.__tag, params })
      return fn.__tag === "listComments" ? listComments : []
    },
  } as unknown as GitHubClient
  return { octokit, calls }
}

// ── upsertSticky: create-vs-edit branch ───────────────────────────────────────
test("upsertSticky: no existing marker → creates a new comment with the marker appended", async () => {
  const { octokit, calls } = fake([])
  const key = MARKER.progress("pr_opened")
  const res = await upsertSticky(octokit, "CCH-HQ/repo", 7, key, "hello world")
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
    { id: 42, body: `stale progress\n${hidden(key)}` },
  ])
  const res = await upsertSticky(octokit, "CCH-HQ/repo", 7, key, "fresh progress")
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
  const res = await upsertSticky(octokit, "CCH-HQ/repo", 7, MARKER.progress("pr_opened"), "body")
  expect(res.action).toBe("created")
  expect(calls.updateComment.length).toBe(0)
  expect(calls.createComment.length).toBe(1)
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
