import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GitHubClient } from "../github/client"
import type { ReviewPublicationBundle } from "../mcp/server"
import { writePreparedFinalizedReviewPublication } from "../publish/finalized-review"
import type { FinalizedMarker } from "../review/finalize"
import { finalizeWorkflowProgress } from "./finalize-workflow-progress"
import { readProgressPublicationSnapshot } from "./progress-publication"
import { readWorkflowFinalization } from "./workflow-finalization"
import { writeWorkflowRuntimeSnapshot } from "./workflow-runtime-snapshot"

const headSha = "b".repeat(40)
const repository = "CCH-HQ/fixture"
const prNumber = 42
const botLogin = "bot[bot]"
const idempotencyKey = "prepared-review-e2e"
const progressMarker = "cchp-bot:progress:pr_opened"
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
  repository,
  pr_number: prNumber,
  run_id: "engine-run",
  provenance_sha256: "1".repeat(64),
  head_sha: headSha,
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

const bundle: ReviewPublicationBundle = {
  report: "# Code Review Result\n\nNo confirmed findings.",
  patch,
  headSha,
  formalVerdict: "COMMENT",
  findingCount: 0,
  publishableInline: {},
}

function fakeAuthoritativeGitHub() {
  const comments: Array<Record<string, unknown>> = [{
    id: 9,
    body: `Live progress\n<!-- ${progressMarker} -->`,
    html_url: "https://example.invalid/comment/9",
    user: { login: botLogin },
  }]
  const reviewComments: Array<Record<string, unknown>> = []
  const reviews: Array<Record<string, unknown>> = []
  const calls = {
    createReview: [] as Array<Record<string, unknown>>,
    createComment: [] as Array<Record<string, unknown>>,
    updateComment: [] as Array<Record<string, unknown>>,
    deleteComment: [] as Array<Record<string, unknown>>,
  }
  const endpoint = (tag: string) => Object.assign(() => {}, { tag })
  const octokit = {
    rest: {
      pulls: {
        get: async () => ({ data: {
          number: prNumber,
          state: "open",
          merged: false,
          merged_at: null,
          head: { sha: headSha },
        } }),
        listReviewComments: endpoint("reviewComments"),
        listReviews: endpoint("reviews"),
        createReview: async (args: Record<string, unknown>) => {
          calls.createReview.push(args)
          const id = 100 + calls.createReview.length
          const state = args.event === "APPROVE"
            ? "APPROVED"
            : args.event === "REQUEST_CHANGES"
              ? "CHANGES_REQUESTED"
              : "COMMENTED"
          reviews.push({
            id,
            body: args.body,
            state,
            commit_id: args.commit_id,
            html_url: `https://example.invalid/review/${id}`,
            user: { login: botLogin },
          })
          return { data: {
            id,
            commit_id: args.commit_id,
            state,
            html_url: `https://example.invalid/review/${id}`,
          } }
        },
      },
      issues: {
        listComments: endpoint("comments"),
        createComment: async (args: Record<string, unknown>) => {
          calls.createComment.push(args)
          const id = 10 + calls.createComment.length
          const comment = {
            id,
            body: args.body,
            html_url: `https://example.invalid/comment/${id}`,
            user: { login: botLogin },
          }
          comments.push(comment)
          return { data: comment }
        },
        updateComment: async (args: Record<string, unknown>) => {
          calls.updateComment.push(args)
          const comment = comments.find((candidate) => candidate.id === args.comment_id)
          if (comment) comment.body = args.body
          return { data: {
            id: args.comment_id,
            html_url: `https://example.invalid/comment/${String(args.comment_id)}`,
          } }
        },
        deleteComment: async (args: Record<string, unknown>) => {
          calls.deleteComment.push(args)
          const index = comments.findIndex((candidate) => candidate.id === args.comment_id)
          if (index >= 0) comments.splice(index, 1)
          return { data: {} }
        },
      },
    },
    paginate: async (fn: { tag: string }) => {
      if (fn.tag === "comments") return [...comments]
      if (fn.tag === "reviewComments") return [...reviewComments]
      if (fn.tag === "reviews") return [...reviews]
      return []
    },
  } as unknown as GitHubClient
  return { octokit, calls, comments, reviews }
}

