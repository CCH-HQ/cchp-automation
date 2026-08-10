import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import {
  RUNTIME_ENV_KEYS,
  cleanupRuntimeResources,
  composeRuntimePrompt,
  configureGitRemote,
  createRuntimeDiagnosticBuffer,
  createProgressPublisher,
  createProgressPublicationFence,
  createTerminalProgressPublisher,
  redactRuntimeDiagnostic,
  requiresReviewFinalization,
  resolveRuntimeBrokerBindings,
  resolveRuntimePermission,
  resolveRuntimeUsageGuardrails,
  resolveRuntimeRecovery,
  restoreRuntimeEnv,
  settleRuntimeOutcome,
  snapshotRuntimeEnv,
} from "./runtime"
import type { GitHubClient } from "../github/client"

test("redacts runtime diagnostics before they reach workflow logs", () => {
  const privateKey = "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----"
  const diagnostic = [
    "authorization=Bearer provider-secret x-api-key: custom-secret token=github-secret safe=context",
    '{"authorization":"Bearer rotated-token","CCHP_GITHUB_BROKER_TOKEN":"broker-secret"}',
    "proxy-authorization: Basic dXNlcjpwYXNz",
    JSON.stringify({ private_key: privateKey }),
  ].join("\n")
  const redacted = redactRuntimeDiagnostic(diagnostic, [
    "provider-secret",
    "custom-secret",
    "github-secret",
    "broker-secret",
    privateKey,
  ])
  expect(redacted).toContain("authorization=[REDACTED] x-api-key: [REDACTED] token=[REDACTED] safe=context")
  expect(redacted).toContain('{"authorization":"[REDACTED]","CCHP_GITHUB_BROKER_TOKEN":"[REDACTED]"}')
  expect(redacted).toContain("proxy-authorization: [REDACTED]")
  expect(redacted).not.toContain("secret")
  expect(redacted).not.toContain("dXNlcjpwYXNz")
  expect(redacted).not.toContain("private-material")
})

test("redacts overlapping secret values longest-first", () => {
  expect(redactRuntimeDiagnostic("abcdefgh", ["abcd", "abcdefgh"])).toBe("[REDACTED]")
})

test("bounds app-server diagnostics while retaining the most recent lines", () => {
  const buffer = createRuntimeDiagnosticBuffer(() => ["bridge-secret"], {
    maxBytes: 256,
    maxLines: 2,
    maxLineChars: 32,
  })
  buffer.push("old line")
  buffer.push("authorization: bridge-secret")
  buffer.push("latest line that is intentionally longer than the configured line budget")
  const output = buffer.drain("[app] ")
  expect(output).toContain("[app] [1 earlier diagnostic line(s) omitted]")
  expect(output).toContain("authorization: [REDACTED]")
  expect(output).toContain("latest line")
  expect(output).toContain("[line truncated]")
  expect(output).not.toContain("bridge-secret")
  expect(buffer.drain("[app] ")).toBe("")
})

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
  expect(resolveRuntimeBrokerBindings({
    BOT_TASK: "ci_fix",
    BOT_RUN_ID: "engine-2-random",
    CCHP_WORKFLOW_RUN_ID: "1234",
  })).toMatchObject({ workflowRunId: 1234 })
  expect(resolveRuntimeBrokerBindings({ BOT_TASK: "release_notes", BOT_RELEASE_TAG: "v1.2.3" }))
    .toMatchObject({ releaseTag: "v1.2.3" })
  expect(() => resolveRuntimeBrokerBindings({ BOT_PR_NUMBER: "1", BOT_ISSUE_NUMBER: "2" }))
    .toThrow("exactly one trusted")
})

