import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GitHubClient } from "../github/client"
import { finalizeWorkflowProgress, readSupervisorTerminal, resolveWorkflowTerminal, workflowStepOutcomes } from "./finalize-workflow-progress"
import { readProgressPublicationSnapshot, recordProgressPublication } from "./progress-publication"
import { readWorkflowFinalization } from "./workflow-finalization"
import { writeWorkflowRuntimeSnapshot } from "./workflow-runtime-snapshot"

const finalizedFormalBody = "finalized formal review"
const finalizedFormalReview = {
  reviewId: 500,
  commitId: "head",
  state: "COMMENTED",
  bodySha256: createHash("sha256").update(finalizedFormalBody).digest("hex"),
}

const successfulPrerequisites = {
  write: "skipped",
  needsWrite: false,
  install: "success",
  prepare: "success",
  scan: "success",
  capability: "success",
  supervisor: "failure",
  cancelled: false,
}

test("maps every pre-supervisor failure to a terminal workflow result", () => {
  for (const [step, reason] of [
    ["install", "Codex setup failure"],
    ["prepare", "environment preparation failure"],
    ["scan", "external static analysis failure"],
    ["capability", "Codex capability gate failure"],
  ] as const) {
    const outcomes = { ...successfulPrerequisites, [step]: "failure" }
    for (const prior of ["install", "prepare", "scan", "capability"] as const) {
      if (prior === step) break
      outcomes[prior] = "success"
    }
    expect(resolveWorkflowTerminal(outcomes)).toMatchObject({ state: "FAILED", terminalReason: reason })
  }
  expect(resolveWorkflowTerminal({ ...successfulPrerequisites, scan: "cancelled", cancelled: true }))
    .toMatchObject({ state: "CANCELLED", terminalReason: "workflow scan step was cancelled" })
  expect(resolveWorkflowTerminal({ ...successfulPrerequisites, write: "failure", needsWrite: true }))
    .toMatchObject({ state: "FAILED", terminalReason: "write credential setup failure" })
})

test("reconciles a post-supervisor lifecycle failure to FAILED", () => {
  expect(resolveWorkflowTerminal({
    ...successfulPrerequisites,
    supervisor: "success",
    lifecycle: { evidence: "success", verify: "success", upload: "failure" },
  })).toMatchObject({ state: "FAILED", terminalReason: "workflow lifecycle upload failure" })
})

test("assigns a stable reason code to every route-post lifecycle failure", () => {
  const cases = [
    ["staging", "lifecycle_staging_failed"],
    ["evidence", "lifecycle_evidence_failed"],
    ["verify", "lifecycle_verify_failed"],
    ["upload", "lifecycle_upload_failed"],
    ["uploaded_digest", "lifecycle_uploaded_digest_failed"],
    ["roundtrip_staging", "lifecycle_roundtrip_staging_failed"],
    ["download", "lifecycle_download_failed"],
    ["downloaded_digest", "lifecycle_downloaded_digest_failed"],
    ["runtime_snapshot", "runtime_snapshot_failed"],
    ["environment_cleanup", "environment_cleanup_failed"],
    ["final_staging", "final_lifecycle_staging_failed"],
    ["final_evidence", "final_lifecycle_evidence_failed"],
    ["final_verify", "final_lifecycle_verify_failed"],
    ["final_upload", "final_lifecycle_upload_failed"],
    ["final_uploaded_digest", "final_lifecycle_uploaded_digest_failed"],
    ["final_roundtrip_staging", "final_lifecycle_roundtrip_staging_failed"],
    ["final_download", "final_lifecycle_download_failed"],
    ["final_downloaded_digest", "final_lifecycle_downloaded_digest_failed"],
    ["invalid_primary_cleanup_token", "invalid_artifact_cleanup_token_failed"],
    ["invalid_final_cleanup_token", "invalid_artifact_cleanup_token_failed"],
    ["invalid_primary_cleanup", "invalid_primary_artifact_cleanup_failed"],
    ["invalid_final_cleanup", "invalid_final_artifact_cleanup_failed"],
    ["progress_finalizer", "progress_finalizer_failed"],
  ] as const
  for (const [step, reasonCode] of cases) {
    expect(resolveWorkflowTerminal({
      ...successfulPrerequisites,
      supervisor: "success",
      lifecycle: { [step]: "failure" },
    })).toMatchObject({
      state: "FAILED",
      reasonCode,
      terminalReason: `workflow lifecycle ${step} failure`,
    })
  }
})

