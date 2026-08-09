import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GitHubClient } from "../github/client"
import type { ReviewPublicationBundle } from "../mcp/server"
import type { FinalizedMarker } from "../review/finalize"
import { publishFinalizedReview } from "./finalized-review"

const fingerprint = "a".repeat(64)
const botEnv = { BOT_LOGIN: "bot[bot]" }
const patch = [
  "diff --git a/foo.ts b/foo.ts",
  "--- a/foo.ts",
  "+++ b/foo.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n")

const marker: FinalizedMarker = {
  schema_version: 1,
  valid: true,
  repository: "CCH-HQ/fixture",
  pr_number: 42,
  run_id: "run-1",
  provenance_sha256: "1".repeat(64),
  head_sha: "head-sha",
  trusted_manifest_sha256: "2".repeat(64),
  patch_sha256: "3".repeat(64),
  artifacts: {
    manifest: "4".repeat(64),
    coverage: "5".repeat(64),
    candidates: "6".repeat(64),
    verification: "7".repeat(64),
    report: "8".repeat(64),
    admission_ledger: "9".repeat(64),
    review_results: "a".repeat(64),
  },
  finalized_at: "2026-08-07T00:00:00.000Z",
}

function fake(options: {
  state?: string
  merged?: boolean
  headSha?: string
  initialComments?: Array<Record<string, unknown>>
  initialReviews?: Array<Record<string, unknown>>
  failFormalReviewOnce?: boolean
} = {}) {
  const comments: Array<Record<string, unknown>> = options.initialComments ?? [{
    id: 9,
    body: "Live progress\n<!-- cchp-bot:progress:pr_opened -->",
    user: { login: "bot[bot]" },
  }]
  const reviewComments: Array<Record<string, unknown>> = []
  const reviews: Array<Record<string, unknown>> = options.initialReviews ?? []
  let liveState = options.state ?? "open"
  let liveMerged = options.merged ?? false
  let liveHeadSha = options.headSha ?? "head-sha"
  const calls = {
    createReview: [] as Array<Record<string, unknown>>,
    dismissReview: [] as Array<Record<string, unknown>>,
    deleteReviewComment: [] as Array<Record<string, unknown>>,
    createComment: [] as Array<Record<string, unknown>>,
    updateComment: [] as Array<Record<string, unknown>>,
    deleteComment: [] as Array<Record<string, unknown>>,
  }
  let failFormalReview = options.failFormalReviewOnce ?? false
  const ref = (tag: string) => Object.assign(() => {}, { tag })
  const octokit = {
    rest: {
      pulls: {
        get: async () => ({ data: {
          number: 42,
          state: liveState,
          merged: liveMerged,
          merged_at: liveMerged ? "2026-08-07T00:00:00Z" : null,
          head: { sha: liveHeadSha },
        } }),
        listReviewComments: ref("reviewComments"),
        listCommentsForReview: ref("commentsForReview"),
        listReviews: ref("reviews"),
        createReview: async (args: Record<string, unknown>) => {
          calls.createReview.push(args)
          const id = 100 + calls.createReview.length
          const inline = Array.isArray(args.comments) ? args.comments as Array<Record<string, unknown>> : []
          for (const [index, item] of inline.entries()) reviewComments.push({
            id: id * 100 + index,
            ...item,
            pull_request_review_id: id,
            commit_id: args.commit_id,
            user: { login: "bot[bot]" },
            html_url: `https://example.invalid/inline/${id}`,
          })
          const state = args.event === "APPROVE" ? "APPROVED" : args.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED"
          reviews.push({ id, body: args.body, state, commit_id: args.commit_id, html_url: `https://example.invalid/review/${id}`, user: { login: "bot[bot]" } })
          if (failFormalReview && String(args.body).includes("cchp-review-publication:")) {
            failFormalReview = false
            throw new Error("response lost after remote review publication")
          }
          return { data: { id, html_url: `https://example.invalid/review/${id}`, commit_id: args.commit_id, state } }
        },
        dismissReview: async (args: Record<string, unknown>) => {
          calls.dismissReview.push(args)
          const review = reviews.find((entry) => entry.id === args.review_id)
          if (review) review.state = "DISMISSED"
          return { data: review ?? {} }
        },
        deleteReviewComment: async (args: Record<string, unknown>) => {
          calls.deleteReviewComment.push(args)
          const index = reviewComments.findIndex((comment) => comment.id === args.comment_id)
          if (index >= 0) reviewComments.splice(index, 1)
          return { data: {} }
        },
      },
      issues: {
        listComments: ref("comments"),
        createComment: async (args: Record<string, unknown>) => {
          calls.createComment.push(args)
          const id = 10 + calls.createComment.length - 1
          comments.push({ id, body: args.body, user: { login: "bot[bot]" } })
          return { data: { id, html_url: `https://example.invalid/comment/${id}` } }
        },
        updateComment: async (args: Record<string, unknown>) => {
          calls.updateComment.push(args)
          const existing = comments.find((comment) => comment.id === args.comment_id)
          if (existing) existing.body = args.body
          return { data: { id: args.comment_id, html_url: "https://example.invalid/comment/9" } }
        },
        deleteComment: async (args: Record<string, unknown>) => {
          calls.deleteComment.push(args)
          const index = comments.findIndex((comment) => comment.id === args.comment_id)
          if (index >= 0) comments.splice(index, 1)
          return { data: {} }
        },
      },
    },
    paginate: async (fn: { tag: string }, params?: Record<string, unknown>) => {
      if (fn.tag === "comments") return [...comments]
      if (fn.tag === "reviewComments") return [...reviewComments]
      if (fn.tag === "commentsForReview") {
        return reviewComments.filter((comment) => comment.pull_request_review_id === params?.review_id)
      }
      if (fn.tag === "reviews") return [...reviews]
      return []
    },
  } as unknown as GitHubClient
  return {
    octokit,
    calls,
    comments,
    reviewComments,
    reviews,
    setPr(next: { state?: string; merged?: boolean; headSha?: string }) {
      if (next.state !== undefined) liveState = next.state
      if (next.merged !== undefined) liveMerged = next.merged
      if (next.headSha !== undefined) liveHeadSha = next.headSha
    },
  }
}