test("caps response count and tokens only for short read-only interactive tasks", () => {
  for (const task of ["engage", "manual", "dispatch"] as const) {
    expect(resolveRuntimeUsageGuardrails({ task, hasWriteToken: false }, 2_000_000)).toEqual({
      totalTokenBudget: 384_000,
      maxResponsesPerTurn: 6,
      maxOutputTokens: 8_192,
    })
  }
  expect(resolveRuntimeUsageGuardrails({ task: "manual", hasWriteToken: false }, 128_000)).toEqual({
    totalTokenBudget: 128_000,
    maxResponsesPerTurn: 6,
    maxOutputTokens: 8_192,
  })
  expect(resolveRuntimeUsageGuardrails({ task: "manual", hasWriteToken: true }, 2_000_000)).toEqual({
    totalTokenBudget: 2_000_000,
  })
  expect(resolveRuntimeUsageGuardrails({ task: "pr_opened", hasWriteToken: false }, 2_000_000)).toEqual({
    totalTokenBudget: 2_000_000,
  })
  expect(resolveRuntimeUsageGuardrails({ task: "engage", hasWriteToken: false }, Number.NaN)).toEqual({
    totalTokenBudget: 384_000,
    maxResponsesPerTurn: 6,
    maxOutputTokens: 8_192,
  })
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
    execution_mode: "native_v2",
    rootThreadId: "root",
    rootTurnId: "turn",
    restartAttempts: 1,
    startedAt,
    wholeRunDeadlineAt,
    lastSemanticProgressAt: startedAt,
    updatedAt: new Date().toISOString(),
  })}\n`)

  expect(resolveRuntimeRecovery({}, workdir, "manual", "native_v2", () => "new-run")).toEqual({
    runId: "persisted-run",
    resume: {
      state: "ROOT_RUNNING",
      executionMode: "native_v2",
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
  expect(() => resolveRuntimeRecovery({ BOT_RUN_ID: "other-run" }, workdir, "manual", "native_v2", () => "new-run"))
    .toThrow(/run id mismatch/)
  expect(() => resolveRuntimeRecovery({}, workdir, "manual", "explicit_child", () => "new-run"))
    .toThrow(/execution mode mismatch/)

  const manifestPath = join(codexDir, "run-manifest.json")
  const explicitManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
  explicitManifest.execution_mode = "explicit_child"
  writeFileSync(manifestPath, `${JSON.stringify(explicitManifest)}\n`)
  expect(resolveRuntimeRecovery({}, workdir, "manual", "explicit_child", () => "new-run"))
    .toMatchObject({ resume: { executionMode: "explicit_child" } })
  expect(() => resolveRuntimeRecovery({}, workdir, "manual", "native_v2", () => "new-run"))
    .toThrow(/execution mode mismatch/)
})

test("fails closed when durable ledgers exist without a run manifest", () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-runtime-orphan-"))
  const codexDir = join(workdir, "ctx", "codex")
  mkdirSync(codexDir, { recursive: true })
  writeFileSync(join(codexDir, "usage.jsonl"), "{}\n")
  expect(() => resolveRuntimeRecovery({}, workdir, "manual", "native_v2", () => "new-run"))
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
    BOT_LOGIN: "bot[bot]",
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

test("does not retry a successful GitHub publication when local evidence cannot be written", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-runtime-publication-evidence-"))
  const invalidWorkdir = join(root, "not-a-directory")
  writeFileSync(invalidWorkdir, "fixture")
  let creates = 0
  const octokit = {
    rest: {
      issues: {
        listComments: async () => [],
        createComment: async () => {
          creates++
          return { data: { id: 1, html_url: "https://example.invalid/comment/1" } }
        },
      },
    },
    paginate: async (fn: () => Promise<unknown>) => fn(),
  } as unknown as GitHubClient
  const publish = createProgressPublisher({
    BOT_REPO: "CCH-HQ/fixture",
    BOT_TASK: "engage",
    BOT_ISSUE_NUMBER: "42",
    BOT_WORKDIR: invalidWorkdir,
    BOT_LOGIN: "bot[bot]",
  }, octokit)

  await expect(publish!("working")).resolves.toBeUndefined()
  expect(creates).toBe(1)
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

test("terminal progress replaces the task sticky only while the trusted PR head is open", async () => {
  const calls: Array<Record<string, unknown>> = []
  const listComments = Object.assign(() => {}, { tag: "comments" })
  const octokit = {
    rest: {
      pulls: {
        get: async () => ({ data: { number: 42, state: "open", merged: false, merged_at: null, head: { sha: "head" } } }),
      },
      issues: {
        listComments,
        updateComment: async (args: Record<string, unknown>) => {
          calls.push(args)
          return { data: { id: args.comment_id, html_url: "https://example.invalid/comment/9" } }
        },
      },
    },
    paginate: async () => [{ id: 9, body: "working\n<!-- cchp-bot:progress:pr_opened -->", user: { login: "bot[bot]" } }],
  } as unknown as GitHubClient
  const publish = createTerminalProgressPublisher({
    BOT_REPO: "CCH-HQ/fixture",
    GH_REPO: "CCH-HQ/fixture",
    BOT_TASK: "pr_opened",
    BOT_PR_NUMBER: "42",
    BOT_PROGRESS_TARGET: "42",
    BOT_HEAD_SHA: "head",
    GITHUB_RUN_ID: "123",
    BOT_LOGIN: "bot[bot]",
  }, octokit, (value) => value.replace("ghp_runtime_secret", "[REDACTED]"))
  expect(await publish!({
    state: "FAILED",
    terminalReason: "review failed authorization: Bearer ghp_runtime_secret",
    finalMessage: "Deleted an inaccurate reply after sticky publication failed.",
    usage: {
      acceptedRaw: true, consumed: 1200, limit: 2000, fraction: 0.6, state: "normal",
      blockingAnomalies: 0, responses: 1, turns: 1, admissionDenials: 0,
    },
  })).toBe(true)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.comment_id).toBe(9)
  expect(String(calls[0]!.body)).toContain("Run complete — `pr_opened`")
  expect(String(calls[0]!.body)).toContain("<!-- cchp-bot:progress:pr_opened -->")
  expect(String(calls[0]!.body)).not.toContain("ghp_runtime_secret")
  expect(String(calls[0]!.body)).not.toContain("Deleted an inaccurate reply")
})

test("repairs a late progress mutation so terminal progress remains the authoritative final write", async () => {
  let releaseProgress!: () => void
  let progressStarted!: () => void
  const progressGate = new Promise<void>((resolve) => { releaseProgress = resolve })
  const progressObserved = new Promise<void>((resolve) => { progressStarted = resolve })
  const writes: string[] = []
  const octokit = {
    rest: {
      issues: {
        listComments: Object.assign(() => {}, { tag: "comments" }),
        updateComment: async (args: Record<string, unknown>) => {
          const body = String(args.body)
          if (!body.includes("Run complete")) {
            progressStarted()
            await progressGate
            writes.push("progress")
          } else {
            writes.push("terminal")
          }
          return { data: { id: 9, html_url: "https://example.invalid/comment/9" } }
        },
      },
    },
    paginate: async () => [{ id: 9, body: "working\n<!-- cchp-bot:progress:engage -->", user: { login: "bot[bot]" } }],
  } as unknown as GitHubClient
  const env = {
    BOT_REPO: "CCH-HQ/fixture",
    BOT_TASK: "engage",
    BOT_ISSUE_NUMBER: "42",
    GITHUB_RUN_ID: "123",
    BOT_LOGIN: "bot[bot]",
  }
  const fence = createProgressPublicationFence()
  const progress = createProgressPublisher(env, octokit, fence)!
  const terminal = createTerminalProgressPublisher(env, octokit, (value) => value, fence)!
  const late = progress("working")
  await progressObserved
  await terminal({
    state: "SUCCEEDED",
    usage: {
      acceptedRaw: false, consumed: 10, limit: 100, fraction: 0.1, state: "normal",
      blockingAnomalies: 0, responses: 1, turns: 1, admissionDenials: 0,
    },
  })
  releaseProgress()
  await late
  expect(writes).toEqual(["terminal", "progress", "terminal"])
})

test("terminal progress skips a closed PR without creating or updating comments", async () => {
  let writes = 0
  const octokit = {
    rest: {
      pulls: { get: async () => ({ data: { state: "closed", merged: true, merged_at: "2026-08-07", head: { sha: "head" } } }) },
      issues: {
        listComments: Object.assign(() => {}, { tag: "comments" }),
        createComment: async () => { writes++; return { data: {} } },
        updateComment: async () => { writes++; return { data: {} } },
      },
    },
    paginate: async () => [],
  } as unknown as GitHubClient
  const publish = createTerminalProgressPublisher({
    BOT_REPO: "CCH-HQ/fixture",
    BOT_TASK: "pr_opened",
    BOT_PR_NUMBER: "42",
    BOT_PROGRESS_TARGET: "42",
    BOT_HEAD_SHA: "head",
    BOT_LOGIN: "bot[bot]",
  }, octokit)
  expect(await publish!({
    state: "CANCELLED",
    usage: {
      acceptedRaw: false, consumed: 0, limit: 2000, fraction: 0, state: "normal",
      blockingAnomalies: 0, responses: 0, turns: 0, admissionDenials: 0,
    },
  })).toBe(false)
  expect(writes).toBe(0)
})

test("terminal progress rechecks the PR head after locating the sticky and before mutation", async () => {
  let writes = 0
  let commentsRead = false
  const octokit = {
    rest: {
      pulls: {
        get: async () => ({
          data: { state: "open", merged: false, merged_at: null, head: { sha: commentsRead ? "new-head" : "old-head" } },
        }),
      },
      issues: {
        listComments: Object.assign(() => {}, { tag: "comments" }),
        createComment: async () => { writes++; return { data: {} } },
        updateComment: async () => { writes++; return { data: {} } },
      },
    },
    paginate: async () => {
      commentsRead = true
      return [{ id: 9, body: "working\n<!-- cchp-bot:progress:pr_opened -->", user: { login: "bot[bot]" } }]
    },
  } as unknown as GitHubClient
  const publish = createTerminalProgressPublisher({
    BOT_REPO: "CCH-HQ/fixture",
    BOT_TASK: "pr_opened",
    BOT_PR_NUMBER: "42",
    BOT_HEAD_SHA: "old-head",
    BOT_LOGIN: "bot[bot]",
  }, octokit)
  expect(await publish!({
    state: "FAILED",
    usage: {
      acceptedRaw: false, consumed: 0, limit: 0, fraction: 0, state: "normal",
      blockingAnomalies: 0, responses: 0, turns: 0, admissionDenials: 0,
    },
  })).toBe(false)
  expect(writes).toBe(0)
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

test("keeps metadata-only PR edits out of the review finalization contract", () => {
  expect(requiresReviewFinalization({ BOT_TASK: "pr_opened" })).toBeTrue()
  expect(requiresReviewFinalization({ BOT_TASK: "pr_opened", BOT_SKIP_PR_INSPECT: "0" })).toBeTrue()
  expect(requiresReviewFinalization({ BOT_TASK: "pr_opened", BOT_SKIP_PR_INSPECT: "1" })).toBeFalse()
  expect(requiresReviewFinalization({ BOT_TASK: "manual", BOT_SKIP_PR_INSPECT: "1" })).toBeFalse()
  expect(composeRuntimePrompt({
    task: "pr_opened",
    reviewRequired: false,
    instructionOverlay: "overlay",
    taskPrompt: "metadata-only task",
  })).toBe("overlay\nmetadata-only task")
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
