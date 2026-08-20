import { expect, test } from "bun:test"
import { permissionForTask } from "../codex/permissions"
import type { Task } from "../types"
import { classify, type Lookups, type PrInfo } from "./classify"
import { renderPrompt } from "./prompts"

const repo = "CCH-HQ/repo"
const bot = "cchp-automation[bot]"
const overlay = { defaultBranch: "dev", roadmapProject: "7" }
const sameRepo: PrInfo = { base: "dev", head: "feature", sha: "sha-1", headRepoFullName: repo }
const fork: PrInfo = { ...sameRepo, headRepoFullName: "outside/fork" }

interface Case {
  name: string
  eventName: string
  event: Record<string, any>
  dispatch?: { task?: string; prompt?: string; branch?: string; canWrite?: string }
  prInfo?: PrInfo
  prForSha?: number | null
  members?: string[]
  rocket?: { issueNumber: number; commentId: number; reactor: string } | null
  task: Task
  canWrite: boolean
  isFork: boolean
  sandbox: "read-only" | "danger-full-access"
  shell: boolean
  writeToken: boolean
  prompt: RegExp
  env?: Record<string, string>
}

const cases: Case[] = [
  {
    name: "engage same-repo member comment",
    eventName: "issue_comment",
    event: { action: "created", comment: { id: 10, body: "please fix", user: { login: "alice" } }, issue: { number: 9, pull_request: {} } },
    members: ["alice"], prInfo: sameRepo, task: "engage", canWrite: true, isFork: false,
    sandbox: "danger-full-access", shell: true, writeToken: true, prompt: /member=1, fork=0/,
    env: { BOT_PR_NUMBER: "9", BOT_TARGET_BRANCH: "feature", BOT_PR_IS_FORK: "0" },
  },
  {
    name: "engage fork member review comment",
    eventName: "pull_request_review_comment",
    event: { action: "created", comment: { id: 77, user: { login: "alice" } }, pull_request: { number: 9, base: { ref: "dev" }, head: { ref: "feature", sha: "sha-1", repo: { full_name: "outside/fork" } } } },
    members: ["alice"], task: "engage", canWrite: false, isFork: true,
    sandbox: "read-only", shell: false, writeToken: false, prompt: /fork=1/,
    env: { BOT_PR_NUMBER: "9", BOT_PR_IS_FORK: "1" },
  },
  {
    name: "pr_opened same-repo remains review-only",
    eventName: "pull_request_target",
    event: { action: "opened", pull_request: { number: 9, user: { login: "alice" }, base: { ref: "dev" }, head: { ref: "feature", sha: "sha-1", repo: { full_name: repo } } }, sender: { login: "alice" } },
    task: "pr_opened", canWrite: true, isFork: false,
    sandbox: "read-only", shell: false, writeToken: true, prompt: /Bash is denied for all pr_opened reviews/,
    env: { BOT_PR_NUMBER: "9", BOT_TARGET_BRANCH: "dev", BOT_PR_IS_FORK: "0" },
  },
  {
    name: "lgtm fork never auto-merges",
    eventName: "issue_comment",
    event: { action: "created", comment: { id: 10, body: "LGTM", user: { login: "alice" } }, issue: { number: 9, pull_request: {} } },
    members: ["alice"], prInfo: fork, task: "lgtm_merge", canWrite: false, isFork: true,
    sandbox: "read-only", shell: false, writeToken: false, prompt: /For fork=1, arbitrary bash and edits are disabled/,
    env: { BOT_CAN_WRITE: "0", BOT_PR_IS_FORK: "1" },
  },
  {
    name: "ci_fix linked same-repo workflow",
    eventName: "workflow_run",
    event: { workflow_run: { conclusion: "failure", name: "CI", id: 123, head_sha: "sha-1", head_branch: "feature" } },
    prForSha: 9, prInfo: sameRepo, task: "ci_fix", canWrite: true, isFork: false,
    sandbox: "danger-full-access", shell: true, writeToken: true, prompt: /associated PR: '9'/,
    env: { BOT_RUN_ID: "123", BOT_HEAD_SHA: "sha-1", BOT_TARGET_BRANCH: "feature" },
  },
  {
    name: "release notes are read-only workspace but GitHub writable",
    eventName: "release",
    event: { action: "created", release: { tag_name: "v2.0.0" }, sender: { login: "alice" } },
    task: "release_notes", canWrite: true, isFork: false,
    sandbox: "read-only", shell: false, writeToken: true, prompt: /Release 'v2.0.0' was created/,
    env: { BOT_RELEASE_TAG: "v2.0.0", BOT_TARGET_BRANCH: "dev" },
  },
  {
    name: "roadmap sync is read-only workspace without write token",
    eventName: "schedule", event: { schedule: "23 1,13 * * *" },
    task: "roadmap_sync", canWrite: false, isFork: false,
    sandbox: "read-only", shell: false, writeToken: false, prompt: /roadmap project #7/,
    env: { BOT_CAN_WRITE: "0", BOT_TARGET_BRANCH: "dev" },
  },
  {
    name: "reaction execution is trusted workspace write",
    eventName: "schedule", event: { schedule: "*/10 * * * *" },
    rocket: { issueNumber: 5, commentId: 77, reactor: "alice" },
    task: "reaction_execute", canWrite: true, isFork: false,
    sandbox: "danger-full-access", shell: true, writeToken: true, prompt: /plan comment 77 on issue #5/,
    env: { BOT_ISSUE_NUMBER: "5", BOT_PLAN_COMMENT_ID: "77", BOT_TARGET_BRANCH: "dev" },
  },
  {
    name: "legacy mention maps to manual",
    eventName: "workflow_dispatch", event: {}, dispatch: { task: "mention", prompt: "status", canWrite: "0" },
    task: "manual", canWrite: false, isFork: false,
    sandbox: "read-only", shell: false, writeToken: false, prompt: /TASK: manual dispatch.*status/,
    env: { BOT_TARGET_BRANCH: "dev", BOT_CAN_WRITE: "0" },
  },
  {
    name: "explicit dispatch can write repository but gets manual prompt",
    eventName: "workflow_dispatch", event: {}, dispatch: { task: "dispatch", prompt: "operate", branch: "release", canWrite: "1" },
    task: "dispatch", canWrite: true, isFork: false,
    sandbox: "danger-full-access", shell: true, writeToken: true, prompt: /TASK: manual dispatch.*operate/,
    env: { BOT_TARGET_BRANCH: "release", BOT_CAN_WRITE: "1" },
  },
]