test("prioritizes invalid artifact cleanup failure over the transport error that made it invalid", () => {
  expect(resolveWorkflowTerminal({
    ...successfulPrerequisites,
    supervisor: "success",
    lifecycle: {
      uploaded_digest: "failure",
      invalid_primary_cleanup_token: "failure",
      invalid_primary_cleanup: "skipped",
    },
  })).toMatchObject({ state: "FAILED", reasonCode: "invalid_artifact_cleanup_token_failed" })
  expect(resolveWorkflowTerminal({
    ...successfulPrerequisites,
    supervisor: "success",
    lifecycle: {
      downloaded_digest: "failure",
      invalid_final_cleanup_token: "success",
      invalid_final_cleanup: "failure",
    },
  })).toMatchObject({ state: "FAILED", reasonCode: "invalid_final_artifact_cleanup_failed" })
})

test("uses the cleanup token outcome for the artifact phase that was actually invalid", () => {
  const primary = workflowStepOutcomes({
    CCHP_PRIMARY_ARTIFACT_INVALID: "true",
    CCHP_FINAL_ARTIFACT_INVALID: "false",
    CCHP_INVALID_PRIMARY_ARTIFACT_CLEANUP_TOKEN_OUTCOME: "success",
    CCHP_INVALID_FINAL_ARTIFACT_CLEANUP_TOKEN_OUTCOME: "skipped",
    CCHP_INVALID_PRIMARY_ARTIFACT_CLEANUP_OUTCOME: "success",
  })
  expect(primary.lifecycle).toMatchObject({
    invalid_primary_cleanup_token: "success",
    invalid_primary_cleanup: "success",
  })
  expect(primary.lifecycle).not.toHaveProperty("invalid_final_cleanup_token")

  const resolved = resolveWorkflowTerminal({
    ...successfulPrerequisites,
    supervisor: "success",
    lifecycle: { uploaded_digest: "failure", ...primary.lifecycle },
  })
  expect(resolved).toMatchObject({
    state: "FAILED",
    reasonCode: "lifecycle_uploaded_digest_failed",
  })
})

test("uses a valid supervisor terminal artifact and rejects malformed snapshots", () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-workflow-terminal-"))
  const path = join(root, "terminal.json")
  writeFileSync(path, JSON.stringify({
    state: "TOKEN_BUDGET_EXCEEDED",
    terminalReason: "token budget exceeded",
    usage: { consumed: 2_000_529, limit: 2_000_000 },
  }))
  const terminal = readSupervisorTerminal(path)
  expect(terminal).toMatchObject({
    state: "TOKEN_BUDGET_EXCEEDED",
    terminalReason: "token budget exceeded",
    usage: { consumed: 2_000_529, limit: 2_000_000 },
  })
  if (!terminal) throw new Error("expected terminal fixture")
  expect(resolveWorkflowTerminal(successfulPrerequisites, terminal)).toMatchObject({
    ...terminal,
    reasonCode: "token_budget_exceeded",
  })
  writeFileSync(path, '{"state":"ROOT_RUNNING","usage":{"consumed":1,"limit":2}}')
  expect(readSupervisorTerminal(path)).toBeUndefined()
  writeFileSync(path, '{"state":"SUCCEEDED","usage":{"consumed":"secret","limit":1}}')
  expect(readSupervisorTerminal(path)).toBeUndefined()
})

