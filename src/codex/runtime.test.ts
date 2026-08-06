import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import {
  RUNTIME_ENV_KEYS,
  cleanupRuntimeResources,
  composeRuntimePrompt,
  configureGitRemote,
  createProgressPublisher,
  resolveRuntimeBrokerBindings,
  resolveRuntimePermission,
  resolveRuntimeRecovery,
  restoreRuntimeEnv,
  settleRuntimeOutcome,
  snapshotRuntimeEnv,
} from "./runtime"
import type { GitHubClient } from "../github/client"

test("maps the frozen route environment to the Codex thread permission profile", () => {
  expect(resolveRuntimePermission({
    BOT_TASK: "manual",
    BOT_CAN_WRITE: "1",
    BOT_PR_IS_FORK: "0",
  })).toMatchObject({ task: "manual", sandboxMode: "workspace-write", approvalPolicy: "never" })

  expect(resolveRuntimePermission({
    BOT_TASK: "pr_opened",
    BOT_CAN_WRITE: "1",
    BOT_PR_IS_FORK: "0",
  })).toMatchObject({ task: "pr_opened", sandboxMode: "read-only" })

  expect(resolveRuntimePermission({
    BOT_TASK: "manual",
    BOT_CAN_WRITE: "1",
    BOT_PR_IS_FORK: "1",
  })).toMatchObject({ task: "manual", sandboxMode: "read-only" })

  expect(() => resolveRuntimePermission({ BOT_TASK: "unknown" })).toThrow("unsupported BOT_TASK")
})

test("maps existing BOT_* target metadata to broker bindings without caller changes", () => {
  expect(resolveRuntimeBrokerBindings({
    BOT_TASK: "engage",
    BOT_ISSUE_NUMBER: "9",
    BOT_PLAN_COMMENT_ID: "77",
    BOT_ROADMAP_PROJECT: "1",
  })).toEqual({
    target: 9,
    targetKind: "issue",
    trustedCommentId: 77,
    roadmapProject: 1,
    workflowRunId: undefined,
    releaseTag: undefined,
  })
  expect(resolveRuntimeBrokerBindings({ BOT_TASK: "ci_fix", BOT_PR_NUMBER: "42", BOT_RUN_ID: "1234" }))
    .toMatchObject({ target: 42, targetKind: "pr", workflowRunId: 1234 })
  expect(resolveRuntimeBrokerBindings({ BOT_TASK: "release_notes", BOT_RELEASE_TAG: "v1.2.3" }))
    .toMatchObject({ releaseTag: "v1.2.3" })
  expect(() => resolveRuntimeBrokerBindings({ BOT_PR_NUMBER: "1", BOT_ISSUE_NUMBER: "2" }))
    .toThrow("exactly one trusted")
})

test("points git origin at the run-scoped loopback proxy without embedding credentials", () => {
  const repo = mkdtempSync(join(tmpdir(), "cchp-runtime-git-"))
  execFileSync("git", ["init", "-q"], { cwd: repo })
  execFileSync("git", ["remote", "add", "origin", "https://x-access-token:secret@github.com/CCH-HQ/fixture.git"], { cwd: repo })
  configureGitRemote(repo, "http://127.0.0.1:43123/CCH-HQ/fixture.git")
  expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: repo, encoding: "utf8" }).trim())
    .toBe("http://127.0.0.1:43123/CCH-HQ/fixture.git")
  expect(() => configureGitRemote(repo, "https://github.com/other/repo.git")).toThrow("refusing untrusted")
})

