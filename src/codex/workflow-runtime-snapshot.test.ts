import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChildGraph } from "./graph"
import { openRegularFileSnapshot } from "./file-snapshot"
import { recordProgressPublication } from "./progress-publication"
import { readWorkflowRuntimeSnapshot, writeWorkflowRuntimeSnapshot } from "./workflow-runtime-snapshot"

function fixture(): { root: string; codex: string; staging: string } {
  const root = mkdtempSync(join(tmpdir(), "cchp-runtime-snapshot-"))
  const codex = join(root, "ctx", "codex")
  const staging = mkdtempSync(join(tmpdir(), "cchp-runtime-staging-"))
  mkdirSync(codex, { recursive: true })
  return { root, codex, staging }
}

test("captures immutable sanitized runtime evidence before workdir cleanup", () => {
  const { root, codex, staging } = fixture()
  const secret = "fixture-provider-secret"
  const terminalPath = join(codex, "terminal.json")
  writeFileSync(terminalPath, `${JSON.stringify({
    state: "SUCCEEDED",
    exitCode: 0,
    rootThreadId: "root-thread-sensitive",
    rootTurnId: "root-turn-sensitive",
    terminalReason: `provider_api_key=${secret}`,
    usage: {
      acceptedRaw: true,
      consumed: 123,
      limit: 1_000,
      fraction: 0.123,
      state: "normal",
      blockingAnomalies: 2,
      responses: 7,
      turns: 3,
      admissionDenials: 1,
    },
  })}\n`)
  writeFileSync(join(codex, "todo.json"), `${JSON.stringify({
    schemaVersion: 1,
    revision: 9,
    rootThreadId: "root-thread-sensitive",
    updatedAt: new Date().toISOString(),
    todos: [
      { content: `do not publish ${secret}`, status: "completed" },
      { content: "private prompt content", status: "in_progress" },
    ],
  })}\n`)
  const graph = new ChildGraph(join(codex, "graph.jsonl"))
  graph.open("root-thread-sensitive", "child-output-sensitive", "spawn-sensitive", "explicit_child")
  graph.close("child-output-sensitive", "completed")
  recordProgressPublication({ BOT_WORKDIR: root }, "cchp-bot:progress:ci_fix", {
    id: 44,
    action: "updated",
    htmlUrl: "https://example.invalid/44",
  }, true)
  writeFileSync(join(codex, "run-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    runId: "actual-engine-run-7",
    task: "ci_fix",
  }))

  const path = join(staging, "runtime-snapshot.json")
  const written = writeWorkflowRuntimeSnapshot({
    BOT_WORKDIR: root,
    BOT_TASK: "ci_fix",
    BOT_RUN_ID: "engine-run-7",
    GITHUB_RUN_ID: "github-run-8",
    GITHUB_RUN_ATTEMPT: "3",
    CCHP_RUNTIME_SNAPSHOT_PATH: path,
    CCHP_TEST_SECRET: secret,
  })
  expect(written.path).toBe(path)
  expect(written.sha256).toBe(openRegularFileSnapshot(path).sha256)

  const serialized = readFileSync(path, "utf8")
  expect(serialized).not.toContain(secret)
  expect(serialized).not.toContain("private prompt content")
  expect(serialized).not.toContain("root-thread-sensitive")
  expect(serialized).not.toContain("child-output-sensitive")
  const snapshot = readWorkflowRuntimeSnapshot(path, written.sha256, {
    BOT_TASK: "ci_fix",
    BOT_RUN_ID: "engine-run-7",
    GITHUB_RUN_ID: "github-run-8",
    GITHUB_RUN_ATTEMPT: "3",
  })
  expect(snapshot.identity).toMatchObject({ engineRunId: "actual-engine-run-7", githubRunAttempt: "3" })
  expect(snapshot.terminal).toMatchObject({
    ledger: "valid",
    sha256: openRegularFileSnapshot(terminalPath).sha256,
    record: {
      state: "SUCCEEDED",
      rootThreadPresent: true,
      rootTurnPresent: true,
      usage: { consumed: 123, responses: 7, turns: 3, blockingAnomalies: 2, admissionDenials: 1 },
    },
  })
  expect(snapshot.progress).toMatchObject({ ledger: "valid", record: { commentId: 44, finalized: true } })
  expect(snapshot.todo).toEqual({ ledger: "valid", revision: 9, total: 2, completed: 1, in_progress: 1, pending: 0, cancelled: 0 })
  expect(snapshot.children).toMatchObject({
    ledger: "valid",
    total: 1,
    open: 0,
    closed: 1,
    by_transport: { native_v2: 0, explicit_child: 1 },
    by_terminal_state: { completed: 1 },
  })

  rmSync(root, { recursive: true })
  expect(readWorkflowRuntimeSnapshot(path, written.sha256, { BOT_TASK: "ci_fix", GITHUB_RUN_ID: "github-run-8", GITHUB_RUN_ATTEMPT: "3" }))
    .toMatchObject({ terminal: { ledger: "valid" }, todo: { revision: 9 }, children: { total: 1 } })
})