test("does not trust a successful artifact when the supervisor wrapper failed", () => {
  const usage = {
    acceptedRaw: false,
    consumed: 42,
    limit: 100,
    fraction: 0.42,
    state: "normal" as const,
    blockingAnomalies: 0,
    responses: 1,
    turns: 1,
    admissionDenials: 0,
  }
  expect(resolveWorkflowTerminal(successfulPrerequisites, {
    state: "SUCCEEDED",
    terminalReason: "done",
    usage,
  })).toMatchObject({
    state: "FAILED",
    terminalReason: "Codex supervisor wrapper failed after the runtime reported success",
    usage: { consumed: 42, limit: 100 },
  })
})

test("reconciles the supervisor terminal from trusted staging after cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-workflow-cleanup-"))
  const codex = join(root, "ctx", "codex")
  const staging = mkdtempSync(join(tmpdir(), "cchp-workflow-cleanup-staging-"))
  mkdirSync(codex, { recursive: true })
  writeFileSync(join(codex, "terminal.json"), JSON.stringify({
    state: "SUCCEEDED",
    exitCode: 0,
    rootThreadId: "root-thread",
    rootTurnId: "root-turn",
    usage: { consumed: 81, limit: 1_000, responses: 4, turns: 2 },
  }))
  const runtime = writeWorkflowRuntimeSnapshot({
    BOT_WORKDIR: root,
    BOT_TASK: "manual",
    BOT_RUN_ID: "run-cleanup",
    GITHUB_RUN_ID: "9002",
    CCHP_RUNTIME_SNAPSHOT_PATH: join(staging, "runtime-snapshot.json"),
  })
  rmSync(root, { recursive: true })
  const finalizationPath = join(staging, "workflow-finalization.json")
  expect(await finalizeWorkflowProgress({
    BOT_WORKDIR: root,
    BOT_TASK: "manual",
    BOT_RUN_ID: "run-cleanup",
    GITHUB_RUN_ID: "9002",
    CCHP_RUNTIME_SNAPSHOT_PATH: runtime.path,
    CCHP_RUNTIME_SNAPSHOT_SHA256: runtime.sha256,
    CCHP_PROGRESS_PUBLICATION_PATH: join(staging, "progress-publication.json"),
    CCHP_WORKFLOW_FINALIZATION_PATH: finalizationPath,
    CCHP_WRITE_OUTCOME: "skipped",
    CCHP_INSTALL_OUTCOME: "success",
    CCHP_PREPARE_OUTCOME: "success",
    CCHP_SCAN_OUTCOME: "success",
    CCHP_CAPABILITY_OUTCOME: "success",
    CCHP_SUPERVISOR_OUTCOME: "success",
    CCHP_RUNTIME_SNAPSHOT_OUTCOME: "success",
  }, {} as GitHubClient)).toBe("skipped")
  expect(readWorkflowFinalization(finalizationPath).record).toMatchObject({
    terminalSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    resolvedState: "SUCCEEDED",
    reasonCode: "supervisor_succeeded",
    publication: "skipped",
  })
  expect(existsSync(root)).toBeFalse()
})