test("publishes finalized inline findings, formal verdict and summary before completion", async () => {
  const { octokit, calls, comments } = fake()
  const workdir = mkdtempSync(join(tmpdir(), "cchp-finalized-review-"))
  const statePath = join(workdir, "ctx", "codex", "review-publication.json")
  const bundle: ReviewPublicationBundle = {
    report: "# Code Review Result\n\nOne confirmed issue.",
    patch,
    headSha: "head-sha",
    formalVerdict: "REQUEST_CHANGES",
    findingCount: 1,
    publishableInline: {
      [fingerprint]: { path: "foo.ts", line: 1, side: "RIGHT", body: "confirmed", fingerprint },
    },
  }
  const result = await publishFinalizedReview({
    octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle,
    idempotencyKey: "key-1",
    statePath,
    env: botEnv,
    onSummaryPublished: (summary) => {
      expect(summary).toMatchObject({ id: 9, action: "updated" })
    },
  })
  expect(result).toMatchObject({ phase: "complete", requestedVerdict: "REQUEST_CHANGES", effectiveVerdict: "REQUEST_CHANGES" })
  expect(calls.createReview).toHaveLength(2)
  expect(calls.createReview[0]).toMatchObject({ event: "COMMENT", comments: [expect.objectContaining({ path: "foo.ts", line: 1 })] })
  expect(calls.createReview[1]).toMatchObject({ event: "REQUEST_CHANGES", commit_id: "head-sha" })
  expect(String(calls.createReview[1]!.body)).toContain("<!-- cchp-review-publication:key-1 -->")
  expect(calls.updateComment).toHaveLength(1)
  expect(String(comments[0]!.body)).toContain("<!-- cchp-bot:review-summary -->")
  expect(String(comments[0]!.body)).not.toContain("cchp-bot:progress:pr_opened")
  expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
    phase: "complete",
    headSha: "head-sha",
    summaryCommentId: 9,
    summaryAction: "updated",
  })

  await publishFinalizedReview({ octokit, repository: "CCH-HQ/fixture", prNumber: 42, marker, bundle, idempotencyKey: "key-1", statePath, env: botEnv })
  expect(calls.createReview).toHaveLength(2)
  expect(calls.updateComment).toHaveLength(1)
})

test("fails closed before publication when the live PR head changed", async () => {
  const { octokit, calls } = fake({ headSha: "new-head" })
  const bundle: ReviewPublicationBundle = {
    report: "clean",
    patch,
    headSha: "head-sha",
    formalVerdict: "APPROVE",
    findingCount: 0,
    publishableInline: {},
  }
  await expect(publishFinalizedReview({
    octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle,
    idempotencyKey: "key-drift",
    statePath: join(mkdtempSync(join(tmpdir(), "cchp-finalized-review-")), "state.json"),
    env: botEnv,
  })).rejects.toThrow("head SHA changed")
  expect(calls.createReview).toHaveLength(0)
  expect(calls.createComment).toHaveLength(0)
  expect(calls.updateComment).toHaveLength(0)
})

test("rechecks the PR head immediately before inline and formal review mutations", async () => {
  for (const mode of ["inline", "formal"] as const) {
    const fixture = fake()
    const client = fixture.octokit as unknown as { paginate: (fn: { tag: string }, params: Record<string, unknown>) => Promise<unknown[]> }
    const paginate = client.paginate.bind(client)
    let drifted = false
    client.paginate = async (fn, params) => {
      const result = await paginate(fn, params)
      if (!drifted && fn.tag === "reviews") {
        fixture.setPr({ headSha: "new-head" })
        drifted = true
      }
      return result
    }
    await expect(publishFinalizedReview({
      octokit: fixture.octokit,
      repository: "CCH-HQ/fixture",
      prNumber: 42,
      marker,
      bundle: {
        report: "clean",
        patch,
        headSha: "head-sha",
        formalVerdict: "COMMENT",
        findingCount: mode === "inline" ? 1 : 0,
        publishableInline: mode === "inline"
          ? { [fingerprint]: { path: "foo.ts", line: 1, side: "RIGHT", body: "confirmed", fingerprint } }
          : {},
      },
      idempotencyKey: `key-head-guard-${mode}`,
      statePath: join(mkdtempSync(join(tmpdir(), "cchp-finalized-head-guard-")), "state.json"),
      env: botEnv,
    })).rejects.toThrow("head SHA changed")
    expect(fixture.calls.createReview).toHaveLength(0)
  }
})