test("rejects snapshot hash and run identity drift", () => {
  const { root, codex, staging } = fixture()
  writeFileSync(join(codex, "terminal.json"), JSON.stringify({
    state: "FAILED",
    exitCode: 1,
    usage: { consumed: 1, limit: 10 },
  }))
  const { path, sha256 } = writeWorkflowRuntimeSnapshot({
    BOT_WORKDIR: root,
    BOT_TASK: "manual",
    BOT_RUN_ID: "run-1",
    GITHUB_RUN_ID: "100",
    CCHP_RUNTIME_SNAPSHOT_PATH: join(staging, "runtime-snapshot.json"),
  })
  expect(() => readWorkflowRuntimeSnapshot(path, "0".repeat(64))).toThrow("hash mismatch")
  expect(() => readWorkflowRuntimeSnapshot(path, sha256, { BOT_TASK: "engage" })).toThrow("identity task mismatch")
  expect(() => readWorkflowRuntimeSnapshot(path, sha256, { BOT_TASK: "manual", CCHP_ENGINE_RUN_ID: "run-2" })).toThrow("identity engineRunId mismatch")
})

test("captures only hashes and identities for a complete finalized review summary", () => {
  const { root, codex, staging } = fixture()
  const body = "private finalized review body"
  const formalBody = "private finalized formal review body"
  const marker = "cchp-review-report:abcdef:1-of-1"
  writeFileSync(join(codex, "terminal.json"), JSON.stringify({
    state: "SUCCEEDED",
    exitCode: 0,
    usage: { consumed: 1, limit: 10 },
  }))
  writeFileSync(join(codex, "review-publication.json"), JSON.stringify({
    schemaVersion: 2,
    phase: "complete",
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    headSha: "head-sha",
    summaryCommentId: 9,
    summaryAction: "updated",
    summaryParts: [{ commentId: 9, marker, sha256: createHash("sha256").update(body).digest("hex") }],
    inlineComments: [],
    formalReview: {
      reviewId: 500,
      commitId: "head-sha",
      state: "COMMENTED",
      bodySha256: createHash("sha256").update(formalBody).digest("hex"),
    },
  }))
  const written = writeWorkflowRuntimeSnapshot({
    BOT_WORKDIR: root,
    BOT_TASK: "pr_opened",
    BOT_REPO: "CCH-HQ/fixture",
    BOT_PR_NUMBER: "42",
    BOT_HEAD_SHA: "head-sha",
    BOT_LOGIN: "bot[bot]",
    BOT_RUN_ID: "run-review",
    GITHUB_RUN_ID: "101",
    CCHP_RUNTIME_SNAPSHOT_PATH: join(staging, "runtime-snapshot.json"),
  })
  const serialized = readFileSync(written.path, "utf8")
  expect(serialized).not.toContain(body)
  expect(serialized).not.toContain(formalBody)
  expect(readWorkflowRuntimeSnapshot(written.path, written.sha256).reviewSummary).toEqual({
    ledger: "valid",
    repository: "CCH-HQ/fixture",
    prNumber: 42,
    headSha: "head-sha",
    ownerLogin: "bot[bot]",
    primaryCommentId: 9,
    parts: [{ commentId: 9, marker, sha256: createHash("sha256").update(body).digest("hex") }],
    inlineComments: [],
    formalReview: {
      reviewId: 500,
      commitId: "head-sha",
      state: "COMMENTED",
      bodySha256: createHash("sha256").update(formalBody).digest("hex"),
    },
  })
})