test("seeds post-cleanup publication evidence from the snapshotted counters", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-workflow-publication-seed-"))
  const codex = join(root, "ctx", "codex")
  const staging = mkdtempSync(join(tmpdir(), "cchp-workflow-publication-staging-"))
  mkdirSync(codex, { recursive: true })
  writeFileSync(join(codex, "terminal.json"), JSON.stringify({
    state: "FAILED",
    exitCode: 1,
    usage: { consumed: 81, limit: 1_000 },
  }))
  recordProgressPublication({ BOT_WORKDIR: root }, "cchp-bot:progress:engage", {
    id: 9,
    action: "created",
    htmlUrl: "https://example.invalid/9",
  }, true)
  const runtime = writeWorkflowRuntimeSnapshot({
    BOT_WORKDIR: root,
    BOT_TASK: "engage",
    BOT_RUN_ID: "run-seed",
    GITHUB_RUN_ID: "9003",
    CCHP_RUNTIME_SNAPSHOT_PATH: join(staging, "runtime-snapshot.json"),
  })
  rmSync(root, { recursive: true })
  const listComments = Object.assign(() => {}, { tag: "comments" })
  const octokit = {
    rest: {
      issues: {
        listComments,
        updateComment: async () => ({ data: { id: 9, html_url: "https://example.invalid/9" } }),
      },
    },
    paginate: async () => [{ id: 9, body: "old\n<!-- cchp-bot:progress:engage -->", user: { login: "bot[bot]" } }],
  } as unknown as GitHubClient
  const progressPath = join(staging, "progress-publication.json")
  expect(await finalizeWorkflowProgress({
    GH_TOKEN: "fixture",
    GH_REPO: "CCH-HQ/fixture",
    BOT_REPO: "CCH-HQ/fixture",
    BOT_LOGIN: "bot[bot]",
    BOT_TASK: "engage",
    BOT_ISSUE_NUMBER: "9",
    BOT_WORKDIR: root,
    BOT_RUN_ID: "run-seed",
    GITHUB_RUN_ID: "9003",
    CCHP_RUNTIME_SNAPSHOT_PATH: runtime.path,
    CCHP_RUNTIME_SNAPSHOT_SHA256: runtime.sha256,
    CCHP_PROGRESS_PUBLICATION_PATH: progressPath,
    CCHP_WORKFLOW_FINALIZATION_PATH: join(staging, "workflow-finalization.json"),
    CCHP_WRITE_OUTCOME: "skipped",
    CCHP_INSTALL_OUTCOME: "success",
    CCHP_PREPARE_OUTCOME: "success",
    CCHP_SCAN_OUTCOME: "success",
    CCHP_CAPABILITY_OUTCOME: "success",
    CCHP_SUPERVISOR_OUTCOME: "failure",
    CCHP_RUNTIME_SNAPSHOT_OUTCOME: "success",
  }, octokit)).toBe("published")
  expect(readProgressPublicationSnapshot(progressPath, "cchp-bot:progress:engage")!.record).toMatchObject({
    commentId: 9,
    action: "updated",
    createdCount: 1,
    updatedCount: 1,
    finalized: true,
    publication: "published",
  })
  expect(existsSync(root)).toBeFalse()
})

test("updates an existing live sticky after a capability gate failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-workflow-finalizer-"))
  mkdirSync(join(root, "ctx", "codex"), { recursive: true })
  const calls: Array<Record<string, unknown>> = []
  const listComments = Object.assign(() => {}, { tag: "comments" })
  const octokit = {
    rest: {
      pulls: {
        get: async () => ({ data: { state: "open", merged: false, merged_at: null, head: { sha: "head" } } }),
      },
      issues: {
        listComments,
        updateComment: async (args: Record<string, unknown>) => {
          calls.push(args)
          return { data: { id: 9, html_url: "https://example.invalid/comment/9" } }
        },
      },
    },
    paginate: async () => [{ id: 9, body: "Live progress\n<!-- cchp-bot:progress:pr_opened -->", user: { login: "bot[bot]" } }],
  } as unknown as GitHubClient
  const result = await finalizeWorkflowProgress({
    GH_TOKEN: "fixture",
    GH_REPO: "CCH-HQ/fixture",
    BOT_REPO: "CCH-HQ/fixture",
    BOT_LOGIN: "bot[bot]",
    BOT_TASK: "pr_opened",
    BOT_WORKDIR: root,
    BOT_PR_NUMBER: "42",
    BOT_HEAD_SHA: "head",
    GITHUB_RUN_ID: "123",
    CCHP_WRITE_OUTCOME: "skipped",
    CCHP_NEEDS_WRITE: "false",
    CCHP_INSTALL_OUTCOME: "success",
    CCHP_PREPARE_OUTCOME: "success",
    CCHP_SCAN_OUTCOME: "success",
    CCHP_CAPABILITY_OUTCOME: "failure",
    CCHP_SUPERVISOR_OUTCOME: "skipped",
    CCHP_JOB_CANCELLED: "false",
  }, octokit)
  expect(result).toBe("published")
  expect(calls).toHaveLength(1)
  expect(String(calls[0]!.body)).toContain("Run complete — `pr_opened`")
  expect(String(calls[0]!.body)).toContain("Codex capability gate failure")
  expect(String(calls[0]!.body)).toContain("<!-- cchp-bot:progress:pr_opened -->")
})

