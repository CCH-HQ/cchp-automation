import { expect, test } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { GitHubClient } from "../github/client"
import { CHECK_ACTIONS } from "../publish/checkrun"
import { buildTools, callTool, createServer, SERVER_NAME, toolDefinitions, type ServerDeps } from "./server"

const REPO = "CCH-HQ/repo"

// A trusted PR patch with commentable RIGHT lines 1..3 in foo.ts (line 2 added).
const PATCH = ["--- a/foo.ts", "+++ b/foo.ts", "@@ -1,2 +1,3 @@", " line1", "+added line", " line2", ""].join("\n")
const FP = "a".repeat(64)

interface FakeOpts {
  listFiles?: unknown[]
  listReviews?: unknown[]
  reviewComments?: unknown[]
  issueComments?: unknown[]
  prGet?: unknown
  prGetDiff?: string
  graphqlResult?: unknown
}

/** A minimal Octokit stand-in recording every write + serving configured reads
 *  (paginate dispatches on a `__data` tag attached to each list fn). */
function fakeOctokit(opts: FakeOpts = {}) {
  const calls = {
    pullsUpdate: [] as Record<string, unknown>[],
    merge: [] as Record<string, unknown>[],
    createReview: [] as Record<string, unknown>[],
    createComment: [] as Record<string, unknown>[],
    updateComment: [] as Record<string, unknown>[],
    checksCreate: [] as Record<string, unknown>[],
    checksUpdate: [] as Record<string, unknown>[],
    addLabels: [] as Record<string, unknown>[],
    graphql: [] as { query: string; variables: unknown }[],
    prGet: [] as Record<string, unknown>[],
  }
  const list = (data: unknown[]) => Object.assign(async () => ({ data }), { __data: data })
  const octokit = {
    paginate: async (fn: { __data?: unknown[] }) => fn.__data ?? [],
    graphql: async (query: string, variables: unknown) => {
      calls.graphql.push({ query, variables })
      return opts.graphqlResult ?? {}
    },
    rest: {
      pulls: {
        update: async (p: Record<string, unknown>) => (calls.pullsUpdate.push(p), { data: {} }),
        merge: async (p: Record<string, unknown>) => (calls.merge.push(p), { data: {} }),
        createReview: async (p: Record<string, unknown>) => (calls.createReview.push(p), { data: { html_url: "https://gh/r/1" } }),
        get: async (p: Record<string, unknown>) => {
          calls.prGet.push(p)
          const isDiff = (p.mediaType as { format?: string } | undefined)?.format === "diff"
          return { data: isDiff ? (opts.prGetDiff ?? "") : (opts.prGet ?? {}) }
        },
        listFiles: list(opts.listFiles ?? []),
        listReviews: list(opts.listReviews ?? []),
        listReviewComments: list(opts.reviewComments ?? []),
      },
      issues: {
        createComment: async (p: Record<string, unknown>) => (calls.createComment.push(p), { data: { id: 11, html_url: "https://gh/c/11" } }),
        updateComment: async (p: Record<string, unknown>) => (calls.updateComment.push(p), { data: { id: p.comment_id, html_url: "https://gh/c/up" } }),
        addLabels: async (p: Record<string, unknown>) => (calls.addLabels.push(p), { data: [] }),
        listComments: list(opts.issueComments ?? []),
      },
      checks: {
        create: async (p: Record<string, unknown>) => (calls.checksCreate.push(p), { data: { id: 777 } }),
        update: async (p: Record<string, unknown>) => (calls.checksUpdate.push(p), { data: {} }),
      },
    },
  } as unknown as GitHubClient
  return { octokit, calls }
}

function deps(extra: Partial<ServerDeps> = {}): ServerDeps {
  const { octokit } = fakeOctokit()
  return { octokit, repo: REPO, env: {}, ...extra }
}

const text = (r: CallToolResult): string => (r.content[0] as { text: string }).text

// ── registration: tool list + input schemas ──────────────────────────────────

const EXPECTED_TOOLS = [
  "upsert_sticky_comment",
  "post_structured_comment",
  "update_structured_comment",
  "post_inline_review",
  "submit_pr_review",
  "create_check_run",
  "update_check_run",
  "set_pr_title",
  "post_comment",
  "comment_file",
  "close",
  "lock",
  "add_triage_label",
  "add_lgtm_label",
  "merge_pr",
  "get_pr_diff",
  "get_failed_logs",
  "get_pr_context",
  "add_label",
  "remove_label",
  "set_milestone",
  "rerun_workflow_run",
  "cancel_workflow_run",
  "roadmap_add_item",
  "roadmap_move_item",
  "roadmap_graphql",
]

test("createServer registers a real MCP Server exposing exactly the phase-1 tool surface", () => {
  const { server, tools } = createServer(deps())
  expect(server).toBeInstanceOf(Server)
  expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort())
})

test("every advertised tool has an object input schema, a description, and no leaked handler", () => {
  const defs = toolDefinitions(buildTools(deps()))
  expect(defs).toHaveLength(EXPECTED_TOOLS.length)
  for (const d of defs) {
    expect(typeof d.name).toBe("string")
    expect(typeof d.description).toBe("string")
    expect(d.inputSchema.type).toBe("object")
    expect(d).not.toHaveProperty("handler")
  }
})

