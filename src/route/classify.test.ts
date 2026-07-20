import { expect, test } from "bun:test"
import { classify, type Lookups, type PrInfo } from "./classify"

const REPO = "CCH-HQ/repo"
const BOT = "cchp-automation[bot]"
const overlay = { defaultBranch: "dev", roadmapProject: "1" }

const sameRepoPr: PrInfo = { base: "dev", head: "feature", sha: "sha123", headRepoFullName: REPO }
const forkPr: PrInfo = { base: "dev", head: "feature", sha: "sha123", headRepoFullName: "attacker/repo" }

interface Opts {
  members?: string[]
  prInfo?: PrInfo
  prForSha?: number | null
  rocket?: { issueNumber: number; commentId: number; reactor: string } | null
  selfWorkflowName?: string
  dispatch?: { task?: string; prompt?: string; branch?: string; canWrite?: string }
}

function run(eventName: string, event: Record<string, any>, opts: Opts = {}) {
  const lookups: Lookups = {
    canWrite: async (a) => (opts.members ?? []).includes(a),
    prInfo: async () => opts.prInfo ?? sameRepoPr,
    prForSha: async () => opts.prForSha ?? null,
    findPendingRocketExecution: async () => opts.rocket ?? null,
  }
  return classify(
    { eventName, event, repo: REPO, botUser: BOT, overlay, selfWorkflowName: opts.selfWorkflowName, dispatch: opts.dispatch },
    lookups,
  )
}

// ── issues ────────────────────────────────────────────────────────────────────
test("issues.labeled → roadmap_item, read-only, no ack", async () => {
  const r = await run("issues", { action: "labeled", issue: { number: 5 }, sender: { login: "alice" } })
  expect(r.act).toBe(true)
  expect(r.needsWrite).toBe(false)
  expect(r.env.BOT_TASK).toBe("roadmap_item")
  expect(r.env.BOT_CAN_WRITE).toBe("0")
  expect(r.ack).toBeUndefined()
})

test("issues.opened by member → engage + write + eyes ack", async () => {
  const r = await run("issues", { action: "opened", issue: { number: 7 }, sender: { login: "alice" } }, { members: ["alice"] })
  expect(r.env.BOT_TASK).toBe("engage")
  expect(r.needsWrite).toBe(true)
  expect(r.ack).toEqual({ kind: "rest", target: "issues/7" })
})

test("issues.opened by non-member → engage but no write", async () => {
  const r = await run("issues", { action: "opened", issue: { number: 7 }, sender: { login: "mallory" } })
  expect(r.needsWrite).toBe(false)
  expect(r.env.BOT_CAN_WRITE).toBe("0")
})

test("issues event by a bot → no action (loop guard)", async () => {
  const r = await run("issues", { action: "opened", issue: { number: 7 }, sender: { login: "some[bot]" } })
  expect(r.act).toBe(false)
})

test("issues.deleted → no action", async () => {
  const r = await run("issues", { action: "deleted", issue: { number: 7 }, sender: { login: "alice" } })
  expect(r.act).toBe(false)
})

// ── issue_comment ───────────────────────────────────────────────────────────────
test("comment by a bot → no action", async () => {
  const r = await run("issue_comment", { action: "created", comment: { user: { login: "x[bot]" }, id: 1 }, issue: { number: 3 } })
  expect(r.act).toBe(false)
})

test("PR comment by member, same-repo → engage + write", async () => {
  const r = await run(
    "issue_comment",
    { action: "created", comment: { user: { login: "alice" }, id: 9, body: "hi" }, issue: { number: 3, pull_request: {} } },
    { members: ["alice"], prInfo: sameRepoPr },
  )
  expect(r.env.BOT_TASK).toBe("engage")
  expect(r.needsWrite).toBe(true)
})

test("PR comment by member, FORK → engage but write withheld (fork gate)", async () => {
  const r = await run(
    "issue_comment",
    { action: "created", comment: { user: { login: "alice" }, id: 9, body: "hi" }, issue: { number: 3, pull_request: {} } },
    { members: ["alice"], prInfo: forkPr },
  )
  expect(r.env.BOT_TASK).toBe("engage")
  expect(r.needsWrite).toBe(false)
  expect(r.env.BOT_CAN_WRITE).toBe("0")
  expect(r.env.BOT_PR_IS_FORK).toBe("1")
})