test("dismisses a formal verdict published after the reviewed head changes during the mutation", async () => {
  const fixture = fake()
  const pulls = (fixture.octokit as unknown as { rest: { pulls: {
    createReview: (args: Record<string, unknown>) => Promise<unknown>
  } } }).rest.pulls
  const create = pulls.createReview
  pulls.createReview = async (args) => {
    const result = await create(args)
    if (String(args.body).includes("cchp-review-publication:")) fixture.setPr({ headSha: "new-head" })
    return result
  }
  const statePath = join(mkdtempSync(join(tmpdir(), "cchp-finalized-formal-race-")), "state.json")
  await expect(publishFinalizedReview({
    octokit: fixture.octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle: { report: "clean", patch, headSha: "head-sha", formalVerdict: "APPROVE", findingCount: 0, publishableInline: {} },
    idempotencyKey: "key-formal-race",
    statePath,
    env: botEnv,
  })).rejects.toThrow("head SHA changed")
  expect(fixture.calls.dismissReview).toEqual([expect.objectContaining({ review_id: 101, event: "DISMISS" })])
  expect(fixture.reviews).toEqual([expect.objectContaining({ id: 101, state: "DISMISSED" })])
  expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ phase: "inline_published" })
})

test("removes an inline batch and stops before later batches when the head changes during publication", async () => {
  const fixture = fake()
  const pulls = (fixture.octokit as unknown as { rest: { pulls: {
    createReview: (args: Record<string, unknown>) => Promise<unknown>
  } } }).rest.pulls
  const create = pulls.createReview
  pulls.createReview = async (args) => {
    const result = await create(args)
    if (Array.isArray(args.comments)) fixture.setPr({ headSha: "new-head" })
    return result
  }
  const publishableInline = Object.fromEntries(Array.from({ length: 51 }, (_, index) => {
    const fp = index.toString(16).padStart(64, "0")
    return [fp, { path: "foo.ts", line: 1, side: "RIGHT" as const, body: `confirmed ${index}`, fingerprint: fp }]
  }))
  const statePath = join(mkdtempSync(join(tmpdir(), "cchp-finalized-inline-race-")), "state.json")
  await expect(publishFinalizedReview({
    octokit: fixture.octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle: { report: "findings", patch, headSha: "head-sha", formalVerdict: "REQUEST_CHANGES", findingCount: 51, publishableInline },
    idempotencyKey: "key-inline-race",
    statePath,
    env: botEnv,
  })).rejects.toThrow("head SHA changed")
  expect(fixture.calls.createReview).toHaveLength(1)
  expect(fixture.calls.deleteReviewComment).toHaveLength(50)
  expect(fixture.calls.dismissReview).toEqual([expect.objectContaining({ review_id: 101, event: "DISMISS" })])
  expect(fixture.reviewComments).toHaveLength(0)
  expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ phase: "prepared" })
})

test("removes a summary created after the reviewed head changes during the mutation", async () => {
  const fixture = fake({ initialComments: [] })
  const issues = (fixture.octokit as unknown as { rest: { issues: {
    createComment: (args: Record<string, unknown>) => Promise<unknown>
  } } }).rest.issues
  const create = issues.createComment
  let drifted = false
  issues.createComment = async (args) => {
    const result = await create(args)
    if (!drifted) {
      drifted = true
      fixture.setPr({ headSha: "new-head" })
    }
    return result
  }
  const statePath = join(mkdtempSync(join(tmpdir(), "cchp-finalized-summary-create-race-")), "state.json")
  await expect(publishFinalizedReview({
    octokit: fixture.octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle: { report: "clean", patch, headSha: "head-sha", formalVerdict: "COMMENT", findingCount: 0, publishableInline: {} },
    idempotencyKey: "key-summary-create-race",
    statePath,
    env: botEnv,
  })).rejects.toThrow("head SHA changed")
  expect(fixture.calls.createComment).toHaveLength(1)
  expect(fixture.calls.deleteComment).toHaveLength(1)
  expect(fixture.comments).toHaveLength(0)
  expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ phase: "formal_review_published" })
})

test("restores a summary body updated after the reviewed head changes during the mutation", async () => {
  const originalBody = "Live progress\n<!-- cchp-bot:progress:pr_opened -->"
  const fixture = fake({ initialComments: [{ id: 9, body: originalBody, user: { login: "bot[bot]" } }] })
  const issues = (fixture.octokit as unknown as { rest: { issues: {
    updateComment: (args: Record<string, unknown>) => Promise<unknown>
  } } }).rest.issues
  const update = issues.updateComment
  let drifted = false
  issues.updateComment = async (args) => {
    const result = await update(args)
    if (!drifted) {
      drifted = true
      fixture.setPr({ headSha: "new-head" })
    }
    return result
  }
  const statePath = join(mkdtempSync(join(tmpdir(), "cchp-finalized-summary-update-race-")), "state.json")
  await expect(publishFinalizedReview({
    octokit: fixture.octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle: { report: "clean", patch, headSha: "head-sha", formalVerdict: "COMMENT", findingCount: 0, publishableInline: {} },
    idempotencyKey: "key-summary-update-race",
    statePath,
    env: botEnv,
  })).rejects.toThrow("head SHA changed")
  expect(fixture.calls.updateComment).toHaveLength(2)
  expect(fixture.comments.find((comment) => comment.id === 9)?.body).toBe(originalBody)
  expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ phase: "formal_review_published" })
})