test("does not overwrite a successful finalized review summary", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-workflow-finalizer-success-"))
  mkdirSync(join(root, "ctx", "codex"), { recursive: true })
  writeFileSync(join(root, "ctx", "codex", "terminal.json"), JSON.stringify({
    state: "SUCCEEDED",
    usage: { consumed: 42, limit: 2_000_000 },
  }))
  recordProgressPublication({ BOT_WORKDIR: root }, "cchp-bot:progress:pr_opened", {
    action: "updated",
    id: 9,
    htmlUrl: "https://example.invalid/comment/9",
  }, true)
  const summaryMarker = "cchp-review-report:fixture-key:1-of-1"
  const summaryBody = `summary\n<!-- cchp-bot:review-summary -->\n<!-- ${summaryMarker} -->`
  writeFileSync(join(root, "ctx", "codex", "review-publication.json"), JSON.stringify({
    schemaVersion: 2,
    phase: "complete",
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    headSha: "head",
    summaryCommentId: 9,
    summaryAction: "updated",
    summaryParts: [{ commentId: 9, marker: summaryMarker, sha256: createHash("sha256").update(summaryBody).digest("hex") }],
    inlineComments: [],
    formalReview: finalizedFormalReview,
  }))
  const staging = join(root, "trusted")
  mkdirSync(staging, { recursive: true })
  const runtime = writeWorkflowRuntimeSnapshot({
    BOT_WORKDIR: root,
    BOT_TASK: "pr_opened",
    BOT_REPO: "CCH-HQ/fixture",
    BOT_PR_NUMBER: "42",
    BOT_HEAD_SHA: "head",
    BOT_LOGIN: "bot[bot]",
    BOT_RUN_ID: "run-success",
    GITHUB_RUN_ID: "123",
    CCHP_RUNTIME_SNAPSHOT_PATH: join(staging, "runtime-snapshot.json"),
  })
  const finalizationPath = join(staging, "workflow-finalization.json")
  const listComments = Object.assign(() => {}, { tag: "comments" })
  const listReviewComments = Object.assign(() => {}, { tag: "reviewComments" })
  const listReviews = Object.assign(() => {}, { tag: "reviews" })
  const octokit = {
    rest: {
      pulls: {
        get: async () => ({ data: { state: "open", merged: false, merged_at: null, head: { sha: "head" } } }),
        listReviewComments,
        listReviews,
      },
      issues: { listComments },
    },
    paginate: async (fn: { tag: string }) => fn.tag === "comments"
      ? [{ id: 9, body: summaryBody, user: { login: "bot[bot]" } }]
      : fn.tag === "reviews"
        ? [{ id: 500, body: finalizedFormalBody, state: "COMMENTED", commit_id: "head", user: { login: "bot[bot]" } }]
        : [],
  } as unknown as GitHubClient
  expect(await finalizeWorkflowProgress({
    GH_TOKEN: "fixture",
    BOT_REPO: "CCH-HQ/fixture",
    BOT_PR_NUMBER: "42",
    BOT_HEAD_SHA: "head",
    BOT_LOGIN: "bot[bot]",
    BOT_TASK: "pr_opened",
    BOT_WORKDIR: root,
    GITHUB_RUN_ID: "123",
    CCHP_RUNTIME_SNAPSHOT_PATH: runtime.path,
    CCHP_RUNTIME_SNAPSHOT_SHA256: runtime.sha256,
    CCHP_WRITE_OUTCOME: "skipped",
    CCHP_NEEDS_WRITE: "false",
    CCHP_INSTALL_OUTCOME: "success",
    CCHP_PREPARE_OUTCOME: "success",
    CCHP_SCAN_OUTCOME: "success",
    CCHP_CAPABILITY_OUTCOME: "success",
    CCHP_SUPERVISOR_OUTCOME: "success",
    CCHP_JOB_CANCELLED: "false",
    CCHP_WORKFLOW_FINALIZATION_PATH: finalizationPath,
  }, octokit)).toBe("skipped")
  expect(readWorkflowFinalization(finalizationPath).record).toMatchObject({
    resolvedState: "SUCCEEDED",
    publication: "published",
    commentId: 9,
    action: "updated",
  })
})

