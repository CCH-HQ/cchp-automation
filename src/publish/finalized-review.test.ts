import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GitHubClient } from "../github/client"
import type { ReviewPublicationBundle } from "../mcp/server"
import type { FinalizedMarker } from "../review/finalize"
import { publishFinalizedReview } from "./finalized-review"

const fingerprint = "a".repeat(64)
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
  failFormalReviewOnce?: boolean
} = {}) {
  const comments: Array<Record<string, unknown>> = options.initialComments ?? [{
    id: 9,
    body: "Live progress\n<!-- cchp-bot:progress:pr_opened -->",
  }]
  const reviewComments: Array<Record<string, unknown>> = []
  const reviews: Array<Record<string, unknown>> = []
  const calls = {
    createReview: [] as Array<Record<string, unknown>>,
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
          state: options.state ?? "open",
          merged: options.merged ?? false,
          merged_at: options.merged ? "2026-08-07T00:00:00Z" : null,
          head: { sha: options.headSha ?? "head-sha" },
        } }),
        listReviewComments: ref("reviewComments"),
        listReviews: ref("reviews"),
        createReview: async (args: Record<string, unknown>) => {
          calls.createReview.push(args)
          const id = 100 + calls.createReview.length
          const inline = Array.isArray(args.comments) ? args.comments as Array<Record<string, unknown>> : []
          for (const item of inline) reviewComments.push({ id: id * 10, ...item, html_url: `https://example.invalid/inline/${id}` })
          const state = args.event === "APPROVE" ? "APPROVED" : args.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED"
          reviews.push({ id, body: args.body, state, commit_id: args.commit_id, html_url: `https://example.invalid/review/${id}` })
          if (failFormalReview && String(args.body).includes("cchp-review-publication:")) {
            failFormalReview = false
            throw new Error("response lost after remote review publication")
          }
          return { data: { id, html_url: `https://example.invalid/review/${id}` } }
        },
      },
      issues: {
        listComments: ref("comments"),
        createComment: async (args: Record<string, unknown>) => {
          calls.createComment.push(args)
          comments.push({ id: 10, body: args.body })
          return { data: { id: 10, html_url: "https://example.invalid/comment/10" } }
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
    paginate: async (fn: { tag: string }) => {
      if (fn.tag === "comments") return comments
      if (fn.tag === "reviewComments") return reviewComments
      if (fn.tag === "reviews") return reviews
      return []
    },
  } as unknown as GitHubClient
  return { octokit, calls, comments }
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
  })
  expect(result).toMatchObject({ phase: "complete", requestedVerdict: "REQUEST_CHANGES", effectiveVerdict: "REQUEST_CHANGES" })
  expect(calls.createReview).toHaveLength(2)
  expect(calls.createReview[0]).toMatchObject({ event: "COMMENT", comments: [expect.objectContaining({ path: "foo.ts", line: 1 })] })
  expect(calls.createReview[1]).toMatchObject({ event: "REQUEST_CHANGES", commit_id: "head-sha" })
  expect(String(calls.createReview[1]!.body)).toContain("<!-- cchp-review-publication:key-1 -->")
  expect(calls.updateComment).toHaveLength(1)
  expect(String(comments[0]!.body)).toContain("<!-- cchp-bot:review-summary -->")
  expect(String(comments[0]!.body)).not.toContain("cchp-bot:progress:pr_opened")
  expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ phase: "complete", headSha: "head-sha" })

  await publishFinalizedReview({ octokit, repository: "CCH-HQ/fixture", prNumber: 42, marker, bundle, idempotencyKey: "key-1", statePath })
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
  })).rejects.toThrow("head SHA changed")
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
    env: { CCHP_DISABLE_AUTO_APPROVE: "1" },
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

test("reconciles an old summary and the current progress comment to one canonical summary", async () => {
  const { octokit, calls, comments } = fake({
    initialComments: [
      { id: 8, body: "Old result\n<!-- cchp-bot:review-summary -->" },
      { id: 9, body: "Working\n<!-- cchp-bot:progress:pr_opened -->" },
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
  }
  await expect(publishFinalizedReview(input)).rejects.toThrow("response lost")
  const recovered = await publishFinalizedReview({ ...input, env: { CCHP_DISABLE_AUTO_APPROVE: "1" } })
  expect(recovered.effectiveVerdict).toBe("APPROVE")
  expect(calls.createReview).toHaveLength(1)
})