for (const current of cases) {
  test(`route acceptance: ${current.name}`, async () => {
    const lookups: Lookups = {
      canWrite: async (actor) => (current.members ?? []).includes(actor),
      prInfo: async () => current.prInfo ?? sameRepo,
      prForSha: async () => current.prForSha ?? null,
      findPendingRocketExecution: async () => current.rocket ?? null,
    }
    const route = await classify({
      eventName: current.eventName,
      event: current.event,
      repo,
      botUser: bot,
      overlay,
      dispatch: current.dispatch,
    }, lookups)
    expect(route.act).toBe(true)
    expect(route.env.BOT_TASK).toBe(current.task)
    for (const [key, value] of Object.entries(current.env ?? {})) expect(route.env[key as keyof typeof route.env]).toBe(value)
    const permission = permissionForTask({ task: current.task, canWrite: current.canWrite, isFork: current.isFork })
    expect(permission).toMatchObject({
      sandboxMode: current.sandbox,
      allowShell: current.shell,
      hasWriteToken: current.writeToken,
    })
    expect(renderPrompt(route.intent!, { repo, overlay })).toMatch(current.prompt)
  })
}

test("route acceptance: ci_fix fork is rejected before runtime", async () => {
  const route = await classify({
    eventName: "workflow_run",
    event: { workflow_run: { conclusion: "failure", name: "CI", id: 123, head_sha: "sha-1", head_branch: "feature" } },
    repo, botUser: bot, overlay,
  }, {
    canWrite: async () => true,
    prInfo: async () => fork,
    prForSha: async () => 9,
    findPendingRocketExecution: async () => null,
  })
  expect(route).toMatchObject({ act: false, reason: "failed workflow belongs to fork PR" })
  expect(route.intent).toBeUndefined()
})

test("route acceptance: all supported release actions preserve their exact action", async () => {
  const lookups: Lookups = { canWrite: async () => true, prInfo: async () => sameRepo, prForSha: async () => null, findPendingRocketExecution: async () => null }
  for (const action of ["published", "released", "created", "prereleased"]) {
    const route = await classify({ eventName: "release", event: { action, release: { tag_name: "v1" }, sender: { login: "alice" } }, repo, botUser: bot, overlay }, lookups)
    expect(renderPrompt(route.intent!, { repo, overlay })).toContain(`was ${action}`)
  }
})