test("publishes metadata-only pr_opened success without finalized review evidence after cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-workflow-metadata-only-"))
  const codex = join(root, "ctx", "codex")
  const staging = mkdtempSync(join(tmpdir(), "cchp-workflow-metadata-only-staging-"))
  mkdirSync(codex, { recursive: true })
  writeFileSync(join(codex, "terminal.json"), JSON.stringify({
    state: "SUCCEEDED",
    exitCode: 0,
    rootThreadId: "root",
    rootTurnId: "turn",
    usage: { consumed: 41_513, limit: 2_000_000 },
  }))
  writeFileSync(join(codex, "run-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    runId: "run-metadata-only",
    task: "pr_opened",
  }))
  const runtime = writeWorkflowRuntimeSnapshot({
    BOT_WORKDIR: root,
    BOT_TASK: "pr_opened",
    BOT_SKIP_PR_INSPECT: "1",
    BOT_REPO: "CCH-HQ/fixture",
    BOT_PR_NUMBER: "42",
    BOT_HEAD_SHA: "head",
    BOT_LOGIN: "bot[bot]",
    BOT_RUN_ID: "run-metadata-only",
    GITHUB_RUN_ID: "125",
    CCHP_RUNTIME_SNAPSHOT_PATH: join(staging, "runtime-snapshot.json"),
  })
  rmSync(root, { recursive: true })
  const calls: Array<Record<string, unknown>> = []
  const listComments = Object.assign(() => {}, { tag: "comments" })
  const octokit = {
    rest: {
      pulls: {
        get: async () => ({ data: { state: "open", merged: false, merged_at: null, head: { sha: "head" } } }),
      },
      issues: {
        listComments,
        updateComment: async (args: Record<string, unknown>) => {
          calls.push(args)
          return { data: { id: 9, html_url: "https://example.invalid/comment/9" } }
        },
      },
    },
    paginate: async () => [{ id: 9, body: "Live progress\n<!-- cchp-bot:progress:pr_opened -->", user: { login: "bot[bot]" } }],
  } as unknown as GitHubClient
  const finalizationPath = join(staging, "workflow-finalization.json")

  expect(await finalizeWorkflowProgress({
    GH_TOKEN: "fixture",
    BOT_WORKDIR: root,
    BOT_TASK: "pr_opened",
    BOT_SKIP_PR_INSPECT: "1",
    BOT_REPO: "CCH-HQ/fixture",
    GH_REPO: "CCH-HQ/fixture",
    BOT_PR_NUMBER: "42",
    BOT_HEAD_SHA: "head",
    BOT_LOGIN: "bot[bot]",
    BOT_RUN_ID: "run-metadata-only",
    GITHUB_RUN_ID: "125",
    CCHP_RUNTIME_SNAPSHOT_PATH: runtime.path,
    CCHP_RUNTIME_SNAPSHOT_SHA256: runtime.sha256,
    CCHP_PROGRESS_PUBLICATION_PATH: join(staging, "progress-publication.json"),
    CCHP_WORKFLOW_FINALIZATION_PATH: finalizationPath,
    CCHP_WRITE_OUTCOME: "skipped",
    CCHP_NEEDS_WRITE: "false",
    CCHP_INSTALL_OUTCOME: "success",
    CCHP_PREPARE_OUTCOME: "success",
    CCHP_SCAN_OUTCOME: "success",
    CCHP_CAPABILITY_OUTCOME: "success",
    CCHP_SUPERVISOR_OUTCOME: "success",
    CCHP_RUNTIME_SNAPSHOT_OUTCOME: "success",
    CCHP_ENVIRONMENT_CLEANUP_OUTCOME: "success",
    CCHP_JOB_CANCELLED: "false",
  }, octokit)).toBe("published")
  expect(calls).toHaveLength(1)
  expect(String(calls[0]!.body)).toContain("Run complete — `pr_opened`")
  expect(String(calls[0]!.body)).toContain("**State:** `SUCCEEDED`")
  expect(String(calls[0]!.body)).toContain("<!-- cchp-bot:progress:pr_opened -->")
  expect(readWorkflowFinalization(finalizationPath).record).toMatchObject({
    resolvedState: "SUCCEEDED",
    reasonCode: "supervisor_succeeded",
    publication: "published",
  })
})