test("LGTM by member, same-repo → lgtm_merge + write", async () => {
  const r = await run(
    "issue_comment",
    { action: "created", comment: { user: { login: "alice" }, id: 9, body: "LGTM 🚀" }, issue: { number: 3, pull_request: {} } },
    { members: ["alice"], prInfo: sameRepoPr },
  )
  expect(r.env.BOT_TASK).toBe("lgtm_merge")
  expect(r.needsWrite).toBe(true)
})

test("LGTM by member, FORK → lgtm_merge but NO write token (ADR 0004: never auto-merge forks)", async () => {
  const r = await run(
    "issue_comment",
    { action: "created", comment: { user: { login: "alice" }, id: 9, body: "lgtm" }, issue: { number: 3, pull_request: {} } },
    { members: ["alice"], prInfo: forkPr },
  )
  expect(r.env.BOT_TASK).toBe("lgtm_merge")
  expect(r.needsWrite).toBe(false)
  expect(r.env.BOT_CAN_WRITE).toBe("0")
  expect(r.intent?.vars.fork).toBe(true)
})

test("LGTM by non-member → plain engage, not a merge", async () => {
  const r = await run(
    "issue_comment",
    { action: "created", comment: { user: { login: "mallory" }, id: 9, body: "lgtm" }, issue: { number: 3, pull_request: {} } },
    { members: [], prInfo: sameRepoPr },
  )
  expect(r.env.BOT_TASK).toBe("engage")
})

test("action menu: member checks a new box on the bot's menu → execute that action", async () => {
  const from = "- [ ] Re-review <!-- cchp-action:rerun -->"
  const to = "- [x] Re-review <!-- cchp-action:rerun -->"
  const r = await run(
    "issue_comment",
    { action: "edited", comment: { user: { login: BOT }, id: 42, body: to }, changes: { body: { from } }, sender: { login: "alice" }, issue: { number: 3 } },
    { members: ["alice"] },
  )
  expect(r.act).toBe(true)
  expect(r.intent?.vars.actionId).toBe("rerun")
  expect(r.ack).toEqual({ kind: "rest", target: "issues/comments/42" })
})

test("action menu: non-member checking a box → no action", async () => {
  const from = "- [ ] Re-review <!-- cchp-action:rerun -->"
  const to = "- [x] Re-review <!-- cchp-action:rerun -->"
  const r = await run(
    "issue_comment",
    { action: "edited", comment: { user: { login: BOT }, id: 42, body: to }, changes: { body: { from } }, sender: { login: "mallory" }, issue: { number: 3 } },
    { members: [] },
  )
  expect(r.act).toBe(false)
})

test("action menu: no newly-checked box → no action", async () => {
  const same = "- [x] Re-review <!-- cchp-action:rerun -->"
  const r = await run(
    "issue_comment",
    { action: "edited", comment: { user: { login: BOT }, id: 42, body: same }, changes: { body: { from: same } }, sender: { login: "alice" }, issue: { number: 3 } },
    { members: ["alice"] },
  )
  expect(r.act).toBe(false)
})

// ── pull_request_target ──────────────────────────────────────────────────────────
test("PR closed → roadmap_item, read-only (fires even for bot merges)", async () => {
  const r = await run("pull_request_target", {
    action: "closed", pull_request: { number: 8, base: { ref: "dev" }, head: { ref: "f", repo: { full_name: REPO } }, merged: true }, sender: { login: BOT },
  })
  expect(r.env.BOT_TASK).toBe("roadmap_item")
  expect(r.needsWrite).toBe(false)
})

test("PR labeled LGTM by member, same-repo → lgtm_merge + write", async () => {
  const r = await run(
    "pull_request_target",
    { action: "labeled", label: { name: "LGTM" }, pull_request: { number: 8, base: { ref: "dev" }, head: { ref: "f", sha: "s", repo: { full_name: REPO } } }, sender: { login: "alice" } },
    { members: ["alice"] },
  )
  expect(r.env.BOT_TASK).toBe("lgtm_merge")
  expect(r.needsWrite).toBe(true)
})

test("PR labeled LGTM by member, FORK → lgtm_merge but NO write (ADR 0004)", async () => {
  const r = await run(
    "pull_request_target",
    { action: "labeled", label: { name: "lgtm" }, pull_request: { number: 8, base: { ref: "dev" }, head: { ref: "f", sha: "s", repo: { full_name: "attacker/repo" } } }, sender: { login: "alice" } },
    { members: ["alice"] },
  )
  expect(r.needsWrite).toBe(false)
  expect(r.env.BOT_CAN_WRITE).toBe("0")
})