test("preserves the head-drift error when summary compensation also fails", async () => {
  const fixture = fake({ initialComments: [] })
  const issues = (fixture.octokit as unknown as { rest: { issues: {
    createComment: (args: Record<string, unknown>) => Promise<unknown>
    deleteComment: (args: Record<string, unknown>) => Promise<unknown>
  } } }).rest.issues
  const create = issues.createComment
  issues.createComment = async (args) => {
    const result = await create(args)
    fixture.setPr({ headSha: "new-head" })
    return result
  }
  issues.deleteComment = async () => { throw new Error("delete compensation failed") }
  const statePath = join(mkdtempSync(join(tmpdir(), "cchp-finalized-summary-compensation-failure-")), "state.json")
  let caught: unknown
  try {
    await publishFinalizedReview({
      octokit: fixture.octokit,
      repository: "CCH-HQ/fixture",
      prNumber: 42,
      marker,
      bundle: { report: "clean", patch, headSha: "head-sha", formalVerdict: "COMMENT", findingCount: 0, publishableInline: {} },
      idempotencyKey: "key-summary-compensation-failure",
      statePath,
      env: botEnv,
    })
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(AggregateError)
  const errors = (caught as AggregateError).errors as Error[]
  expect(String(errors[0])).toContain("head SHA changed")
  expect(String(errors[1])).toContain("summary compensation failed")
  expect(String(errors[1]?.cause)).toContain("delete compensation failed")
  expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ phase: "formal_review_published" })
})

test("recreates stale summary content when the head changes after deletion", async () => {
  const progressBody = "Live progress\n<!-- cchp-bot:progress:pr_opened -->"
  const staleBody = "Old result\n<!-- cchp-bot:review-summary -->\n<!-- cchp-review-report:old:1-of-1 -->"
  const fixture = fake({ initialComments: [
    { id: 9, body: progressBody, user: { login: "bot[bot]" } },
    { id: 8, body: staleBody, user: { login: "bot[bot]" } },
  ] })
  const issues = (fixture.octokit as unknown as { rest: { issues: {
    deleteComment: (args: Record<string, unknown>) => Promise<unknown>
  } } }).rest.issues
  const remove = issues.deleteComment
  issues.deleteComment = async (args) => {
    const result = await remove(args)
    fixture.setPr({ headSha: "new-head" })
    return result
  }
  const statePath = join(mkdtempSync(join(tmpdir(), "cchp-finalized-summary-delete-race-")), "state.json")
  await expect(publishFinalizedReview({
    octokit: fixture.octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle: { report: "clean", patch, headSha: "head-sha", formalVerdict: "COMMENT", findingCount: 0, publishableInline: {} },
    idempotencyKey: "key-summary-delete-race",
    statePath,
    env: botEnv,
  })).rejects.toThrow("head SHA changed")
  expect(fixture.comments.some((comment) => comment.body === progressBody)).toBe(true)
  expect(fixture.comments.some((comment) => comment.body === staleBody)).toBe(true)
  expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ phase: "formal_review_published" })
})

test("requires a trusted bot owner before any finalized publication mutation", async () => {
  const { octokit, calls } = fake()
  await expect(publishFinalizedReview({
    octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle: { report: "clean", patch, headSha: "head-sha", formalVerdict: "COMMENT", findingCount: 0, publishableInline: {} },
    idempotencyKey: "key-owner-required",
    statePath: join(mkdtempSync(join(tmpdir(), "cchp-finalized-owner-required-")), "state.json"),
    env: {},
  })).rejects.toThrow("trusted bot login")
  expect(calls.createReview).toHaveLength(0)
  expect(calls.createComment).toHaveLength(0)
  expect(calls.updateComment).toHaveLength(0)
  expect(calls.deleteComment).toHaveLength(0)
})

test("rejects credential material before any finalized review publication", async () => {
  const { octokit, calls } = fake()
  const bundle: ReviewPublicationBundle = {
    report: "report containing embedded-secret",
    patch,
    headSha: "head-sha",
    formalVerdict: "COMMENT",
    findingCount: 0,
    publishableInline: {},
  }
  await expect(publishFinalizedReview({
    octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle,
    idempotencyKey: "key-secret",
    statePath: join(mkdtempSync(join(tmpdir(), "cchp-finalized-review-")), "state.json"),
    forbiddenValues: () => ["embedded-secret"],
    env: botEnv,
  })).rejects.toThrow("credential material")
  expect(calls.createReview).toHaveLength(0)
  expect(calls.createComment).toHaveLength(0)
  expect(calls.updateComment).toHaveLength(0)
})

test("records the effective COMMENT verdict when auto-approve is disabled", async () => {
  const { octokit, calls } = fake()
  const bundle: ReviewPublicationBundle = {
    report: "clean",
    patch,
    headSha: "head-sha",
    formalVerdict: "APPROVE",
    findingCount: 0,
    publishableInline: {},
  }
  const result = await publishFinalizedReview({
    octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle,
    idempotencyKey: "key-kill-switch",
    statePath: join(mkdtempSync(join(tmpdir(), "cchp-finalized-review-")), "state.json"),
    env: { ...botEnv, CCHP_DISABLE_AUTO_APPROVE: "1" },
  })
  expect(result.effectiveVerdict).toBe("COMMENT")
  expect(calls.createReview.at(-1)).toMatchObject({ event: "COMMENT" })
})