test("fails closed when a snapshotted finalized review fragment was deleted or edited remotely", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-workflow-finalizer-remote-drift-"))
  const codex = join(root, "ctx", "codex")
  const staging = join(root, "trusted")
  mkdirSync(codex, { recursive: true })
  mkdirSync(staging, { recursive: true })
  writeFileSync(join(codex, "terminal.json"), JSON.stringify({ state: "SUCCEEDED", usage: { consumed: 42, limit: 2_000_000 } }))
  recordProgressPublication({ BOT_WORKDIR: root }, "cchp-bot:progress:pr_opened", {
    action: "updated", id: 9, htmlUrl: "https://example.invalid/comment/9",
  }, true)
  const marker = "cchp-review-report:fixture-key:1-of-1"
  const expectedBody = `summary\n<!-- cchp-bot:review-summary -->\n<!-- ${marker} -->`
  writeFileSync(join(codex, "review-publication.json"), JSON.stringify({
    schemaVersion: 2,
    phase: "complete",
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    headSha: "head",
    summaryCommentId: 9,
    summaryAction: "updated",
    summaryParts: [{ commentId: 9, marker, sha256: createHash("sha256").update(expectedBody).digest("hex") }],
    inlineComments: [],
    formalReview: finalizedFormalReview,
  }))
  const runtime = writeWorkflowRuntimeSnapshot({
    BOT_WORKDIR: root,
    BOT_TASK: "pr_opened",
    BOT_REPO: "CCH-HQ/fixture",
    BOT_PR_NUMBER: "42",
    BOT_HEAD_SHA: "head",
    BOT_LOGIN: "bot[bot]",
    BOT_RUN_ID: "run-drift",
    GITHUB_RUN_ID: "124",
    CCHP_RUNTIME_SNAPSHOT_PATH: join(staging, "runtime-snapshot.json"),
  })
  const listComments = Object.assign(() => {}, { tag: "comments" })
  const listReviewComments = Object.assign(() => {}, { tag: "reviewComments" })
  const listReviews = Object.assign(() => {}, { tag: "reviews" })
  const octokit = {
    rest: {
      pulls: {
        get: async () => ({ data: { state: "open", merged: false, merged_at: null, head: { sha: "head" } } }),
        listReviewComments,
        listReviews,
      },
      issues: { listComments },
    },
    paginate: async (fn: { tag: string }) => fn.tag === "comments"
      ? [{ id: 9, body: `${expectedBody}\nmutated`, user: { login: "bot[bot]" } }]
      : fn.tag === "reviews"
        ? [{ id: 500, body: finalizedFormalBody, state: "COMMENTED", commit_id: "head", user: { login: "bot[bot]" } }]
        : [],
  } as unknown as GitHubClient
  await expect(finalizeWorkflowProgress({
    GH_TOKEN: "fixture",
    BOT_REPO: "CCH-HQ/fixture",
    BOT_PR_NUMBER: "42",
    BOT_HEAD_SHA: "head",
    BOT_LOGIN: "bot[bot]",
    BOT_TASK: "pr_opened",
    BOT_WORKDIR: root,
    GITHUB_RUN_ID: "124",
    CCHP_RUNTIME_SNAPSHOT_PATH: runtime.path,
    CCHP_RUNTIME_SNAPSHOT_SHA256: runtime.sha256,
    CCHP_WRITE_OUTCOME: "skipped",
    CCHP_INSTALL_OUTCOME: "success",
    CCHP_PREPARE_OUTCOME: "success",
    CCHP_SCAN_OUTCOME: "success",
    CCHP_CAPABILITY_OUTCOME: "success",
    CCHP_SUPERVISOR_OUTCOME: "success",
    CCHP_WORKFLOW_FINALIZATION_PATH: join(staging, "workflow-finalization.json"),
  }, octokit)).rejects.toThrow("summary part 1 is missing, duplicated, or stale")
})