test("PR labeled LGTM by non-member → no action", async () => {
  const r = await run(
    "pull_request_target",
    { action: "labeled", label: { name: "LGTM" }, pull_request: { number: 8, base: { ref: "dev" }, head: { ref: "f", repo: { full_name: REPO } } }, sender: { login: "mallory" } },
    { members: [] },
  )
  expect(r.act).toBe(false)
})

test("PR labeled non-LGTM → no action", async () => {
  const r = await run("pull_request_target", {
    action: "labeled", label: { name: "bug" }, pull_request: { number: 8, base: { ref: "dev" }, head: { ref: "f", repo: { full_name: REPO } } }, sender: { login: "alice" },
  })
  expect(r.act).toBe(false)
})

test("PR opened → pr_opened review, no write token (review is read-only), even for forks", async () => {
  const r = await run("pull_request_target", {
    action: "opened", pull_request: { number: 8, base: { ref: "dev" }, head: { ref: "f", sha: "s", repo: { full_name: "attacker/repo" } }, user: { login: "mallory" } }, sender: { login: "mallory" },
  })
  expect(r.env.BOT_TASK).toBe("pr_opened")
  expect(r.needsWrite).toBe(false)
  expect(r.intent?.vars.fork).toBe(true)
})

test("PR edited without base change → metadata-only, skip diff inspection", async () => {
  const r = await run("pull_request_target", {
    action: "edited", changes: {}, pull_request: { number: 8, base: { ref: "dev" }, head: { ref: "f", sha: "s", repo: { full_name: REPO } }, user: { login: "alice" } }, sender: { login: "alice" },
  })
  expect(r.env.BOT_SKIP_PR_INSPECT).toBe("1")
  expect(r.intent?.vars.metadataOnly).toBe(true)
})

test("PR opened by the bot itself (e.g. Renovate under the same App) → still reviewed", async () => {
  const r = await run("pull_request_target", {
    action: "opened", pull_request: { number: 8, base: { ref: "dev" }, head: { ref: "f", sha: "s", repo: { full_name: REPO } }, user: { login: BOT } }, sender: { login: BOT },
  })
  expect(r.env.BOT_TASK).toBe("pr_opened")
  expect(r.needsWrite).toBe(false)
})

test("PR synchronize by the bot (ci_fix push) → follow-up review", async () => {
  const r = await run("pull_request_target", {
    action: "synchronize", pull_request: { number: 8, base: { ref: "dev" }, head: { ref: "f", sha: "s2", repo: { full_name: REPO } }, user: { login: "alice" } }, sender: { login: BOT },
  })
  expect(r.env.BOT_TASK).toBe("pr_opened")
  expect(r.intent?.vars.action).toBe("synchronize")
})

test("PR edited by the bot (its own title fix echo) → no action", async () => {
  const r = await run("pull_request_target", {
    action: "edited", changes: {}, pull_request: { number: 8, base: { ref: "dev" }, head: { ref: "f", sha: "s", repo: { full_name: REPO } }, user: { login: "alice" } }, sender: { login: BOT },
  })
  expect(r.act).toBe(false)
})

test("PR labeled LGTM by the bot itself → no action (no merge echo loop)", async () => {
  const r = await run("pull_request_target", {
    action: "labeled", label: { name: "LGTM" }, pull_request: { number: 8, base: { ref: "dev" }, head: { ref: "f", sha: "s", repo: { full_name: REPO } } }, sender: { login: BOT },
  })
  expect(r.act).toBe(false)
})

// ── pull_request_review ──────────────────────────────────────────────────────────
test("PR review by member, same-repo → engage + write", async () => {
  const r = await run(
    "pull_request_review",
    { action: "submitted", review: { user: { login: "alice" }, body: "" }, pull_request: { number: 8, base: { ref: "dev" }, head: { ref: "f", sha: "s", repo: { full_name: REPO } } } },
    { members: ["alice"] },
  )
  expect(r.needsWrite).toBe(true)
})

test("PR review by member, FORK → write withheld", async () => {
  const r = await run(
    "pull_request_review",
    { action: "submitted", review: { user: { login: "alice" }, body: "" }, pull_request: { number: 8, base: { ref: "dev" }, head: { ref: "f", sha: "s", repo: { full_name: "attacker/repo" } } } },
    { members: ["alice"] },
  )
  expect(r.needsWrite).toBe(false)
})