test("splits a large finalized report into byte-safe comments without losing content", async () => {
  const { octokit, calls, comments } = fake()
  const report = `# Large report\n\n${"发现内容。".repeat(20_000)}`
  const bundle: ReviewPublicationBundle = {
    report,
    patch,
    headSha: "head-sha",
    formalVerdict: "COMMENT",
    findingCount: 1,
    publishableInline: {},
  }
  await publishFinalizedReview({
    octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle,
    idempotencyKey: "key-large",
    statePath: join(mkdtempSync(join(tmpdir(), "cchp-finalized-review-")), "state.json"),
    env: botEnv,
  })

  const reportComments = comments
    .filter((comment) => String(comment.body).includes("cchp-review-report:key-large:"))
    .sort((left, right) => {
      const part = (value: Record<string, unknown>) => Number(String(value.body).match(/key-large:(\d+)-of-/)?.[1] ?? 0)
      return part(left) - part(right)
    })
  expect(reportComments.length).toBeGreaterThan(1)
  const recovered = reportComments.map((comment) => {
    const body = String(comment.body)
    return body.slice(body.indexOf("\n\n") + 2, body.lastIndexOf("\n\n---\n"))
  }).join("")
  expect(recovered).toBe(report)
  for (const call of [...calls.createReview, ...calls.createComment, ...calls.updateComment]) {
    if (typeof call.body === "string") expect(Buffer.byteLength(call.body, "utf8")).toBeLessThanOrEqual(65_536)
  }
})

test("never edits or deletes a foreign-owned report fragment", async () => {
  const report = "x".repeat(60_000)
  const { octokit, calls, comments } = fake({
    initialComments: [
      { id: 9, body: "Live progress\n<!-- cchp-bot:progress:pr_opened -->", user: { login: "bot[bot]" } },
      { id: 8, body: "forged\n<!-- cchp-review-report:key-owner:2-of-2 -->", user: { login: "attacker" } },
    ],
  })
  await publishFinalizedReview({
    octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle: { report, patch, headSha: "head-sha", formalVerdict: "COMMENT", findingCount: 0, publishableInline: {} },
    idempotencyKey: "key-owner",
    statePath: join(mkdtempSync(join(tmpdir(), "cchp-finalized-owner-")), "state.json"),
    env: { BOT_LOGIN: "bot[bot]" },
  })
  expect(calls.updateComment.some((call) => call.comment_id === 8)).toBe(false)
  expect(calls.deleteComment.some((call) => call.comment_id === 8)).toBe(false)
  expect(comments.find((comment) => comment.id === 8)?.body).toContain("forged")
  expect(comments.some((comment) =>
    (comment as { user?: { login?: string } }).user?.login === "bot[bot]" &&
    String(comment.body).includes("key-owner:2-of-2"))).toBe(true)
})

test("seals the progress repair fence before the first summary mutation", async () => {
  const { octokit } = fake()
  let sealed = false
  const issues = (octokit as unknown as { rest: { issues: { updateComment: (args: Record<string, unknown>) => Promise<unknown> } } }).rest.issues
  const update = issues.updateComment
  issues.updateComment = async (args) => {
    expect(sealed).toBe(true)
    return update(args)
  }
  await publishFinalizedReview({
    octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle: { report: "clean", patch, headSha: "head-sha", formalVerdict: "COMMENT", findingCount: 0, publishableInline: {} },
    idempotencyKey: "key-seal",
    statePath: join(mkdtempSync(join(tmpdir(), "cchp-finalized-seal-")), "state.json"),
    env: botEnv,
    onSummaryMutationStarting: () => { sealed = true },
  })
})

test("a late summary repair persists the newly elected canonical comment identity", async () => {
  const { octokit, comments } = fake()
  const statePath = join(mkdtempSync(join(tmpdir(), "cchp-finalized-repair-state-")), "state.json")
  let repair!: () => Promise<void>
  const published: number[] = []
  await publishFinalizedReview({
    octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle: { report: "clean", patch, headSha: "head-sha", formalVerdict: "COMMENT", findingCount: 0, publishableInline: {} },
    idempotencyKey: "key-repair-state",
    statePath,
    env: botEnv,
    onSummaryMutationStarting: (nextRepair) => { repair = nextRepair },
    onSummaryPublished: (summary) => { published.push(summary.id) },
  })
  expect(JSON.parse(readFileSync(statePath, "utf8")).summaryCommentId).toBe(9)
  comments.push({ id: 20, body: "Late progress\n<!-- cchp-bot:progress:pr_opened -->", user: { login: "bot[bot]" } })
  await repair()
  expect(JSON.parse(readFileSync(statePath, "utf8")).summaryCommentId).toBe(20)
  expect(published).toEqual([9, 20])
  expect(comments.filter((comment) => (comment as { user?: { login?: string } }).user?.login === "bot[bot]")).toHaveLength(1)
  expect(comments[0]?.id).toBe(20)
})