test("key input schemas match the contract (required fields + enums)", () => {
  const byName = new Map(buildTools(deps()).map((t) => [t.name, t.inputSchema]))
  expect(byName.get("merge_pr")?.required).toEqual(["pr_number", "head_repo_full_name"])
  expect(byName.get("post_inline_review")?.required).toEqual(["comments"])
  expect(byName.get("roadmap_move_item")?.required).toEqual(["project_id", "item_id", "field_id", "option_id"])
  const submit = byName.get("submit_pr_review") as unknown as { properties: { event: { enum: string[] } } }
  expect(submit.properties.event.enum).toEqual(["COMMENT", "REQUEST_CHANGES", "APPROVE"])
  const upd = byName.get("update_check_run") as unknown as { properties: { action_keys: { items: { enum: string[] } } } }
  expect(upd.properties.action_keys.items.enum).toEqual(Object.keys(CHECK_ACTIONS))
})

// ── dispatch + error shape ────────────────────────────────────────────────────

test("unknown tool → isError text result (no crash)", async () => {
  const res = await callTool(buildTools(deps()), "nope", {})
  expect(res.isError).toBe(true)
  expect(text(res)).toContain("unknown tool: nope")
})

test("a validation failure surfaces as an isError text result, not a throw", async () => {
  const tools = buildTools(deps())
  const res = await callTool(tools, "set_pr_title", { pr_number: 5, title: "x".repeat(257) })
  expect(res.isError).toBe(true)
  expect(text(res)).toContain("error: invalid title length")
})

// ── publish delegation ────────────────────────────────────────────────────────

test("set_pr_title delegates to meta.setPrTitle", async () => {
  const { octokit, calls } = fakeOctokit()
  const tools = buildTools({ octokit, repo: REPO })
  const res = await callTool(tools, "set_pr_title", { pr_number: 5, title: "feat: retitle" })
  expect(res.isError).toBeUndefined()
  expect(calls.pullsUpdate[0]).toMatchObject({ owner: "CCH-HQ", repo: "repo", pull_number: 5, title: "feat: retitle" })
})

test("upsert_sticky_comment creates a marker-tagged comment when none exists", async () => {
  const { octokit, calls } = fakeOctokit({ issueComments: [] })
  const tools = buildTools({ octokit, repo: REPO })
  const res = await callTool(tools, "upsert_sticky_comment", { issue_number: 7, sticky_key: "cifix", body: "overview" })
  expect(text(res)).toContain('"action":"created"')
  expect(calls.createComment[0]!.body).toContain("<!-- cchp-bot:cifix -->")
})

test("submit_pr_review wires the auto-approve kill-switch from env (APPROVE → COMMENT)", async () => {
  const { octokit, calls } = fakeOctokit()
  const tools = buildTools({ octokit, repo: REPO, env: { CCHP_DISABLE_AUTO_APPROVE: "1" } })
  const res = await callTool(tools, "submit_pr_review", { pr_number: 8, event: "APPROVE", body: "lgtm" })
  expect(text(res)).toContain('"event":"COMMENT"')
  expect(calls.createReview[0]).toMatchObject({ pull_number: 8, event: "COMMENT" })
})

test("post_inline_review binds PR/head/patch from the run env + injected trusted patch", async () => {
  const { octokit, calls } = fakeOctokit()
  const tools = buildTools({
    octokit,
    repo: REPO,
    env: { BOT_PR_NUMBER: "8", BOT_HEAD_SHA: "headsha" },
    readTrustedPatch: () => PATCH,
  })
  const res = await callTool(tools, "post_inline_review", {
    comments: [{ path: "foo.ts", line: 2, body: "nit", fingerprint: FP }],
    summary: "one finding",
  })
  expect(text(res)).toContain('"status":"posted"')
  expect(calls.createReview[0]).toMatchObject({ pull_number: 8, commit_id: "headsha", event: "COMMENT" })
  expect((calls.createReview[0]!.comments as unknown[]).length).toBe(1)
})

test("post_inline_review anchors against the trusted patch (uncommentable line rejected)", async () => {
  const { octokit, calls } = fakeOctokit()
  const tools = buildTools({ octokit, repo: REPO, env: { BOT_PR_NUMBER: "8", BOT_HEAD_SHA: "h" }, readTrustedPatch: () => PATCH })
  const res = await callTool(tools, "post_inline_review", { comments: [{ path: "foo.ts", line: 999, body: "x", fingerprint: FP }] })
  expect(res.isError).toBe(true)
  expect(text(res)).toContain("not commentable")
  expect(calls.createReview).toHaveLength(0)
})

