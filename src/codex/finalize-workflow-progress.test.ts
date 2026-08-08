import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GitHubClient } from "../github/client"
import { finalizeWorkflowProgress, readSupervisorTerminal, resolveWorkflowTerminal } from "./finalize-workflow-progress"

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
  expect(resolveWorkflowTerminal(successfulPrerequisites, terminal)).toBe(terminal)
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
    paginate: async () => [{ id: 9, body: "Live progress\n<!-- cchp-bot:progress:pr_opened -->" }],
  } as unknown as GitHubClient
  const result = await finalizeWorkflowProgress({
    GH_TOKEN: "fixture",
    GH_REPO: "CCH-HQ/fixture",
    BOT_REPO: "CCH-HQ/fixture",
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
  expect(await finalizeWorkflowProgress({
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
    CCHP_JOB_CANCELLED: "false",
  }, {} as GitHubClient)).toBe("skipped")
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