test("repairs every missing fragment when a complete publication resumes", async () => {
  const { octokit, comments } = fake()
  const root = mkdtempSync(join(tmpdir(), "cchp-finalized-resume-"))
  const statePath = join(root, "state.json")
  const input = {
    octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle: {
      report: "y".repeat(60_000),
      patch,
      headSha: "head-sha",
      formalVerdict: "COMMENT" as const,
      findingCount: 0,
      publishableInline: {},
    },
    idempotencyKey: "key-resume-parts",
    statePath,
    env: { BOT_LOGIN: "bot[bot]" },
  }
  await publishFinalizedReview(input)
  const missing = comments.findIndex((comment) => String(comment.body).includes("key-resume-parts:2-of-2"))
  expect(missing).toBeGreaterThanOrEqual(0)
  comments.splice(missing, 1)
  await publishFinalizedReview(input)
  const parts = comments.filter((comment) =>
    (comment as { user?: { login?: string } }).user?.login === "bot[bot]" &&
    String(comment.body).includes("cchp-review-report:key-resume-parts:"))
  expect(parts).toHaveLength(2)
  expect(parts.some((comment) => String(comment.body).includes("key-resume-parts:2-of-2"))).toBe(true)
})

test("fails closed when a complete publication resumes after an inline finding was deleted", async () => {
  const { octokit, reviewComments } = fake()
  const statePath = join(mkdtempSync(join(tmpdir(), "cchp-finalized-missing-inline-")), "state.json")
  const input = {
    octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle: {
      report: "one finding",
      patch,
      headSha: "head-sha",
      formalVerdict: "REQUEST_CHANGES" as const,
      findingCount: 1,
      publishableInline: {
        [fingerprint]: { path: "foo.ts", line: 1, side: "RIGHT" as const, body: "confirmed", fingerprint },
      },
    },
    idempotencyKey: "key-missing-inline",
    statePath,
    env: botEnv,
  }
  await publishFinalizedReview(input)
  expect(reviewComments).toHaveLength(1)
  reviewComments.splice(0, 1)
  await expect(publishFinalizedReview(input)).rejects.toThrow("inline")
})

test("fails closed when a complete publication resumes after its formal review was dismissed", async () => {
  const { octokit, reviews } = fake()
  const statePath = join(mkdtempSync(join(tmpdir(), "cchp-finalized-dismissed-review-")), "state.json")
  const input = {
    octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle: {
      report: "clean",
      patch,
      headSha: "head-sha",
      formalVerdict: "APPROVE" as const,
      findingCount: 0,
      publishableInline: {},
    },
    idempotencyKey: "key-dismissed-review",
    statePath,
    env: botEnv,
  }
  await publishFinalizedReview(input)
  expect(reviews).toHaveLength(1)
  reviews[0]!.state = "DISMISSED"
  await expect(publishFinalizedReview(input)).rejects.toThrow("formal review")
})

test("complete resume removes stale owned progress, duplicate summaries and old report fragments", async () => {
  const { octokit, calls, comments } = fake()
  const statePath = join(mkdtempSync(join(tmpdir(), "cchp-finalized-complete-converge-")), "state.json")
  const input = {
    octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle: { report: "clean", patch, headSha: "head-sha", formalVerdict: "COMMENT" as const, findingCount: 0, publishableInline: {} },
    idempotencyKey: "key-complete-converge",
    statePath,
    env: botEnv,
  }
  await publishFinalizedReview(input)
  comments.push(
    { id: 20, body: "Stale live\n<!-- cchp-bot:progress:pr_opened -->", user: { login: "bot[bot]" } },
    { id: 21, body: "Duplicate\n<!-- cchp-bot:review-summary -->\n<!-- cchp-review-report:old-key:1-of-1 -->", user: { login: "bot[bot]" } },
    { id: 22, body: "Old fragment\n<!-- cchp-review-report:old-key:2-of-2 -->", user: { login: "bot[bot]" } },
    { id: 23, body: "Foreign live\n<!-- cchp-bot:progress:pr_opened -->", user: { login: "attacker" } },
  )
  const resumed = await publishFinalizedReview(input)
  const botComments = comments.filter((comment) => (comment as { user?: { login?: string } }).user?.login === "bot[bot]")
  expect(botComments.filter((comment) => String(comment.body).includes("cchp-bot:review-summary"))).toHaveLength(1)
  expect(botComments.some((comment) => String(comment.body).includes("cchp-bot:progress:pr_opened"))).toBe(false)
  expect(botComments.some((comment) => String(comment.body).includes("cchp-review-report:old-key:"))).toBe(false)
  expect(comments.find((comment) => comment.id === 23)?.body).toContain("Foreign live")
  expect(calls.deleteComment.map((call) => call.comment_id)).toEqual(expect.arrayContaining([9, 21, 22]))
  expect(resumed.summaryCommentId).toBe(20)
})

test("reconciles an old summary and the current progress comment to one canonical summary", async () => {
  const { octokit, calls, comments } = fake({
    initialComments: [
      { id: 8, body: "Old result\n<!-- cchp-bot:review-summary -->", user: { login: "bot[bot]" } },
      { id: 9, body: "Working\n<!-- cchp-bot:progress:pr_opened -->", user: { login: "bot[bot]" } },
    ],
  })
  const bundle: ReviewPublicationBundle = {
    report: "new result",
    patch,
    headSha: "head-sha",
    formalVerdict: "APPROVE",
    findingCount: 0,
    publishableInline: {},
  }
  await publishFinalizedReview({
    octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle,
    idempotencyKey: "key-reconcile",
    statePath: join(mkdtempSync(join(tmpdir(), "cchp-finalized-review-")), "state.json"),
    env: botEnv,
  })
  expect(calls.updateComment.at(-1)?.comment_id).toBe(9)
  expect(calls.deleteComment).toEqual([{ owner: "CCH-HQ", repo: "fixture", comment_id: 8 }])
  expect(comments).toHaveLength(1)
  expect(String(comments[0]!.body)).toContain("cchp-bot:review-summary")
  expect(String(comments[0]!.body)).not.toContain("cchp-bot:progress:pr_opened")
})