// ── discussion ───────────────────────────────────────────────────────────────────
test("discussion by member → engage via node ack", async () => {
  const r = await run(
    "discussion",
    { action: "created", discussion: { number: 4, user: { login: "alice" }, node_id: "D_1" }, sender: { login: "alice" } },
    { members: ["alice"] },
  )
  expect(r.env.BOT_TASK).toBe("engage")
  expect(r.ack).toEqual({ kind: "node", target: "D_1" })
})

test("discussion by bot → no action", async () => {
  const r = await run("discussion", { action: "created", discussion: { number: 4, user: { login: "x[bot]" }, node_id: "D_1" }, sender: { login: "x[bot]" } })
  expect(r.act).toBe(false)
})

// ── workflow_run ─────────────────────────────────────────────────────────────────
test("workflow_run failure, no PR → ci_fix + write", async () => {
  const r = await run("workflow_run", { workflow_run: { conclusion: "failure", name: "backend-ci", id: 99, head_sha: "s", head_branch: "dev" } })
  expect(r.env.BOT_TASK).toBe("ci_fix")
  expect(r.needsWrite).toBe(true)
})

test("workflow_run of the bot's own workflow → no action", async () => {
  const r = await run(
    "workflow_run",
    { workflow_run: { conclusion: "failure", name: "cchp-automation bot", id: 99, head_sha: "s", head_branch: "dev" } },
    { selfWorkflowName: "cchp-automation bot" },
  )
  expect(r.act).toBe(false)
})

test("workflow_run failure on a fork PR → no action (never auto-fix fork code)", async () => {
  const r = await run(
    "workflow_run",
    { workflow_run: { conclusion: "failure", name: "backend-ci", id: 99, head_sha: "s", head_branch: "f" } },
    { prForSha: 8, prInfo: forkPr },
  )
  expect(r.act).toBe(false)
})

test("workflow_run success → no action", async () => {
  const r = await run("workflow_run", { workflow_run: { conclusion: "success", name: "backend-ci", id: 99, head_sha: "s" } })
  expect(r.act).toBe(false)
})

// ── release ──────────────────────────────────────────────────────────────────────
test("release published → release_notes + write", async () => {
  const r = await run("release", { action: "published", release: { tag_name: "v1.2.3" }, sender: { login: "alice" } })
  expect(r.env.BOT_TASK).toBe("release_notes")
  expect(r.needsWrite).toBe(true)
})

test("release by the bot → no action", async () => {
  const r = await run("release", { action: "published", release: { tag_name: "v1.2.3" }, sender: { login: BOT } })
  expect(r.act).toBe(false)
})

// ── schedule ─────────────────────────────────────────────────────────────────────
test("roadmap reconcile cron → roadmap_sync, read-only", async () => {
  const r = await run("schedule", { schedule: "23 1,13 * * *" })
  expect(r.env.BOT_TASK).toBe("roadmap_sync")
  expect(r.needsWrite).toBe(false)
})

test("rocket-poll cron with a pending execution → reaction_execute + write", async () => {
  const r = await run("schedule", { schedule: "*/10 * * * *" }, { rocket: { issueNumber: 5, commentId: 55, reactor: "alice" } })
  expect(r.env.BOT_TASK).toBe("reaction_execute")
  expect(r.needsWrite).toBe(true)
  expect(r.env.BOT_PLAN_COMMENT_ID).toBe("55")
})

test("rocket-poll cron with nothing pending → no action", async () => {
  const r = await run("schedule", { schedule: "*/10 * * * *" }, { rocket: null })
  expect(r.act).toBe(false)
})

test("unknown cron → no action (drift guard)", async () => {
  const r = await run("schedule", { schedule: "0 0 * * *" })
  expect(r.act).toBe(false)
  expect(r.reason).toContain("UNKNOWN cron")
})

// ── workflow_dispatch ─────────────────────────────────────────────────────────────
test("manual dispatch defaults → engage + write", async () => {
  const r = await run("workflow_dispatch", {}, { dispatch: { prompt: "do a thing" } })
  expect(r.act).toBe(true)
  expect(r.needsWrite).toBe(true)
})

test("manual dispatch with can_write=0 → no write", async () => {
  const r = await run("workflow_dispatch", {}, { dispatch: { canWrite: "0" } })
  expect(r.needsWrite).toBe(false)
})

// ── unhandled ─────────────────────────────────────────────────────────────────────
test("unhandled event → no action", async () => {
  const r = await run("push", {})
  expect(r.act).toBe(false)
})