test("fails closed when a successful finalized review lacks summary publication evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-workflow-finalizer-missing-summary-"))
  mkdirSync(join(root, "ctx", "codex"), { recursive: true })
  writeFileSync(join(root, "ctx", "codex", "terminal.json"), JSON.stringify({
    state: "SUCCEEDED",
    usage: { consumed: 42, limit: 2_000_000 },
  }))
  await expect(finalizeWorkflowProgress({
    GH_TOKEN: "fixture",
    BOT_TASK: "pr_opened",
    BOT_WORKDIR: root,
    CCHP_WRITE_OUTCOME: "skipped",
    CCHP_NEEDS_WRITE: "false",
    CCHP_INSTALL_OUTCOME: "success",
    CCHP_PREPARE_OUTCOME: "success",
    CCHP_SCAN_OUTCOME: "success",
    CCHP_CAPABILITY_OUTCOME: "success",
    CCHP_SUPERVISOR_OUTCOME: "success",
  }, {} as GitHubClient)).rejects.toThrow("requires a trusted runtime snapshot")
})

test("redacts credential material from a supervisor terminal before publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-workflow-redaction-"))
  mkdirSync(join(root, "ctx", "codex"), { recursive: true })
  writeFileSync(join(root, "ctx", "codex", "terminal.json"), JSON.stringify({
    state: "FAILED",
    terminalReason: "authorization=Bearer workflow-secret",
    usage: { consumed: 1, limit: 100 },
  }))
  const bodies: string[] = []
  const octokit = {
    rest: {
      issues: {
        listComments: Object.assign(() => {}, { tag: "comments" }),
        createComment: async (args: { body: string }) => {
          bodies.push(args.body)
          return { data: { id: 1, html_url: "https://example.invalid/comment/1" } }
        },
      },
    },
    paginate: async () => [],
  } as unknown as GitHubClient
  expect(await finalizeWorkflowProgress({
    GH_TOKEN: "workflow-secret",
    GH_REPO: "CCH-HQ/fixture",
    BOT_REPO: "CCH-HQ/fixture",
    BOT_LOGIN: "bot[bot]",
    BOT_TASK: "engage",
    BOT_WORKDIR: root,
    BOT_ISSUE_NUMBER: "7",
    CCHP_WRITE_OUTCOME: "skipped",
    CCHP_NEEDS_WRITE: "false",
    CCHP_INSTALL_OUTCOME: "success",
    CCHP_PREPARE_OUTCOME: "success",
    CCHP_SCAN_OUTCOME: "success",
    CCHP_CAPABILITY_OUTCOME: "success",
    CCHP_SUPERVISOR_OUTCOME: "failure",
  }, octokit)).toBe("published")
  expect(bodies).toHaveLength(1)
  expect(bodies[0]).toContain("authorization=[REDACTED]")
  expect(bodies[0]).not.toContain("workflow-secret")
})