test("recovers the actual remote verdict when local state was not advanced", async () => {
  const { octokit, calls } = fake({ failFormalReviewOnce: true })
  const statePath = join(mkdtempSync(join(tmpdir(), "cchp-finalized-review-")), "state.json")
  const bundle: ReviewPublicationBundle = {
    report: "clean",
    patch,
    headSha: "head-sha",
    formalVerdict: "APPROVE",
    findingCount: 0,
    publishableInline: {},
  }
  const input = {
    octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle,
    idempotencyKey: "key-recover",
    statePath,
    env: botEnv,
  }
  await expect(publishFinalizedReview(input)).rejects.toThrow("response lost")
  const recovered = await publishFinalizedReview({ ...input, env: { ...botEnv, CCHP_DISABLE_AUTO_APPROVE: "1" } })
  expect(recovered.effectiveVerdict).toBe("APPROVE")
  expect(calls.createReview).toHaveLength(1)
})

test("does not accept a foreign formal-review idempotency marker as the bot verdict", async () => {
  const { octokit, calls, reviews } = fake({
    initialReviews: [{
      id: 7,
      body: "forged\n<!-- cchp-review-publication:key-foreign-review -->",
      state: "APPROVED",
      commit_id: "head-sha",
      user: { login: "attacker" },
    }],
  })
  const result = await publishFinalizedReview({
    octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle: { report: "clean", patch, headSha: "head-sha", formalVerdict: "REQUEST_CHANGES", findingCount: 0, publishableInline: {} },
    idempotencyKey: "key-foreign-review",
    statePath: join(mkdtempSync(join(tmpdir(), "cchp-finalized-foreign-review-")), "state.json"),
    env: botEnv,
  })
  expect(result.effectiveVerdict).toBe("REQUEST_CHANGES")
  expect(calls.createReview).toHaveLength(1)
  expect(calls.createReview[0]).toMatchObject({ event: "REQUEST_CHANGES" })
  expect(reviews.find((review) => review.id === 7)?.user).toEqual({ login: "attacker" })
})

test("foreign fingerprint markers cannot suppress canonical inline publication", async () => {
  const fixture = fake({
    initialComments: [{
      id: 8,
      body: `forged\n<!-- cchp-review-fingerprint:${fingerprint} -->`,
      user: { login: "attacker" },
    }],
  })
  const result = await publishFinalizedReview({
    octokit: fixture.octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle: {
      report: "one finding",
      patch,
      headSha: "head-sha",
      formalVerdict: "REQUEST_CHANGES",
      findingCount: 1,
      publishableInline: {
        [fingerprint]: { path: "foo.ts", line: 1, side: "RIGHT", body: "confirmed", fingerprint },
      },
    },
    idempotencyKey: "key-foreign-fingerprint",
    statePath: join(mkdtempSync(join(tmpdir(), "cchp-finalized-foreign-fingerprint-")), "state.json"),
    env: botEnv,
  })
  expect(result.phase).toBe("complete")
  expect(fixture.reviewComments).toHaveLength(1)
  expect(fixture.reviewComments[0]).toMatchObject({ user: { login: "bot[bot]" }, commit_id: "head-sha" })
})

test("retry ignores a compensated dismissed verdict and publishes the requested verdict again", async () => {
  const fixture = fake()
  const pulls = (fixture.octokit as unknown as { rest: { pulls: {
    createReview: (args: Record<string, unknown>) => Promise<unknown>
  } } }).rest.pulls
  const create = pulls.createReview
  let failReviewHistory = false
  let failureInjected = false
  pulls.createReview = async (args) => {
    const result = await create(args)
    if (!failureInjected && String(args.body).includes("cchp-review-publication:")) failReviewHistory = true
    return result
  }
  const client = fixture.octokit as unknown as { paginate: (fn: { tag: string }, params?: Record<string, unknown>) => Promise<unknown[]> }
  const paginate = client.paginate.bind(client)
  client.paginate = async (fn, params) => {
    if (fn.tag === "reviews" && failReviewHistory) {
      failReviewHistory = false
      failureInjected = true
      throw new Error("review history temporarily unavailable")
    }
    return paginate(fn, params)
  }
  const statePath = join(mkdtempSync(join(tmpdir(), "cchp-finalized-dismiss-retry-")), "state.json")
  const input = {
    octokit: fixture.octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle: { report: "blocking", patch, headSha: "head-sha", formalVerdict: "REQUEST_CHANGES" as const, findingCount: 0, publishableInline: {} },
    idempotencyKey: "key-dismiss-retry",
    statePath,
    env: botEnv,
  }
  await expect(publishFinalizedReview(input)).rejects.toThrow("review history temporarily unavailable")
  expect(fixture.reviews[0]).toMatchObject({ state: "DISMISSED" })
  const result = await publishFinalizedReview(input)
  expect(result).toMatchObject({ phase: "complete", effectiveVerdict: "REQUEST_CHANGES" })
  expect(fixture.calls.createReview).toHaveLength(2)
  expect(fixture.reviews[1]).toMatchObject({ state: "CHANGES_REQUESTED" })
})