test("reuses the manifest run id and root ownership on a runtime process restart", () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-runtime-recovery-"))
  const codexDir = join(workdir, "ctx", "codex")
  mkdirSync(codexDir, { recursive: true })
  const startedAt = new Date(Date.now() - 1_000).toISOString()
  const wholeRunDeadlineAt = new Date(Date.now() + 10_000).toISOString()
  writeFileSync(join(codexDir, "run-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    runId: "persisted-run",
    task: "manual",
    state: "ROOT_RUNNING",
    rootThreadId: "root",
    rootTurnId: "turn",
    restartAttempts: 1,
    startedAt,
    wholeRunDeadlineAt,
    lastSemanticProgressAt: startedAt,
    updatedAt: new Date().toISOString(),
  })}\n`)

  expect(resolveRuntimeRecovery({}, workdir, "manual", () => "new-run")).toEqual({
    runId: "persisted-run",
    resume: {
      state: "ROOT_RUNNING",
      rootThreadId: "root",
      rootTurnId: "turn",
      restartAttempts: 1,
      rootSessionId: undefined,
      startedAt,
      wholeRunDeadlineAt,
      lastSemanticProgressAt: startedAt,
      drainDeadlineAt: undefined,
    },
  })
  expect(() => resolveRuntimeRecovery({ BOT_RUN_ID: "other-run" }, workdir, "manual", () => "new-run"))
    .toThrow(/run id mismatch/)
})

test("fails closed when durable ledgers exist without a run manifest", () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-runtime-orphan-"))
  const codexDir = join(workdir, "ctx", "codex")
  mkdirSync(codexDir, { recursive: true })
  writeFileSync(join(codexDir, "usage.jsonl"), "{}\n")
  expect(() => resolveRuntimeRecovery({}, workdir, "manual", () => "new-run"))
    .toThrow(/orphaned durable Codex state/)
})

test("binds the supervisor-owned progress publisher to the trusted repository and target", async () => {
  const calls: Array<Record<string, unknown>> = []
  const octokit = {
    rest: {
      issues: {
        listComments: async (args: Record<string, unknown>) => { calls.push({ operation: "list", ...args }); return [] },
        createComment: async (args: Record<string, unknown>) => {
          calls.push({ operation: "create", ...args })
          return { data: { id: 1, html_url: "https://example.invalid/comment/1" } }
        },
      },
    },
    paginate: async (fn: (args: Record<string, unknown>) => Promise<unknown>, args: Record<string, unknown>) => fn(args),
  } as unknown as GitHubClient
  const env: Record<string, string | undefined> = {
    BOT_REPO: "CCH-HQ/fixture",
    GH_REPO: "CCH-HQ/fixture",
    BOT_TASK: "pr_opened",
    BOT_PR_NUMBER: "42",
    BOT_PROGRESS_TARGET: "42",
    GH_TOKEN: "raw-token-that-will-be-deleted",
  }
  const publish = createProgressPublisher(env, octokit)
  expect(publish).toBeDefined()
  delete env.GH_TOKEN
  await publish!("working")
  expect(calls).toContainEqual(expect.objectContaining({
    operation: "create",
    owner: "CCH-HQ",
    repo: "fixture",
    issue_number: 42,
    body: expect.stringContaining("<!-- cchp-bot:progress:pr_opened -->"),
  }))
})

test("rejects progress repository and target drift before publishing", () => {
  const octokit = {} as GitHubClient
  expect(() => createProgressPublisher({
    BOT_REPO: "CCH-HQ/fixture",
    GH_REPO: "other/fixture",
    BOT_TASK: "pr_opened",
    BOT_PR_NUMBER: "42",
    BOT_PROGRESS_TARGET: "42",
  }, octokit)).toThrow(/repository/)
  expect(() => createProgressPublisher({
    BOT_REPO: "CCH-HQ/fixture",
    BOT_TASK: "pr_opened",
    BOT_PR_NUMBER: "42",
    BOT_PROGRESS_TARGET: "7",
  }, octokit)).toThrow(/target/)
  expect(() => createProgressPublisher({
    BOT_REPO: "CCH-HQ/fixture",
    BOT_TASK: "engage",
    BOT_ISSUE_NUMBER: "9",
    BOT_PROGRESS_TARGET: "10",
  }, octokit)).toThrow(/target/)
})

test("injects the complete review protocol only for pr_opened", () => {
  expect(composeRuntimePrompt({
    task: "pr_opened",
    instructionOverlay: "overlay",
    taskPrompt: "task",
    reviewProtocol: "agents.spawn_agent protocol",
  })).toContain("# Injected Ultra Code Review Protocol\nagents.spawn_agent protocol")
  expect(composeRuntimePrompt({
    task: "manual",
    instructionOverlay: "overlay",
    taskPrompt: "task",
  })).toBe("overlay\ntask")
  expect(() => composeRuntimePrompt({
    task: "pr_opened",
    instructionOverlay: "overlay",
    taskPrompt: "task",
  })).toThrow(/requires the Codex Ultra Code Review Protocol/)
})

test("runtime environment snapshot restores every credential and generated binding exactly", () => {
  const env = Object.fromEntries(RUNTIME_ENV_KEYS.map((key, index) => [key, index % 2 === 0 ? `original-${key}` : undefined])) as Record<string, string | undefined>
  const snapshot = snapshotRuntimeEnv(env)
  for (const key of RUNTIME_ENV_KEYS) env[key] = `mutated-${key}`
  restoreRuntimeEnv(snapshot, env)
  for (const [index, key] of RUNTIME_ENV_KEYS.entries()) {
    expect(env[key]).toBe(index % 2 === 0 ? `original-${key}` : undefined)
  }
})

test("runtime resource cleanup is per-resource bounded and never skips later resources", async () => {
  const called: string[] = []
  const errors = await cleanupRuntimeResources([
    { name: "ok", close: async () => { called.push("ok") } },
    { name: "reject", close: async () => { called.push("reject"); throw new Error("close failed") } },
    { name: "stuck", close: async () => { called.push("stuck"); await new Promise(() => {}) } },
  ], 20)
  expect(called.sort()).toEqual(["ok", "reject", "stuck"])
  expect(errors.map((entry) => entry.name).sort()).toEqual(["reject", "stuck"])
  expect(errors.find((entry) => entry.name === "stuck")?.error).toBeInstanceOf(Error)
  expect(String(errors.find((entry) => entry.name === "stuck")?.error)).toContain("timed out")
})

test("primary runtime failures keep their exit code or error when cleanup also fails", () => {
  const cleanup = [{ name: "broker", error: new Error("close failed") }]
  for (const code of [1, 124, 125, 130]) expect(settleRuntimeOutcome(code, undefined, cleanup)).toBe(code)
  const primary = new Error("primary")
  expect(() => settleRuntimeOutcome(undefined, primary, cleanup)).toThrow(primary)
  expect(() => settleRuntimeOutcome(0, undefined, cleanup)).toThrow("resource cleanup failed")
  expect(settleRuntimeOutcome(0, undefined, [])).toBe(0)
})
