import { expect, test } from "bun:test"
import type { GitHubClient } from "../github/client"
import {
  createInlineComment,
  parsePatch,
  postReviewBatch,
  postStructuredComment,
  renderStructured,
  reviewHistory,
  sanitizeText,
  stripFingerprintMarkers,
  updateStructuredComment,
  validateAnchor,
  type HistoryEntry,
  type InlineComment,
  type PatchIndex,
} from "./inline"

const FP = (c: string) => c.repeat(64) // a valid 64-char lowercase-hex fingerprint
const FP_A = FP("a")
const FP_B = FP("b")
const FP_C = FP("c")

// A single-hunk patch: RIGHT lines 1..4 and LEFT lines 1..3 are commentable.
const PATCH = [
  "diff --git a/foo.ts b/foo.ts",
  "--- a/foo.ts",
  "+++ b/foo.ts",
  "@@ -1,3 +1,4 @@",
  " line1",
  "-line2old",
  "+line2new",
  "+line3new",
  " line4",
  "",
].join("\n")

function fake(
  seed: { reviewComments?: unknown[]; issueComments?: unknown[]; reviews?: unknown[] } = {},
) {
  const calls = {
    createReviewComment: [] as Record<string, unknown>[],
    createReview: [] as Record<string, unknown>[],
    createComment: [] as Record<string, unknown>[],
    updateComment: [] as Record<string, unknown>[],
    paginate: [] as { tag: string; params: Record<string, unknown> }[],
  }
  const ref = (tag: string) => Object.assign(() => {}, { __tag: tag })
  const octokit = {
    rest: {
      pulls: {
        listReviewComments: ref("reviewComments"),
        listReviews: ref("reviews"),
        createReviewComment: async (p: Record<string, unknown>) => {
          calls.createReviewComment.push(p)
          return { data: { html_url: "https://gh/prc/1" } }
        },
        createReview: async (p: Record<string, unknown>) => {
          calls.createReview.push(p)
          return { data: { html_url: "https://gh/review/1" } }
        },
      },
      issues: {
        listComments: ref("issueComments"),
        createComment: async (p: Record<string, unknown>) => {
          calls.createComment.push(p)
          return { data: { id: 500, html_url: "https://gh/ic/500" } }
        },
        updateComment: async (p: Record<string, unknown>) => {
          calls.updateComment.push(p)
          return { data: { id: p.comment_id, html_url: "https://gh/ic/upd" } }
        },
      },
    },
    paginate: async (fn: { __tag: string }, params: Record<string, unknown>) => {
      calls.paginate.push({ tag: fn.__tag, params })
      const m: Record<string, unknown[]> = {
        reviewComments: (seed.reviewComments as unknown[]) ?? [],
        issueComments: (seed.issueComments as unknown[]) ?? [],
        reviews: (seed.reviews as unknown[]) ?? [],
      }
      return m[fn.__tag] ?? []
    },
  } as unknown as GitHubClient
  return { octokit, calls }
}