test("resume validates saved review phases before publishing a summary", async () => {
  const fixture = fake()
  const statePath = join(mkdtempSync(join(tmpdir(), "cchp-finalized-phase-resume-")), "state.json")
  const input = {
    octokit: fixture.octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle: { report: "clean", patch, headSha: "head-sha", formalVerdict: "APPROVE" as const, findingCount: 0, publishableInline: {} },
    idempotencyKey: "key-phase-resume",
    statePath,
    env: botEnv,
  }
  await expect(publishFinalizedReview({
    ...input,
    onSummaryMutationStarting: () => { throw new Error("stop before summary") },
  })).rejects.toThrow("stop before summary")
  expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ phase: "formal_review_published" })
  fixture.reviews[0]!.state = "DISMISSED"
  await expect(publishFinalizedReview(input)).rejects.toThrow("formal review")
  expect(fixture.calls.createComment).toHaveLength(0)
  expect(fixture.calls.updateComment).toHaveLength(0)
})

test("durable journal dismisses a formal review whose response was lost before the head changed", async () => {
  const fixture = fake({ failFormalReviewOnce: true })
  const statePath = join(mkdtempSync(join(tmpdir(), "cchp-finalized-formal-lost-response-")), "state.json")
  const input = {
    octokit: fixture.octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle: { report: "blocking", patch, headSha: "head-sha", formalVerdict: "REQUEST_CHANGES" as const, findingCount: 0, publishableInline: {} },
    idempotencyKey: "key-formal-lost-response",
    statePath,
    env: botEnv,
  }
  await expect(publishFinalizedReview(input)).rejects.toThrow("response lost")
  expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ pendingMutation: { kind: "formal_review" } })
  fixture.setPr({ headSha: "new-head" })
  await expect(publishFinalizedReview(input)).rejects.toThrow("head SHA changed")
  expect(fixture.reviews[0]).toMatchObject({ state: "DISMISSED" })
  expect(JSON.parse(readFileSync(statePath, "utf8"))).not.toHaveProperty("pendingMutation")
})

test("durable journal removes an inline review when identity capture failed before a head change", async () => {
  const fixture = fake()
  const client = fixture.octokit as unknown as { paginate: (fn: { tag: string }, params?: Record<string, unknown>) => Promise<unknown[]> }
  const paginate = client.paginate.bind(client)
  let failIdentityCapture = true
  client.paginate = async (fn, params) => {
    if (fn.tag === "commentsForReview" && failIdentityCapture) {
      failIdentityCapture = false
      throw new Error("comment identity capture failed")
    }
    return paginate(fn, params)
  }
  const statePath = join(mkdtempSync(join(tmpdir(), "cchp-finalized-inline-lost-response-")), "state.json")
  const input = {
    octokit: fixture.octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle: {
      report: "one finding",
      patch,
      headSha: "head-sha",
      formalVerdict: "REQUEST_CHANGES" as const,
      findingCount: 1,
      publishableInline: {
        [fingerprint]: { path: "foo.ts", line: 1, side: "RIGHT" as const, body: "confirmed", fingerprint },
      },
    },
    idempotencyKey: "key-inline-lost-response",
    statePath,
    env: botEnv,
  }
  await expect(publishFinalizedReview(input)).rejects.toThrow("comment identity capture failed")
  expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ pendingMutation: { kind: "inline_review" } })
  fixture.setPr({ headSha: "new-head" })
  await expect(publishFinalizedReview(input)).rejects.toThrow("head SHA changed")
  expect(fixture.reviewComments).toHaveLength(0)
  expect(fixture.reviews[0]).toMatchObject({ state: "DISMISSED" })
})

test("durable journal restores a summary update whose response was lost before the head changed", async () => {
  const originalBody = "Live progress\n<!-- cchp-bot:progress:pr_opened -->"
  const fixture = fake({ initialComments: [{ id: 9, body: originalBody, user: { login: "bot[bot]" } }] })
  const issues = (fixture.octokit as unknown as { rest: { issues: {
    updateComment: (args: Record<string, unknown>) => Promise<unknown>
  } } }).rest.issues
  const update = issues.updateComment
  let loseResponse = true
  issues.updateComment = async (args) => {
    const result = await update(args)
    if (loseResponse) {
      loseResponse = false
      throw new Error("summary update response lost")
    }
    return result
  }
  const statePath = join(mkdtempSync(join(tmpdir(), "cchp-finalized-summary-lost-response-")), "state.json")
  const input = {
    octokit: fixture.octokit,
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    marker,
    bundle: { report: "clean", patch, headSha: "head-sha", formalVerdict: "COMMENT" as const, findingCount: 0, publishableInline: {} },
    idempotencyKey: "key-summary-lost-response",
    statePath,
    env: botEnv,
  }
  await expect(publishFinalizedReview(input)).rejects.toThrow("summary update response lost")
  expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ pendingMutation: { kind: "summary_update", commentId: 9 } })
  fixture.setPr({ headSha: "new-head" })
  await expect(publishFinalizedReview(input)).rejects.toThrow("head SHA changed")
  expect(fixture.comments.find((comment) => comment.id === 9)?.body).toBe(originalBody)
  expect(JSON.parse(readFileSync(statePath, "utf8"))).not.toHaveProperty("pendingMutation")
})