test("update_check_run maps curated action_keys to CHECK_ACTIONS and rejects unknown keys", async () => {
  const { octokit, calls } = fakeOctokit()
  const tools = buildTools({ octokit, repo: REPO })
  const ok = await callTool(tools, "update_check_run", {
    check_run_id: 777,
    status: "completed",
    conclusion: "failure",
    title: "Blocked",
    summary: "1 finding",
    action_keys: ["applyFixes", "dismiss"],
  })
  expect(ok.isError).toBeUndefined()
  expect(calls.checksUpdate[0]).toMatchObject({ check_run_id: 777, status: "completed", conclusion: "failure" })
  expect((calls.checksUpdate[0]!.actions as { identifier: string }[]).map((x) => x.identifier)).toEqual(["apply-fixes", "dismiss"])

  const bad = await callTool(tools, "update_check_run", { check_run_id: 1, status: "completed", title: "t", summary: "s", action_keys: ["nope"] })
  expect(bad.isError).toBe(true)
  expect(text(bad)).toContain("unknown action key: nope")
})

// ── fork gate (security-critical) ─────────────────────────────────────────────

test("merge_pr NEVER auto-merges a fork (fork gate), and squash-merges same-repo", async () => {
  const { octokit, calls } = fakeOctokit()
  const tools = buildTools({ octokit, repo: REPO })

  const fork = await callTool(tools, "merge_pr", { pr_number: 8, head_repo_full_name: "attacker/repo" })
  expect(text(fork)).toContain('"merged":false')
  expect(text(fork)).toContain("fork")
  expect(calls.merge).toHaveLength(0)

  const forkNull = await callTool(tools, "merge_pr", { pr_number: 8, head_repo_full_name: null })
  expect(text(forkNull)).toContain('"merged":false')
  expect(calls.merge).toHaveLength(0)

  const same = await callTool(tools, "merge_pr", { pr_number: 8, head_repo_full_name: REPO })
  expect(text(same)).toContain('"merged":true')
  expect(calls.merge[0]).toMatchObject({ pull_number: 8, merge_method: "squash" })
})

// ── reads (raw Octokit → text) ────────────────────────────────────────────────

test("get_pr_context returns PR metadata + files + reviews as JSON text", async () => {
  const { octokit } = fakeOctokit({
    prGet: {
      number: 8,
      title: "feat: x",
      state: "open",
      draft: false,
      user: { login: "alice" },
      body: "desc",
      base: { ref: "dev" },
      head: { ref: "topic", sha: "abc", repo: { full_name: "CCH-HQ/repo" } },
      changed_files: 1,
      additions: 3,
      deletions: 0,
    },
    listFiles: [{ filename: "foo.ts", status: "modified", additions: 3, deletions: 0 }],
    listReviews: [{ user: { login: "bob" }, state: "APPROVED", submitted_at: "t", body: "ok" }],
  })
  const tools = buildTools({ octokit, repo: REPO })
  const res = await callTool(tools, "get_pr_context", { pr_number: 8 })
  const parsed = JSON.parse(text(res))
  expect(parsed).toMatchObject({ number: 8, title: "feat: x", head_repo_full_name: "CCH-HQ/repo" })
  expect(parsed.files[0].filename).toBe("foo.ts")
  expect(parsed.reviews[0].user).toBe("bob")
})

test("get_pr_diff returns the raw unified diff text", async () => {
  const { octokit, calls } = fakeOctokit({ prGetDiff: PATCH })
  const tools = buildTools({ octokit, repo: REPO })
  const res = await callTool(tools, "get_pr_diff", { pr_number: 8 })
  expect(text(res)).toBe(PATCH)
  expect((calls.prGet[0]!.mediaType as { format: string }).format).toBe("diff")
})

// ── mutations (raw Octokit) ────────────────────────────────────────────────────

test("roadmap_move_item runs the updateProjectV2ItemFieldValue mutation via the shared client", async () => {
  const { octokit, calls } = fakeOctokit({ graphqlResult: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "IT_1" } } } })
  const tools = buildTools({ octokit, repo: REPO })
  const res = await callTool(tools, "roadmap_move_item", { project_id: "PVT_1", item_id: "IT_1", field_id: "F_1", option_id: "OPT_done" })
  expect(text(res)).toContain('"item_id":"IT_1"')
  expect(calls.graphql[0]!.query).toContain("updateProjectV2ItemFieldValue")
  expect(calls.graphql[0]!.variables).toMatchObject({ p: "PVT_1", i: "IT_1", f: "F_1", o: "OPT_done" })
})

test("add_label validates the labels array before calling Octokit", async () => {
  const { octokit, calls } = fakeOctokit()
  const tools = buildTools({ octokit, repo: REPO })
  const ok = await callTool(tools, "add_label", { number: 5, labels: ["needs-triage"] })
  expect(ok.isError).toBeUndefined()
  expect(calls.addLabels[0]).toMatchObject({ issue_number: 5, labels: ["needs-triage"] })

  const bad = await callTool(tools, "add_label", { number: 5, labels: [] })
  expect(bad.isError).toBe(true)
  expect(calls.addLabels).toHaveLength(1) // unchanged
})

// ── entry guards ───────────────────────────────────────────────────────────────

test("main() fails fast without BOT_REPO / GH_TOKEN", async () => {
  const { main } = await import("./server")
  await expect(main({})).rejects.toThrow("BOT_REPO is required")
  await expect(main({ BOT_REPO: REPO })).rejects.toThrow("GH_TOKEN is required")
})