// ── parsePatch ────────────────────────────────────────────────────────────────
test("parsePatch: maps commentable lines per side with hunk tags", () => {
  const files = parsePatch(PATCH)
  const foo = files.get("foo.ts")!
  expect([...foo.RIGHT.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
  expect([...foo.LEFT.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3])
  expect(foo.RIGHT.get(2)).toBe(1) // added line, hunk 1
})

// ── validateAnchor (patch-anchor validation — frozen invariant) ────────────────
function twoHunk(): PatchIndex {
  // RIGHT 1,2 in hunk 1; RIGHT 10 in hunk 2. LEFT 1,2 in hunk 1.
  return new Map([
    [
      "foo.ts",
      {
        LEFT: new Map([
          [1, 1],
          [2, 1],
        ]),
        RIGHT: new Map([
          [1, 1],
          [2, 1],
          [3, 1],
          [10, 2],
        ]),
      },
    ],
  ])
}

test("validateAnchor: defaults to RIGHT and accepts a commentable line", () => {
  expect(validateAnchor({ path: "foo.ts", line: 2 }, twoHunk())).toBe("RIGHT")
  expect(validateAnchor({ path: "foo.ts", line: 2, side: "LEFT" }, twoHunk())).toBe("LEFT")
})

test("validateAnchor: rejects non-repo-relative paths", () => {
  expect(() => validateAnchor({ path: "/etc/passwd", line: 1 }, twoHunk())).toThrow("repository-relative")
  expect(() => validateAnchor({ path: "a/../b", line: 1 }, twoHunk())).toThrow("repository-relative")
})

test("validateAnchor: rejects non-positive / non-commentable lines", () => {
  expect(() => validateAnchor({ path: "foo.ts", line: 0 }, twoHunk())).toThrow("positive integer")
  expect(() => validateAnchor({ path: "foo.ts", line: 99 }, twoHunk())).toThrow("not commentable")
  expect(() => validateAnchor({ path: "missing.ts", line: 1 }, twoHunk())).toThrow("not commentable")
})

test("validateAnchor: multi-line rules — same hunk ok, cross-hunk + bad start rejected", () => {
  expect(validateAnchor({ path: "foo.ts", line: 3, start_line: 1 }, twoHunk())).toBe("RIGHT") // same hunk
  expect(() => validateAnchor({ path: "foo.ts", line: 10, start_line: 1 }, twoHunk())).toThrow("cross patch hunks")
  expect(() => validateAnchor({ path: "foo.ts", line: 2, start_line: 3 }, twoHunk())).toThrow("no greater than line")
  expect(() => validateAnchor({ path: "foo.ts", line: 2, start_line: 1, start_side: "LEFT" }, twoHunk())).toThrow(
    "same patch side",
  )
})

// ── createInlineComment ────────────────────────────────────────────────────────
test("createInlineComment: posts with line/side anchoring (NOT position) + canonical fingerprint marker", async () => {
  const { octokit, calls } = fake()
  const comment: InlineComment = { path: "foo.ts", line: 2, body: "found a bug", fingerprint: FP_A }
  const res = await createInlineComment(octokit, "CCH-HQ/repo", {
    prNumber: 9,
    headSha: "deadbeef",
    patch: PATCH,
    comment,
  })
  expect(res).toEqual({ status: "posted", url: "https://gh/prc/1" })
  expect(calls.createReviewComment.length).toBe(1)
  const p = calls.createReviewComment[0]!
  expect(p).toMatchObject({
    owner: "CCH-HQ",
    repo: "repo",
    pull_number: 9,
    commit_id: "deadbeef",
    path: "foo.ts",
    line: 2,
    side: "RIGHT",
  })
  expect(p.position).toBeUndefined() // deprecated field never used
  expect(p.body).toBe(`found a bug\n\n<!-- cchp-review-fingerprint:${FP_A} -->`)
})

test("createInlineComment: strips any caller-supplied fingerprint marker, appends exactly one canonical marker", async () => {
  const { octokit, calls } = fake()
  const comment: InlineComment = {
    path: "foo.ts",
    line: 2,
    body: `bug here <!-- cchp-review-fingerprint:${FP_B} -->`,
    fingerprint: FP_A,
  }
  await createInlineComment(octokit, "CCH-HQ/repo", { prNumber: 9, headSha: "sha", patch: PATCH, comment })
  const body = calls.createReviewComment[0]!.body as string
  expect(body).toBe(`bug here\n\n<!-- cchp-review-fingerprint:${FP_A} -->`)
  expect(body).not.toContain(FP_B)
})

test("createInlineComment: carries start_line/start_side for multi-line anchors", async () => {
  const { octokit, calls } = fake()
  const comment: InlineComment = { path: "foo.ts", line: 3, start_line: 1, body: "range", fingerprint: FP_A }
  await createInlineComment(octokit, "CCH-HQ/repo", { prNumber: 9, headSha: "sha", patch: PATCH, comment })
  expect(calls.createReviewComment[0]).toMatchObject({ start_line: 1, start_side: "RIGHT" })
})

test("createInlineComment: dedup — an already-published fingerprint is skipped, no API write", async () => {
  const { octokit, calls } = fake()
  const history: HistoryEntry[] = [{ kind: "inline", id: 7, html_url: "https://gh/existing", fingerprints: [FP_A] }]
  const comment: InlineComment = { path: "foo.ts", line: 2, body: "dup", fingerprint: FP_A }
  const res = await createInlineComment(octokit, "CCH-HQ/repo", {
    prNumber: 9,
    headSha: "sha",
    patch: PATCH,
    comment,
    history,
  })
  expect(res).toEqual({ status: "already-posted", ref: "https://gh/existing" })
  expect(calls.createReviewComment.length).toBe(0)
})

test("createInlineComment: dedup ref falls back to the comment id when no html_url", async () => {
  const { octokit } = fake()
  const history: HistoryEntry[] = [{ kind: "inline", id: 7, fingerprints: [FP_A] }]
  const res = await createInlineComment(octokit, "CCH-HQ/repo", {
    prNumber: 9,
    headSha: "sha",
    patch: PATCH,
    comment: { path: "foo.ts", line: 2, body: "dup", fingerprint: FP_A },
    history,
  })
  expect(res).toEqual({ status: "already-posted", ref: "7" })
})

test("createInlineComment: fetches history itself when not provided (empty thread → posts)", async () => {
  const { octokit, calls } = fake() // all list endpoints empty
  await createInlineComment(octokit, "CCH-HQ/repo", {
    prNumber: 9,
    headSha: "sha",
    patch: PATCH,
    comment: { path: "foo.ts", line: 2, body: "x", fingerprint: FP_A },
  })
  expect(calls.paginate.map((c) => c.tag).sort()).toEqual(["issueComments", "reviewComments", "reviews"])
  expect(calls.createReviewComment.length).toBe(1)
})

test("createInlineComment: rejects a bad fingerprint / empty body / uncommentable line", async () => {
  const { octokit } = fake()
  const base = { prNumber: 9, headSha: "sha", patch: PATCH }
  await expect(
    createInlineComment(octokit, "CCH-HQ/repo", { ...base, comment: { path: "foo.ts", line: 2, body: "x", fingerprint: "nope" } }),
  ).rejects.toThrow("lowercase SHA-256")
  await expect(
    createInlineComment(octokit, "CCH-HQ/repo", { ...base, comment: { path: "foo.ts", line: 2, body: "   ", fingerprint: FP_A } }),
  ).rejects.toThrow("body is required")
  await expect(
    createInlineComment(octokit, "CCH-HQ/repo", { ...base, comment: { path: "foo.ts", line: 99, body: "x", fingerprint: FP_A } }),
  ).rejects.toThrow("not commentable")
})

// ── postReviewBatch ────────────────────────────────────────────────────────────
test("postReviewBatch: posts ONE review with all new findings + a summary", async () => {
  const { octokit, calls } = fake()
  const res = await postReviewBatch(octokit, "CCH-HQ/repo", {
    prNumber: 9,
    headSha: "sha",
    patch: PATCH,
    summary: "2 issues",
    comments: [
      { path: "foo.ts", line: 2, body: "one", fingerprint: FP_A },
      { path: "foo.ts", line: 3, body: "two", fingerprint: FP_B },
    ],
  })
  expect(res).toEqual({ status: "posted", url: "https://gh/review/1", posted: 2, skipped: 0 })
  expect(calls.createReview.length).toBe(1)
  const rev = calls.createReview[0]!
  expect(rev).toMatchObject({ pull_number: 9, commit_id: "sha", event: "COMMENT", body: "2 issues" })
  const comments = rev.comments as Record<string, unknown>[]
  expect(comments.length).toBe(2)
  expect(comments[0]).toMatchObject({ path: "foo.ts", line: 2, side: "RIGHT" })
  expect(comments[0]!.position).toBeUndefined()
  expect(comments[0]!.body).toBe(`one\n\n<!-- cchp-review-fingerprint:${FP_A} -->`)
})

test("postReviewBatch: dedups against history AND within the batch, reports skipped count", async () => {
  const { octokit, calls } = fake()
  const history: HistoryEntry[] = [{ kind: "top_level", fingerprints: [FP_C] }]
  const res = await postReviewBatch(octokit, "CCH-HQ/repo", {
    prNumber: 9,
    headSha: "sha",
    patch: PATCH,
    history,
    comments: [
      { path: "foo.ts", line: 2, body: "keep", fingerprint: FP_A },
      { path: "foo.ts", line: 2, body: "batch dup", fingerprint: FP_A }, // local dup
      { path: "foo.ts", line: 3, body: "history dup", fingerprint: FP_C }, // seen in history
    ],
  })
  expect(res).toEqual({ status: "posted", url: "https://gh/review/1", posted: 1, skipped: 2 })
  expect((calls.createReview[0]!.comments as unknown[]).length).toBe(1)
})

test("postReviewBatch: all fingerprints already posted → already-posted, no review created", async () => {
  const { octokit, calls } = fake()
  const history: HistoryEntry[] = [{ kind: "inline", fingerprints: [FP_A, FP_B] }]
  const res = await postReviewBatch(octokit, "CCH-HQ/repo", {
    prNumber: 9,
    headSha: "sha",
    patch: PATCH,
    history,
    comments: [
      { path: "foo.ts", line: 2, body: "a", fingerprint: FP_A },
      { path: "foo.ts", line: 3, body: "b", fingerprint: FP_B },
    ],
  })
  expect(res).toEqual({ status: "already-posted", total: 2 })
  expect(calls.createReview.length).toBe(0)
})

test("postReviewBatch: omitted summary → review posted without a body", async () => {
  const { octokit, calls } = fake()
  await postReviewBatch(octokit, "CCH-HQ/repo", {
    prNumber: 9,
    headSha: "sha",
    patch: PATCH,
    comments: [{ path: "foo.ts", line: 2, body: "x", fingerprint: FP_A }],
  })
  expect(calls.createReview[0]!.body).toBeUndefined()
})

test("postReviewBatch: rejects empty and oversized batches", async () => {
  const { octokit } = fake()
  await expect(
    postReviewBatch(octokit, "CCH-HQ/repo", { prNumber: 9, headSha: "s", patch: PATCH, comments: [] }),
  ).rejects.toThrow("non-empty array")
  const many: InlineComment[] = Array.from({ length: 51 }, () => ({ path: "foo.ts", line: 2, body: "x", fingerprint: FP_A }))
  await expect(
    postReviewBatch(octokit, "CCH-HQ/repo", { prNumber: 9, headSha: "s", patch: PATCH, comments: many }),
  ).rejects.toThrow("at most 50")
})

// ── reviewHistory ──────────────────────────────────────────────────────────────
test("reviewHistory: simplifies inline + top-level + reviews and extracts fingerprints", async () => {
  const { octokit, calls } = fake({
    reviewComments: [
      { id: 1, path: "a.ts", line: 4, side: "RIGHT", body: `nit <!-- cchp-review-fingerprint:${FP_A} -->`, html_url: "u1", user: { login: "bot" } },
    ],
    issueComments: [{ id: 2, body: `summary <!-- cchp-review-fingerprint:${FP_B} -->`, html_url: "u2" }],
    reviews: [{ id: 3, body: "just a review", html_url: "u3" }],
  })
  const hist = await reviewHistory(octokit, "CCH-HQ/repo", 9)
  expect(hist.map((h) => h.kind)).toEqual(["inline", "top_level", "review"])
  expect(hist[0]).toMatchObject({ kind: "inline", path: "a.ts", line: 4, side: "RIGHT", user: "bot", fingerprints: [FP_A] })
  expect(hist[1]!.fingerprints).toEqual([FP_B])
  expect(hist[2]!.fingerprints).toEqual([])
  expect(calls.paginate.find((c) => c.tag === "reviewComments")!.params).toMatchObject({ pull_number: 9 })
  expect(calls.paginate.find((c) => c.tag === "issueComments")!.params).toMatchObject({ issue_number: 9 })
})

// ── renderStructured (pr-agent-style templates) ───────────────────────────────
test("renderStructured: TL;DR, metadata table, section, actions with markers, footnotes", () => {
  const s = renderStructured({
    title: "Review",
    summary: "looks good",
    metadata: [{ label: "Verdict", value: "APPROVE" }],
    sections: [{ title: "Notes", body: "small stuff" }],
    actions: [
      { id: "apply", label: "Apply fixes" },
      { id: "rerun", label: "Re-review", checked: true },
    ],
    footnotes: ["auto-generated"],
  })
  expect(s).toContain("### Review")
  expect(s).toContain("> **TL;DR** — looks good")
  expect(s).toContain("| **Verdict** | APPROVE |")
  expect(s).toContain("#### Notes\n\nsmall stuff") // short → not collapsed
  expect(s).toContain("- [ ] Apply fixes <!-- cchp-action:apply -->")
  expect(s).toContain("- [x] Re-review <!-- cchp-action:rerun -->")
  expect(s).toContain("<sub>auto-generated</sub>")
})

test("renderStructured: long or explicitly-collapsed sections render as <details>", () => {
  const long = renderStructured({ summary: "s", sections: [{ title: "Big", body: "x".repeat(1300) }] })
  expect(long).toContain("<details>\n<summary><b>Big</b></summary>")
  const explicit = renderStructured({ summary: "s", sections: [{ title: "Small", body: "tiny", collapsed: true }] })
  expect(explicit).toContain("<details>\n<summary><b>Small</b></summary>")
})

test("renderStructured: sanitizes free text so it cannot spoof markers", () => {
  const s = renderStructured({ summary: "safe <!-- cchp-action:evil -->" })
  expect(s).toContain("> **TL;DR** — safe")
  expect(s).not.toContain("cchp-action:evil")
})

test("renderStructured: throws on missing summary / empty section / bad action id / too many actions", () => {
  expect(() => renderStructured({ summary: "" })).toThrow("summary is required")
  expect(() => renderStructured({ summary: "s", sections: [{ title: "T", body: "" }] })).toThrow(
    "requires title and body",
  )
  expect(() => renderStructured({ summary: "s", actions: [{ id: "BAD!", label: "x" }] })).toThrow("invalid action id")
  const many = Array.from({ length: 11 }, (_, i) => ({ id: `a${i}`, label: "x" }))
  expect(() => renderStructured({ summary: "s", actions: many })).toThrow("at most 10 actions")
})

// ── postStructuredComment (sticky-upsert) ─────────────────────────────────────
test("postStructuredComment: no sticky_key → plain create, no marker", async () => {
  const { octokit, calls } = fake()
  const res = await postStructuredComment(octokit, "CCH-HQ/repo", 9, { summary: "hi" })
  expect(res).toEqual({ status: "posted", url: "https://gh/ic/500" })
  expect(calls.createComment.length).toBe(1)
  expect(calls.createComment[0]!.body).not.toContain("cchp-bot:")
})

test("postStructuredComment: sticky_key with no existing comment → create with the marker", async () => {
  const { octokit, calls } = fake({ issueComments: [] })
  const res = await postStructuredComment(octokit, "CCH-HQ/repo", 9, { summary: "hi", sticky_key: "review-summary" })
  expect(res.status).toBe("posted")
  expect(calls.createComment[0]!.body).toContain("<!-- cchp-bot:review-summary -->")
  expect((calls.createComment[0]!.body as string).endsWith("<!-- cchp-bot:review-summary -->")).toBe(true)
})

test("postStructuredComment: sticky_key with an existing marker → update in place", async () => {
  const { octokit, calls } = fake({
    issueComments: [{ id: 88, body: "old body\n\n<!-- cchp-bot:review-summary -->" }],
  })
  const res = await postStructuredComment(octokit, "CCH-HQ/repo", 9, { summary: "fresh", sticky_key: "review-summary" })
  expect(res).toEqual({ status: "updated", url: "https://gh/ic/upd" })
  expect(calls.createComment.length).toBe(0)
  expect(calls.updateComment[0]).toMatchObject({ comment_id: 88 })
  expect(calls.updateComment[0]!.body).toContain("<!-- cchp-bot:review-summary -->")
})

test("postStructuredComment: rejects an invalid sticky_key", async () => {
  const { octokit } = fake()
  await expect(
    postStructuredComment(octokit, "CCH-HQ/repo", 9, { summary: "hi", sticky_key: "BAD KEY" }),
  ).rejects.toThrow("invalid sticky_key")
})

// ── updateStructuredComment ────────────────────────────────────────────────────
test("updateStructuredComment: re-renders and PATCHes by id, appends no marker", async () => {
  const { octokit, calls } = fake()
  const res = await updateStructuredComment(octokit, "CCH-HQ/repo", 42, { summary: "done" })
  expect(res).toEqual({ status: "updated", url: "https://gh/ic/upd" })
  expect(calls.updateComment[0]).toMatchObject({ comment_id: 42 })
  expect(calls.updateComment[0]!.body).toContain("> **TL;DR** — done")
  expect(calls.updateComment[0]!.body).not.toContain("cchp-bot:")
})

test("updateStructuredComment: rejects a non-positive comment id", async () => {
  const { octokit } = fake()
  await expect(updateStructuredComment(octokit, "CCH-HQ/repo", 0, { summary: "x" })).rejects.toThrow(
    "positive integer",
  )
})

// ── sanitizeText / stripFingerprintMarkers (defence helpers) ──────────────────
test("sanitizeText + stripFingerprintMarkers strip embedded markers", () => {
  expect(sanitizeText("a <!-- x --> b")).toBe("a  b")
  expect(sanitizeText(null)).toBe("")
  expect(stripFingerprintMarkers(`x <!-- cchp-review-fingerprint:${FP_A} --> y`)).toBe("x  y")
})