function preparedFixture(preparedTarget: {
  repository: string
  prNumber: number
  marker: FinalizedMarker
} = { repository, prNumber, marker }) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "cchp-prepared-review-e2e-"))
  const workdir = join(fixtureRoot, "workdir")
  const codexDir = join(workdir, "ctx", "codex")
  const staging = join(fixtureRoot, "trusted-staging")
  mkdirSync(codexDir, { recursive: true })
  mkdirSync(staging, { recursive: true })
  writeFileSync(join(codexDir, "terminal.json"), `${JSON.stringify({
    state: "SUCCEEDED",
    exitCode: 0,
    rootThreadId: "root-thread",
    rootTurnId: "root-turn",
    usage: {
      acceptedRaw: true,
      consumed: 41_513,
      limit: 2_000_000,
      fraction: 41_513 / 2_000_000,
      state: "normal",
      blockingAnomalies: 0,
      responses: 1,
      turns: 1,
      admissionDenials: 0,
    },
  })}\n`)
  writeFileSync(join(codexDir, "run-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    runId: "engine-run",
    task: "pr_opened",
  })}\n`)
  writePreparedFinalizedReviewPublication(join(codexDir, "prepared-review-publication.json"), {
    repository: preparedTarget.repository,
    prNumber: preparedTarget.prNumber,
    marker: preparedTarget.marker,
    bundle,
    idempotencyKey,
  })
  const runtimePath = join(staging, "runtime-snapshot.json")
  const runtime = writeWorkflowRuntimeSnapshot({
    BOT_WORKDIR: workdir,
    BOT_TASK: "pr_opened",
    BOT_REPO: repository,
    BOT_PR_NUMBER: String(prNumber),
    BOT_HEAD_SHA: headSha,
    BOT_LOGIN: botLogin,
    BOT_RUN_ID: "engine-run",
    GITHUB_RUN_ID: "github-run",
    GITHUB_RUN_ATTEMPT: "2",
    CCHP_RUNTIME_SNAPSHOT_PATH: runtimePath,
  })
  const env = {
    GH_TOKEN: "workflow-token",
    BOT_WORKDIR: workdir,
    BOT_TASK: "pr_opened",
    BOT_REPO: repository,
    GH_REPO: repository,
    BOT_PR_NUMBER: String(prNumber),
    BOT_HEAD_SHA: headSha,
    BOT_LOGIN: botLogin,
    BOT_RUN_ID: "engine-run",
    GITHUB_RUN_ID: "github-run",
    GITHUB_RUN_ATTEMPT: "2",
    CCHP_RUNTIME_SNAPSHOT_PATH: runtime.path,
    CCHP_RUNTIME_SNAPSHOT_SHA256: runtime.sha256,
    CCHP_PROGRESS_PUBLICATION_PATH: join(staging, "progress-publication.json"),
    CCHP_REVIEW_PUBLICATION_PATH: join(staging, "review-publication.json"),
    CCHP_WORKFLOW_FINALIZATION_PATH: join(staging, "workflow-finalization.json"),
    CCHP_WRITE_OUTCOME: "skipped",
    CCHP_NEEDS_WRITE: "false",
    CCHP_INSTALL_OUTCOME: "success",
    CCHP_PREPARE_OUTCOME: "success",
    CCHP_SCAN_OUTCOME: "success",
    CCHP_CAPABILITY_OUTCOME: "success",
    CCHP_SUPERVISOR_OUTCOME: "success",
    CCHP_LIFECYCLE_STAGING_OUTCOME: "success",
    CCHP_LIFECYCLE_EVIDENCE_OUTCOME: "success",
    CCHP_VERIFY_LIFECYCLE_OUTCOME: "success",
    CCHP_UPLOAD_LIFECYCLE_OUTCOME: "success",
    CCHP_VERIFY_UPLOADED_LIFECYCLE_OUTCOME: "success",
    CCHP_LIFECYCLE_ROUNDTRIP_STAGING_OUTCOME: "success",
    CCHP_DOWNLOAD_LIFECYCLE_OUTCOME: "success",
    CCHP_VERIFY_DOWNLOADED_LIFECYCLE_OUTCOME: "success",
    CCHP_RUNTIME_SNAPSHOT_OUTCOME: "success",
    CCHP_ENVIRONMENT_CLEANUP_OUTCOME: "success",
    CCHP_FINALIZER_OUTCOME: "success",
    CCHP_FINAL_CANDIDATE_REQUIRED: "true",
    CCHP_FINAL_LIFECYCLE_STAGING_OUTCOME: "success",
    CCHP_FINAL_LIFECYCLE_EVIDENCE_OUTCOME: "success",
    CCHP_VERIFY_FINAL_LIFECYCLE_OUTCOME: "success",
    CCHP_UPLOAD_FINAL_LIFECYCLE_OUTCOME: "success",
    CCHP_VERIFY_UPLOADED_FINAL_LIFECYCLE_OUTCOME: "success",
    CCHP_FINAL_LIFECYCLE_ROUNDTRIP_STAGING_OUTCOME: "success",
    CCHP_DOWNLOAD_FINAL_LIFECYCLE_OUTCOME: "success",
    CCHP_VERIFY_DOWNLOADED_FINAL_LIFECYCLE_OUTCOME: "success",
    CCHP_JOB_CANCELLED: "false",
  }
  rmSync(workdir, { recursive: true })
  expect(existsSync(workdir)).toBeFalse()
  return { fixtureRoot, staging, env }
}

test("publishes a prepared finalized review after workdir cleanup and reruns idempotently", async () => {
  const fixture = preparedFixture()
  const github = fakeAuthoritativeGitHub()

  expect(await finalizeWorkflowProgress(fixture.env, github.octokit)).toBe("skipped")
  expect(github.calls.createReview).toHaveLength(1)
  expect(github.calls.updateComment).toHaveLength(1)
  expect(github.calls.createComment).toHaveLength(0)
  expect(github.calls.deleteComment).toHaveLength(0)
  expect(String(github.calls.createReview[0]!.body)).toContain(`cchp-review-publication:${idempotencyKey}`)
  expect(String(github.comments[0]!.body)).toContain("<!-- cchp-bot:review-summary -->")
  expect(String(github.comments[0]!.body)).not.toContain(progressMarker)
  expect(JSON.parse(readFileSync(fixture.env.CCHP_REVIEW_PUBLICATION_PATH, "utf8"))).toMatchObject({
    phase: "complete",
    summaryCommentId: 9,
    summaryAction: "updated",
  })
  expect(readProgressPublicationSnapshot(fixture.env.CCHP_PROGRESS_PUBLICATION_PATH, progressMarker)!.record).toMatchObject({
    publication: "published",
    commentId: 9,
    action: "updated",
    createdCount: 0,
    updatedCount: 1,
    finalized: true,
  })
  expect(readWorkflowFinalization(fixture.env.CCHP_WORKFLOW_FINALIZATION_PATH).record).toMatchObject({
    resolvedState: "SUCCEEDED",
    reasonCode: "supervisor_succeeded",
    publication: "published",
    commentId: 9,
    action: "updated",
  })

  const counts = Object.fromEntries(Object.entries(github.calls).map(([key, value]) => [key, value.length]))
  expect(await finalizeWorkflowProgress(fixture.env, github.octokit)).toBe("skipped")
  expect(Object.fromEntries(Object.entries(github.calls).map(([key, value]) => [key, value.length]))).toEqual(counts)
  expect(readProgressPublicationSnapshot(fixture.env.CCHP_PROGRESS_PUBLICATION_PATH, progressMarker)!.record).toMatchObject({
    createdCount: 0,
    updatedCount: 1,
    finalized: true,
  })
})

test("rejects runtime snapshot hash drift before any GitHub mutation", async () => {
  const fixture = preparedFixture()
  const github = fakeAuthoritativeGitHub()
  writeFileSync(
    fixture.env.CCHP_RUNTIME_SNAPSHOT_PATH,
    `${readFileSync(fixture.env.CCHP_RUNTIME_SNAPSHOT_PATH, "utf8")} `,
  )

  await expect(finalizeWorkflowProgress(fixture.env, github.octokit)).rejects.toThrow("runtime snapshot hash mismatch")
  expect(Object.values(github.calls).flat()).toHaveLength(0)
  expect(existsSync(fixture.env.CCHP_PROGRESS_PUBLICATION_PATH)).toBeFalse()
})

test("rejects a prepared review bound to a different workflow target before any GitHub mutation", async () => {
  const otherRepository = "CCH-HQ/other"
  const fixture = preparedFixture({
    repository: otherRepository,
    prNumber: 99,
    marker: { ...marker, repository: otherRepository, pr_number: 99 },
  })
  const github = fakeAuthoritativeGitHub()

  await expect(finalizeWorkflowProgress(fixture.env, github.octokit)).rejects.toThrow(
    "missing prepared or published review evidence",
  )
  expect(Object.values(github.calls).flat()).toHaveLength(0)
})

test("rejects credential material before creating a prepared review payload", () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-prepared-review-secret-"))
  const path = join(root, "prepared-review-publication.json")
  const secret = "fixture-workflow-token"

  expect(() => writePreparedFinalizedReviewPublication(path, {
    repository,
    prNumber,
    marker,
    bundle: { ...bundle, report: `do not publish ${secret}` },
    idempotencyKey,
    forbiddenValues: () => [secret],
  })).toThrow("prepared finalized review contains credential material")
  expect(existsSync(path)).toBeFalse()
  expect(existsSync(join(root, "runtime-snapshot.json"))).toBeFalse()
})

test("blocks finalized review publication when final artifact transport fails", async () => {
  const fixture = preparedFixture()
  const github = fakeAuthoritativeGitHub()
  const env = { ...fixture.env, CCHP_UPLOAD_FINAL_LIFECYCLE_OUTCOME: "failure" }

  expect(await finalizeWorkflowProgress(env, github.octokit)).toBe("published")
  expect(github.calls.createReview).toHaveLength(0)
  expect(github.calls.createComment).toHaveLength(0)
  expect(github.calls.updateComment).toHaveLength(1)
  expect(github.calls.deleteComment).toHaveLength(0)
  expect(String(github.comments[0]!.body)).toContain("workflow lifecycle final_upload failure")
  expect(String(github.comments[0]!.body)).toContain(`<!-- ${progressMarker} -->`)
  expect(String(github.comments[0]!.body)).not.toContain("cchp-bot:review-summary")
  expect(String(github.comments[0]!.body)).not.toContain(`cchp-review-publication:${idempotencyKey}`)
  expect(existsSync(env.CCHP_REVIEW_PUBLICATION_PATH)).toBeFalse()
  expect(readWorkflowFinalization(env.CCHP_WORKFLOW_FINALIZATION_PATH).record).toMatchObject({
    resolvedState: "FAILED",
    reasonCode: "final_lifecycle_upload_failed",
    publication: "published",
  })
})
