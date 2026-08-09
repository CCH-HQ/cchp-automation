import { expect, test } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProvenanceLedger } from "../codex/provenance"
import type { GitHubClient } from "../github/client"
import { CHECK_ACTIONS } from "../publish/checkrun"
import { WORKFLOW_LOG_MAX_BYTES, WORKFLOW_LOG_MAX_LINES } from "../context"
import type { FinalizedMarker } from "../review/finalize"
import { fingerprint, TASKS, type Task } from "../types"
import { buildTools, callTool, createServer, materializeInlinePublication, reviewPublicationBundle, SERVER_NAME, toolDefinitions, validateInlinePublication, type ServerDeps } from "./server"

const REPO = "CCH-HQ/repo"

// A trusted PR patch with commentable RIGHT lines 1..3 in foo.ts (line 2 added).
const PATCH = ["--- a/foo.ts", "+++ b/foo.ts", "@@ -1,2 +1,3 @@", " line1", "+added line", " line2", ""].join("\n")
const FP = "a".repeat(64)

function publicationMarker(workdir: string, artifactDir: string): FinalizedMarker {
  const hash = (name: string) => createHash("sha256").update(readFileSync(join(artifactDir, name))).digest("hex")
  const patchPath = join(workdir, "ctx", "pr-diff.patch")
  const trustedManifest = join(workdir, "ctx", "review-manifest.json")
  mkdirSync(join(workdir, "ctx"), { recursive: true })
  writeFileSync(patchPath, PATCH)
  const patchSha256 = createHash("sha256").update(PATCH).digest("hex")
  writeFileSync(trustedManifest, JSON.stringify({ patch: { path: patchPath, sha256: patchSha256 } }))
  return {
    schema_version: 1,
    valid: true,
    repository: REPO,
    pr_number: 42,
    run_id: "run-1",
    provenance_sha256: "a".repeat(64),
    head_sha: "b".repeat(40),
    trusted_manifest_sha256: createHash("sha256").update(readFileSync(trustedManifest)).digest("hex"),
    patch_sha256: patchSha256,
    artifacts: {
      manifest: "d".repeat(64),
      coverage: "e".repeat(64),
      candidates: hash("candidate-ledger.json"),
      verification: hash("verification-ledger.json"),
      report: hash("final-report.md"),
      admission_ledger: "f".repeat(64),
      review_results: "0".repeat(64),
    },
    finalized_at: "2026-08-06T00:00:00Z",
  }
}

test("finalized publication is derived from the verified finding subset", () => {
  const workdir = mkdtempSync(join(tmpdir(), "mcp-publication-bundle-"))
  const artifactDir = join(workdir, "ctx", "review")
  mkdirSync(artifactDir, { recursive: true })
  writeFileSync(join(artifactDir, "candidate-ledger.json"), JSON.stringify({
    candidates: [{ candidate_id: "c1", root_cause_key: "stable-root-cause" }],
  }))
  writeFileSync(join(artifactDir, "verification-ledger.json"), JSON.stringify({
    verifications: [{
      candidate_id: "c1",
      verdict: "CONFIRMED_STATIC",
      severity: "P1",
      confidence: 0.9,
      diff_causality: "introduced",
      trigger: "call the changed path",
      execution_trace: ["input reaches the branch", "branch returns the wrong state"],
      observable_failure: "the caller receives an invalid result",
      location: { file: "foo.ts", line: 2, side: "RIGHT", start_line: 1, start_side: "RIGHT" },
    }],
  }))
  writeFileSync(join(artifactDir, "final-report.md"), "# Code Review Result\n")
  const bundle = reviewPublicationBundle({ BOT_WORKDIR: workdir }, publicationMarker(workdir, artifactDir))
  const canonical = {
    path: "foo.ts",
    line: 2,
    side: "RIGHT" as const,
    start_line: 1,
    start_side: "RIGHT" as const,
    body: [
      '**P1 confirmed finding "c1"**',
      "",
      '- Verdict: "CONFIRMED_STATIC"',
      '- Root cause: "stable-root-cause"',
      '- Trigger: "call the changed path"',
      '- Observable failure: "the caller receives an invalid result"',
      "- Confidence: 0.9",
      "",
      "**Execution trace**",
      '1. "input reaches the branch"',
      '1. "branch returns the wrong state"',
    ].join("\n"),
    fingerprint: fingerprint("stable-root-cause"),
  }
  expect(bundle).toMatchObject({
    formalVerdict: "REQUEST_CHANGES",
    findingCount: 1,
    report: "# Code Review Result\n",
    patch: PATCH,
    headSha: "b".repeat(40),
  })
  expect(bundle.publishableInline[canonical.fingerprint]).toEqual(canonical)
  expect(Object.isFrozen(bundle)).toBe(true)
  expect(Object.isFrozen(bundle.publishableInline)).toBe(true)
  expect(Object.isFrozen(bundle.publishableInline[canonical.fingerprint])).toBe(true)
  expect(() => validateInlinePublication(bundle, [canonical])).not.toThrow()
  for (const forged of [
    { ...canonical, path: "bar.ts" },
    { ...canonical, body: "forged body" },
    { ...canonical, side: "LEFT" as const },
    { ...canonical, start_line: 2 },
    { ...canonical, start_side: "LEFT" as const },
  ]) {
    expect(() => validateInlinePublication(bundle, [forged])).toThrow(/does not match the finalized verification ledger/)
  }
  expect(() => validateInlinePublication(bundle, [{ ...canonical, fingerprint: "invented" }])).toThrow("confirmed-finding subset")
  expect(materializeInlinePublication(bundle, ["stable-root-cause"])).toEqual([canonical])
  expect(() => materializeInlinePublication(bundle, ["stable-root-cause", "stable-root-cause"])).toThrow(/duplicated/)
  expect(() => materializeInlinePublication(bundle, ["invented"])).toThrow(/confirmed-finding subset/)
})

test("publication binds the runtime head SHA to the finalized marker", () => {
  const workdir = mkdtempSync(join(tmpdir(), "mcp-publication-head-bind-"))
  const artifactDir = join(workdir, "ctx", "review")
  mkdirSync(artifactDir, { recursive: true })
  writeFileSync(join(artifactDir, "candidate-ledger.json"), JSON.stringify({ candidates: [] }))
  writeFileSync(join(artifactDir, "verification-ledger.json"), JSON.stringify({ verifications: [] }))
  writeFileSync(join(artifactDir, "final-report.md"), "# Code Review Result\n")
  const marker = publicationMarker(workdir, artifactDir)
  expect(() => reviewPublicationBundle({ BOT_WORKDIR: workdir, BOT_HEAD_SHA: "c".repeat(40) }, marker)).toThrow(/BOT_HEAD_SHA.*finalized marker/)
})

test("publication rejects artifact bytes that no longer match the finalizer attestation", () => {
  const workdir = mkdtempSync(join(tmpdir(), "mcp-publication-marker-bind-"))
  const artifactDir = join(workdir, "ctx", "review")
  mkdirSync(artifactDir, { recursive: true })
  writeFileSync(join(artifactDir, "candidate-ledger.json"), JSON.stringify({ candidates: [] }))
  writeFileSync(join(artifactDir, "verification-ledger.json"), JSON.stringify({ verifications: [] }))
  writeFileSync(join(artifactDir, "final-report.md"), "# Code Review Result\n")
  const marker = publicationMarker(workdir, artifactDir)
  writeFileSync(join(artifactDir, "final-report.md"), "# Unverified replacement\n")
  expect(() => reviewPublicationBundle({ BOT_WORKDIR: workdir }, marker)).toThrow(/report.*finalizer attestation/)
})

test("publication rejects trusted patch bytes that no longer match the attested manifest", () => {
  const workdir = mkdtempSync(join(tmpdir(), "mcp-publication-patch-bind-"))
  const artifactDir = join(workdir, "ctx", "review")
  mkdirSync(artifactDir, { recursive: true })
  writeFileSync(join(artifactDir, "candidate-ledger.json"), JSON.stringify({ candidates: [] }))
  writeFileSync(join(artifactDir, "verification-ledger.json"), JSON.stringify({ verifications: [] }))
  writeFileSync(join(artifactDir, "final-report.md"), "# Code Review Result\n")
  const marker = publicationMarker(workdir, artifactDir)
  writeFileSync(join(workdir, "ctx", "pr-diff.patch"), "untrusted replacement\n")
  expect(() => reviewPublicationBundle({ BOT_WORKDIR: workdir }, marker)).toThrow(/patch.*finalizer attestation/)
})

interface FakeOpts {
  listFiles?: unknown[]
  listReviews?: unknown[]
  reviewComments?: unknown[]
  issueComments?: unknown[]
  issue?: unknown
  prGet?: unknown
  prGetDiff?: string
  graphqlResult?: unknown
  graphqlResults?: unknown[]
  graphqlError?: unknown
  milestones?: unknown[]
  releases?: unknown[]
  release?: unknown
  comparison?: unknown
}

/** A minimal Octokit stand-in recording every write + serving configured reads
 *  (paginate dispatches on a `__data` tag attached to each list fn). */
function fakeOctokit(opts: FakeOpts = {}) {
  const calls = {
    pullsUpdate: [] as Record<string, unknown>[],
    merge: [] as Record<string, unknown>[],
    createReview: [] as Record<string, unknown>[],
    createComment: [] as Record<string, unknown>[],
    getComment: [] as Record<string, unknown>[],
    updateComment: [] as Record<string, unknown>[],
    checksCreate: [] as Record<string, unknown>[],
    checksUpdate: [] as Record<string, unknown>[],
    addLabels: [] as Record<string, unknown>[],
    reactions: [] as Record<string, unknown>[],
    graphql: [] as { query: string; variables: unknown }[],
    prGet: [] as Record<string, unknown>[],
    pullsCreate: [] as Record<string, unknown>[],
    milestonesCreate: [] as Record<string, unknown>[],
    milestonesUpdate: [] as Record<string, unknown>[],
    releaseGet: [] as Record<string, unknown>[],
    releaseUpdate: [] as Record<string, unknown>[],
    compareCommits: [] as Record<string, unknown>[],
    issuesUpdate: [] as Record<string, unknown>[],
    deleteComment: [] as Record<string, unknown>[],
    issuesLock: [] as Record<string, unknown>[],
    labelsGet: [] as Record<string, unknown>[],
    labelsCreate: [] as Record<string, unknown>[],
  }
  let graphqlIndex = 0
  const list = (data: unknown[]) => Object.assign(async () => ({ data }), { __data: data })
  const octokit = {
    paginate: async (fn: { __data?: unknown[] }) => fn.__data ?? [],
    graphql: async (query: string, variables: unknown) => {
      calls.graphql.push({ query, variables })
      if (opts.graphqlError) throw opts.graphqlError
      return opts.graphqlResults?.[graphqlIndex++] ?? opts.graphqlResult ?? {}
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
        create: async (p: Record<string, unknown>) => (calls.pullsCreate.push(p), {
          data: { number: 42, html_url: "https://gh/pr/42" },
        }),
      },
      issues: {
        get: async () => ({ data: opts.issue ?? {
          number: 7,
          node_id: "ISSUE_7",
          title: "Fixture",
          state: "open",
          state_reason: null,
          user: { login: "alice" },
          body: "",
          labels: [],
          assignees: [],
          milestone: null,
        } }),
        createComment: async (p: Record<string, unknown>) => (calls.createComment.push(p), { data: { id: 11, html_url: "https://gh/c/11" } }),
        getComment: async (p: Record<string, unknown>) => {
          calls.getComment.push(p)
          const comment = opts.issueComments?.find((entry) =>
            Boolean(entry) && typeof entry === "object" && (entry as { id?: unknown }).id === p.comment_id,
          )
          return { data: comment ?? { id: p.comment_id, user: { login: "cchp-bot[bot]" } } }
        },
        updateComment: async (p: Record<string, unknown>) => (calls.updateComment.push(p), { data: { id: p.comment_id, html_url: "https://gh/c/up" } }),
        deleteComment: async (p: Record<string, unknown>) => (calls.deleteComment.push(p), { data: {} }),
        addLabels: async (p: Record<string, unknown>) => (calls.addLabels.push(p), { data: [] }),
        listComments: list(opts.issueComments ?? []),
        listMilestones: list(opts.milestones ?? []),
        createMilestone: async (p: Record<string, unknown>) => (calls.milestonesCreate.push(p), {
          data: { number: 7, title: p.title, state: "open" },
        }),
        updateMilestone: async (p: Record<string, unknown>) => (calls.milestonesUpdate.push(p), {
          data: { number: p.milestone_number, state: p.state },
        }),
        update: async (p: Record<string, unknown>) => (calls.issuesUpdate.push(p), { data: { state: p.state } }),
        lock: async (p: Record<string, unknown>) => (calls.issuesLock.push(p), { data: {} }),
        getLabel: async (p: Record<string, unknown>) => (calls.labelsGet.push(p), { data: { name: p.name } }),
        createLabel: async (p: Record<string, unknown>) => (calls.labelsCreate.push(p), { data: { name: p.name } }),
      },
      checks: {
        create: async (p: Record<string, unknown>) => (calls.checksCreate.push(p), { data: { id: 777 } }),
        update: async (p: Record<string, unknown>) => (calls.checksUpdate.push(p), { data: {} }),
      },
      reactions: {
        createForIssue: async (p: Record<string, unknown>) => (calls.reactions.push(p), { data: {} }),
      },
      repos: {
        listReleases: list(opts.releases ?? []),
        getReleaseByTag: async (p: Record<string, unknown>) => (calls.releaseGet.push(p), {
          data: opts.release ?? {
            id: 91,
            tag_name: p.tag,
            name: "Release",
            body: "old",
            draft: false,
            prerelease: false,
            created_at: "2026-08-05T00:00:00Z",
          },
        }),
        updateRelease: async (p: Record<string, unknown>) => (calls.releaseUpdate.push(p), {
          data: { id: p.release_id, tag_name: "v1.0.0", html_url: "https://gh/release/v1.0.0" },
        }),
        compareCommits: async (p: Record<string, unknown>) => (calls.compareCommits.push(p), {
          data: opts.comparison ?? {
            status: "ahead",
            ahead_by: 1,
            behind_by: 0,
            total_commits: 1,
            commits: [{
              sha: "abc",
              commit: { message: "feat: ship", author: { name: "Alice" } },
              author: { login: "alice" },
            }],
            files: [{ filename: "src/a.ts", status: "modified", additions: 2, deletions: 1 }],
          },
        }),
      },
    },
  } as unknown as GitHubClient
  return { octokit, calls }
}

function deps(extra: Partial<ServerDeps> = {}): ServerDeps {
  const { octokit } = fakeOctokit()
  return { octokit, repo: REPO, env: { BOT_TASK: "engage" }, ...extra }
}

const text = (r: CallToolResult): string => (r.content[0] as { text: string }).text

test("get_failed_logs bounds each decoded failed-job log while retaining the error tail", async () => {
  const failedJobs = [{ id: 77, name: "typecheck", status: "completed", conclusion: "failure" }]
  const log = new TextEncoder().encode(
    `${Array.from({ length: WORKFLOW_LOG_MAX_LINES + 20 }, (_, index) => `setup-${index}`).join("\n")}\nFINAL 类型错误 🧨`,
  )
  const octokit = {
    paginate: async (fn: (args: unknown) => Promise<{ data: unknown[] }>, args: unknown) => (await fn(args)).data,
    rest: {
      actions: {
        getWorkflowRun: async () => ({ data: { name: "ci", status: "completed", conclusion: "failure" } }),
        listJobsForWorkflowRun: async () => ({ data: failedJobs }),
        downloadJobLogsForWorkflowRun: async () => ({ data: log }),
      },
    },
  } as unknown as GitHubClient
  const result = JSON.parse(text(await callTool(
    buildTools({ octokit, repo: REPO, env: { BOT_TASK: "ci_fix" } }),
    "get_failed_logs",
    { run_id: 123 },
  ))) as { failed_jobs: Array<{ logs: string }> }
  const compacted = result.failed_jobs[0]!.logs
  expect(compacted).toContain("FINAL 类型错误 🧨")
  expect(compacted).toContain("earlier log omitted")
  expect(compacted).not.toContain("setup-0\n")
  expect(compacted).not.toContain("�")
  expect(Buffer.byteLength(compacted, "utf8")).toBeLessThanOrEqual(WORKFLOW_LOG_MAX_BYTES)
  expect(compacted.split("\n")).toHaveLength(WORKFLOW_LOG_MAX_LINES)
})

// ── registration: tool list + input schemas ──────────────────────────────────

const EXPECTED_TOOLS = [
  "write_review_artifact",
  "write_plan",
  "write_reply",
  "upsert_sticky_comment",
  "post_structured_comment",
  "update_structured_comment",
  "post_inline_review",
  "submit_pr_review",
  "create_check_run",
  "update_check_run",
  "set_pr_title",
  "post_title_note",
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
  "search_issues_and_prs",
  "get_issue_context",
  "get_actor_permission",
  "set_issue_title",
  "delete_issue_comment",
  "delete_review_comment",
  "minimize_comment",
  "list_comment_reactions",
  "add_label",
  "remove_label",
  "set_milestone",
  "add_reaction",
  "list_review_threads",
  "resolve_review_thread",
  "rerun_workflow_run",
  "cancel_workflow_run",
  "roadmap_add_item",
  "roadmap_move_item",
  "roadmap_archive_item",
  "roadmap_bootstrap_status_schema",
  "roadmap_graphql",
  "get_discussion",
  "add_discussion_comment",
  "update_discussion_comment",
  "create_pull_request",
  "list_milestones",
  "create_milestone",
  "close_milestone",
  "list_releases",
  "get_release",
  "compare_commits",
  "update_release_notes",
  "git_fetch",
  "git_push",
  "install_web_dependencies",
]

const PR_OPENED_TOOLS = [
  "write_review_artifact",
  "write_plan",
  "write_reply",
  "post_structured_comment",
  "post_inline_review",
  "submit_pr_review",
  "add_reaction",
  "get_pr_diff",
  "get_failed_logs",
  "get_pr_context",
  "list_review_threads",
  "resolve_review_thread",
  "set_pr_title",
  "post_title_note",
  "close",
  "lock",
  "add_triage_label",
  "search_issues_and_prs",
  "get_issue_context",
  "get_actor_permission",
  "delete_issue_comment",
  "delete_review_comment",
  "minimize_comment",
  "list_comment_reactions",
  "roadmap_graphql",
  "roadmap_add_item",
  "roadmap_move_item",
  "roadmap_archive_item",
]

const TASK_TOOL_EXPECTATIONS: Record<Task, readonly string[]> = {
  engage: [
    "write_plan", "write_reply", "upsert_sticky_comment", "post_structured_comment", "update_structured_comment",
    "set_pr_title", "post_comment", "comment_file", "close", "lock", "add_triage_label", "add_label", "remove_label",
    "set_milestone", "add_reaction", "get_pr_diff", "get_pr_context", "search_issues_and_prs", "get_issue_context",
    "get_actor_permission", "delete_issue_comment", "delete_review_comment", "minimize_comment", "list_comment_reactions",
    "list_review_threads", "resolve_review_thread", "get_discussion", "add_discussion_comment", "update_discussion_comment",
    "create_pull_request", "list_milestones", "create_milestone", "close_milestone", "roadmap_graphql", "roadmap_add_item",
    "roadmap_move_item", "roadmap_archive_item", "git_fetch", "git_push", "install_web_dependencies",
  ],
  pr_opened: PR_OPENED_TOOLS,
  lgtm_merge: ["write_reply", "post_comment", "post_structured_comment", "add_lgtm_label", "merge_pr", "get_pr_context", "get_actor_permission"],
  ci_fix: [
    "write_plan", "write_reply", "upsert_sticky_comment", "post_structured_comment", "update_structured_comment", "post_comment",
    "comment_file", "get_failed_logs", "get_pr_diff", "get_pr_context", "search_issues_and_prs", "get_issue_context",
    "get_actor_permission", "create_check_run", "update_check_run", "rerun_workflow_run", "cancel_workflow_run", "create_pull_request",
    "git_fetch", "git_push", "install_web_dependencies",
  ],
  release_notes: [
    "write_reply", "search_issues_and_prs", "get_issue_context", "set_issue_title", "list_milestones", "create_milestone",
    "close_milestone", "set_milestone", "list_releases", "get_release", "compare_commits", "update_release_notes",
    "roadmap_graphql", "roadmap_add_item", "roadmap_move_item", "roadmap_archive_item",
  ],
  roadmap_item: [
    "write_reply", "search_issues_and_prs", "get_issue_context", "get_pr_context", "set_issue_title", "list_milestones",
    "create_milestone", "close_milestone", "set_milestone", "roadmap_graphql", "roadmap_add_item", "roadmap_move_item",
    "roadmap_archive_item",
  ],
  roadmap_sync: [
    "write_reply", "search_issues_and_prs", "get_issue_context", "get_pr_context", "set_issue_title", "list_milestones",
    "create_milestone", "close_milestone", "set_milestone", "roadmap_graphql", "roadmap_add_item", "roadmap_move_item",
    "roadmap_archive_item", "roadmap_bootstrap_status_schema",
  ],
  reaction_execute: [
    "write_plan", "write_reply", "update_structured_comment", "search_issues_and_prs", "get_issue_context", "get_actor_permission",
    "create_pull_request", "git_fetch", "git_push", "install_web_dependencies",
  ],
  manual: ["git_fetch", "git_push", "install_web_dependencies"],
  dispatch: ["git_fetch", "git_push", "install_web_dependencies"],
}

test("createServer exposes only the exact capability surface for every task", () => {
  for (const task of TASKS) {
    const { server, tools } = createServer(deps({ env: { BOT_TASK: task } }))
    expect(server).toBeInstanceOf(Server)
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TASK_TOOL_EXPECTATIONS[task]].sort())
  }
})

test("missing or unsupported task fails closed instead of exposing the full registry", () => {
  expect(() => buildTools(deps({ env: {} }))).toThrow("unsupported BOT_TASK")
  expect(() => buildTools(deps({ env: { BOT_TASK: "unknown" } }))).toThrow("unsupported BOT_TASK")
})

test("every advertised tool has an object input schema, a description, and no leaked handler", () => {
  const entries = new Map(TASKS.flatMap((task) => buildTools(deps({ env: { BOT_TASK: task } }))).map((tool) => [tool.name, tool]))
  const defs = toolDefinitions([...entries.values()])
  expect(defs).toHaveLength(EXPECTED_TOOLS.length)
  for (const d of defs) {
    expect(typeof d.name).toBe("string")
    expect(typeof d.description).toBe("string")
    expect(d.inputSchema.type).toBe("object")
    expect(d).not.toHaveProperty("handler")
  }
})

test("key input schemas match the contract (required fields + enums)", () => {
  const byName = new Map(TASKS.flatMap((task) => buildTools(deps({ env: { BOT_TASK: task } }))).map((t) => [t.name, t.inputSchema]))
  const merge = byName.get("merge_pr") as unknown as { properties: Record<string, unknown>; required: string[] }
  expect(merge.required).toEqual([])
  expect(merge.properties).not.toHaveProperty("pr_number")
  expect(byName.get("post_inline_review")?.required).toEqual(["fingerprints"])
  const inlineProperties = (byName.get("post_inline_review") as unknown as { properties: Record<string, unknown> }).properties
  expect(inlineProperties).toHaveProperty("fingerprints")
  expect(inlineProperties).not.toHaveProperty("comments")
  expect(inlineProperties).not.toHaveProperty("summary")
  expect(byName.get("roadmap_move_item")?.required).toEqual(["project_id", "item_id", "field_id", "option_id"])
  const submit = byName.get("submit_pr_review") as unknown as { properties: { event: { enum: string[] } } }
  expect(submit.properties.event.enum).toEqual(["COMMENT", "REQUEST_CHANGES", "APPROVE"])
  const upd = byName.get("update_check_run") as unknown as {
    properties: Record<string, unknown> & { action_keys: { items: { enum: string[] } } }
    required: string[]
  }
  expect(upd.required).toEqual(["status", "title", "summary"])
  expect(upd.properties).not.toHaveProperty("check_run_id")
  expect(upd.properties.action_keys.items.enum).toEqual(Object.keys(CHECK_ACTIONS))
})

test("pr_opened exposes only trusted review tools and removes model-selected PR targets", () => {
  const tools = buildTools(deps({ env: { BOT_TASK: "pr_opened", BOT_PR_NUMBER: "8" } }))
  expect(tools.map((tool) => tool.name).sort()).toEqual([...PR_OPENED_TOOLS].sort())

  const byName = new Map(tools.map((tool) => [tool.name, tool.inputSchema]))
  const structured = byName.get("post_structured_comment") as unknown as {
    properties: Record<string, unknown>
    required: string[]
  }
  expect(structured.required).toEqual(["summary"])
  expect(structured.properties).not.toHaveProperty("issue_number")
  expect(structured.properties).not.toHaveProperty("sticky_key")

  const submit = byName.get("submit_pr_review") as unknown as {
    properties: Record<string, unknown>
    required: string[]
  }
  expect(submit.required).toEqual(["event", "body"])
  expect(submit.properties).not.toHaveProperty("pr_number")

  const reaction = byName.get("add_reaction") as unknown as {
    properties: Record<string, unknown>
    required: string[]
  }
  expect(reaction.required).toEqual(["content"])
  expect(reaction.properties).not.toHaveProperty("number")

  for (const [name, target, required] of [
    ["set_pr_title", "pr_number", ["title"]],
    ["close", "number", ["reason"]],
    ["lock", "number", ["reason"]],
    ["add_triage_label", "pr_number", ["label"]],
  ] as const) {
    const current = byName.get(name) as unknown as { properties: Record<string, unknown>; required: string[] }
    expect(current.required).toEqual([...required])
    expect(current.properties).not.toHaveProperty(target)
  }
  const titleNote = byName.get("post_title_note") as unknown as {
    properties: Record<string, unknown>
    required: string[]
  }
  expect(titleNote.required).toEqual([])
  expect(titleNote.properties).toEqual({})
  expect(byName.has("post_comment")).toBe(false)
  expect(byName.has("comment_file")).toBe(false)
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

test("update_structured_comment binds ownership to the trusted bot login", async () => {
  const { octokit, calls } = fakeOctokit({
    issueComments: [{ id: 42, user: { login: "cchp-bot[bot]" } }],
  })
  const tools = buildTools({
    octokit,
    repo: REPO,
    env: { BOT_TASK: "engage", BOT_LOGIN: "cchp-bot[bot]" },
  })
  const result = await callTool(tools, "update_structured_comment", { comment_id: 42, summary: "done" })
  expect(result.isError).toBeUndefined()
  expect(calls.getComment).toEqual([{ owner: "CCH-HQ", repo: "repo", comment_id: 42 }])
  expect(calls.updateComment).toHaveLength(1)
})

test("artifact tools write only fixed supervisor-guarded paths outside the read-only clone", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "mcp-artifacts-"))
  mkdirSync(join(workdir, "ctx", "review"), { recursive: true })
  const tools = buildTools(deps({ env: { BOT_WORKDIR: workdir, BOT_TASK: "pr_opened" } }))
  const review = await callTool(tools, "write_review_artifact", {
    name: "coverage.json",
    content: '{"schema_version":1}\n',
  })
  expect(review.isError).toBeUndefined()
  expect(readFileSync(join(workdir, "ctx", "review", "coverage.json"), "utf8")).toBe(
    '{"schema_version":1}\n',
  )
  const plan = await callTool(tools, "write_plan", { content: "# Plan\n" })
  expect(plan.isError).toBeUndefined()
  expect(readFileSync(join(workdir, "ctx", "plan.md"), "utf8")).toBe("# Plan\n")
  expect((await callTool(tools, "write_review_artifact", { name: "../escape", content: "bad" })).isError).toBe(
    true,
  )
})

// ── publish delegation ────────────────────────────────────────────────────────

test("set_pr_title delegates to meta.setPrTitle", async () => {
  const { octokit, calls } = fakeOctokit()
  const tools = buildTools({ octokit, repo: REPO, env: { BOT_TASK: "engage", BOT_LOGIN: "bot[bot]" } })
  const res = await callTool(tools, "set_pr_title", { pr_number: 5, title: "feat: retitle" })
  expect(res.isError).toBeUndefined()
  expect(calls.pullsUpdate[0]).toMatchObject({ owner: "CCH-HQ", repo: "repo", pull_number: 5, title: "feat: retitle" })
})

test("pr_opened title and triage tools bind BOT_PR_NUMBER and keep the close purpose internal", async () => {
  const { octokit, calls } = fakeOctokit()
  const tools = buildTools({ octokit, repo: REPO, env: { BOT_TASK: "pr_opened", BOT_PR_NUMBER: "8" } })

  expect((await callTool(tools, "post_title_note", {})).isError).toBe(true)
  expect((await callTool(tools, "set_pr_title", { title: "fix: trusted title" })).isError).toBeUndefined()
  expect(calls.pullsUpdate[0]).toMatchObject({ pull_number: 8, title: "fix: trusted title" })
  const wrongTitle = await callTool(tools, "set_pr_title", { pr_number: 9, title: "fix: wrong target" })
  expect(wrongTitle.isError).toBe(true)
  expect(calls.pullsUpdate).toHaveLength(1)

  expect((await callTool(tools, "post_title_note", {})).isError).toBeUndefined()
  expect(calls.createComment.at(-1)).toMatchObject({
    issue_number: 8,
    body: "Updated the PR title to match the repository's Conventional Commit format.",
    _cchp_broker_purpose: "pr_opened_title_note",
  })
  expect((await callTool(tools, "post_title_note", { issue_number: 9 })).isError).toBe(true)
  expect((await callTool(tools, "post_title_note", {})).isError).toBe(true)
  expect(calls.createComment).toHaveLength(1)

  expect((await callTool(tools, "add_triage_label", { label: "spam" })).isError).toBeUndefined()
  expect(calls.labelsGet[0]).toMatchObject({ name: "spam" })
  expect(calls.addLabels.at(-1)).toMatchObject({ issue_number: 8, labels: ["spam"] })
  expect((await callTool(tools, "lock", { reason: "spam" })).isError).toBeUndefined()
  expect(calls.issuesLock[0]).toMatchObject({ issue_number: 8, lock_reason: "spam" })

  expect((await callTool(tools, "close", { reason: "Closing obvious spam." })).isError).toBeUndefined()
  expect(calls.createComment.at(-1)).toMatchObject({ issue_number: 8, body: "Closing obvious spam.", _cchp_broker_purpose: "pr_opened_triage_close" })
  expect(calls.issuesUpdate[0]).toMatchObject({ issue_number: 8, state: "closed", _cchp_broker_purpose: "pr_opened_triage_close" })
})

test("upsert_sticky_comment creates a marker-tagged comment when none exists", async () => {
  const { octokit, calls } = fakeOctokit({ issueComments: [] })
  const tools = buildTools({ octokit, repo: REPO, env: { BOT_TASK: "engage", BOT_LOGIN: "bot[bot]" } })
  const res = await callTool(tools, "upsert_sticky_comment", { issue_number: 7, sticky_key: "cifix", body: "overview" })
  expect(text(res)).toContain('"action":"created"')
  expect(calls.createComment[0]!.body).toContain("<!-- cchp-bot:cifix -->")
})

test("engage cannot overwrite the supervisor-owned progress sticky", async () => {
  const progressBody = "Live progress\n<!-- cchp-bot:progress:engage -->"
  const { octokit, calls } = fakeOctokit({
    issueComments: [{ id: 99, node_id: "IC_99", body: progressBody, user: { login: "bot[bot]" } }],
  })
  const tools = buildTools({ octokit, repo: REPO, env: { BOT_TASK: "engage", BOT_LOGIN: "bot[bot]" } })

  const sticky = await callTool(tools, "upsert_sticky_comment", {
    issue_number: 7,
    sticky_key: "progress:engage",
    body: "model-owned progress",
  })
  expect(sticky.isError).toBe(true)
  expect(text(sticky)).toContain("progress sticky is supervisor-owned")

  const otherTaskSticky = await callTool(tools, "upsert_sticky_comment", {
    issue_number: 7,
    sticky_key: "progress:manual",
    body: "model-owned progress",
  })
  expect(otherTaskSticky.isError).toBe(true)
  expect(text(otherTaskSticky)).toContain("progress sticky is supervisor-owned")

  const structured = await callTool(tools, "post_structured_comment", {
    issue_number: 7,
    sticky_key: "progress:engage",
    summary: "model-owned progress",
  })
  expect(structured.isError).toBe(true)
  expect(text(structured)).toContain("progress sticky is supervisor-owned")

  for (const [tool, args] of [
    ["post_comment", { issue_number: 7, comment: progressBody }],
    ["comment_file", { issue_number: 7, body: progressBody }],
    ["post_structured_comment", { issue_number: 7, summary: progressBody }],
    ["update_structured_comment", { comment_id: 99, summary: "replacement" }],
    ["delete_issue_comment", { comment_id: 99 }],
  ] as const) {
    const result = await callTool(tools, tool, args)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain("progress sticky is supervisor-owned")
  }

  expect((await callTool(tools, "get_issue_context", { issue_number: 7 })).isError).toBeUndefined()
  const minimize = await callTool(tools, "minimize_comment", { subject_id: "IC_99", classifier: "SPAM" })
  expect(minimize.isError).toBe(true)
  expect(text(minimize)).toContain("progress sticky is supervisor-owned")
  expect(calls.createComment).toHaveLength(0)
  expect(calls.updateComment).toHaveLength(0)
  expect(calls.deleteComment).toHaveLength(0)
  expect(calls.graphql).toHaveLength(0)
})

test("pr_opened rejects malicious publication targets before finalization and hides unsafe mutations", async () => {
  const { octokit, calls } = fakeOctokit()
  const tools = buildTools({
    octokit,
    repo: REPO,
    env: { BOT_TASK: "pr_opened", BOT_PR_NUMBER: "8" },
  })

  const crossPr = await callTool(tools, "submit_pr_review", {
    pr_number: 999,
    event: "COMMENT",
    body: "publish on another PR",
  })
  expect(crossPr.isError).toBe(true)
  expect(text(crossPr)).toContain("pr_number must match trusted BOT_PR_NUMBER 8")
  expect(calls.createReview).toHaveLength(0)

  const merge = await callTool(tools, "merge_pr", {
    pr_number: 8,
    head_repo_full_name: REPO,
  })
  expect(merge.isError).toBe(true)
  expect(text(merge)).toContain("unknown tool: merge_pr")
  expect(calls.merge).toHaveLength(0)
})

test("pr_opened review publication fails closed before any GitHub write when finalizer inputs are absent", async () => {
  const { octokit, calls } = fakeOctokit()
  const workdir = mkdtempSync(join(tmpdir(), "mcp-finalizer-"))
  mkdirSync(join(workdir, "ctx", "review"), { recursive: true })
  mkdirSync(join(workdir, "ctx", "codex"), { recursive: true })
  new ProvenanceLedger(join(workdir, "ctx", "codex", "provenance.jsonl"), "run-1").record("state", { state: "ROOT_RUNNING" })
  const tools = buildTools({
    octokit,
    repo: REPO,
    env: { BOT_TASK: "pr_opened", BOT_WORKDIR: workdir, BOT_REPO: REPO, BOT_RUN_ID: "run-1", BOT_PR_NUMBER: "8", BOT_HEAD_SHA: "h" },
  })
  const res = await callTool(tools, "submit_pr_review", { pr_number: 8, event: "COMMENT", body: "finding" })
  expect(res.isError).toBe(true)
  expect(text(res)).toContain("review admission ledger is missing")
  expect(calls.createReview).toHaveLength(0)
})

test("update_check_run uses only the run-created Check Run and rejects model-selected ids", async () => {
  const { octokit, calls } = fakeOctokit()
  const tools = buildTools({
    octokit,
    repo: REPO,
    env: {
      BOT_TASK: "ci_fix",
      BOT_HEAD_SHA: "a".repeat(40),
      BOT_RUN_ID: "engine-2-random",
      CCHP_WORKFLOW_RUN_ID: "123",
    },
  })
  const beforeCreate = await callTool(tools, "update_check_run", {
    status: "completed", title: "Blocked", summary: "1 finding",
  })
  expect(beforeCreate.isError).toBe(true)
  expect(text(beforeCreate)).toContain("create_check_run")

  expect((await callTool(tools, "create_check_run", {})).isError).toBeUndefined()
  expect(calls.checksCreate[0]).toMatchObject({ external_id: "123" })
  const ok = await callTool(tools, "update_check_run", {
    status: "completed",
    conclusion: "failure",
    title: "Blocked",
    summary: "1 finding",
    action_keys: ["applyFixes", "dismiss"],
  })
  expect(ok.isError).toBeUndefined()
  expect(calls.checksUpdate[0]).toMatchObject({ check_run_id: 777, status: "completed", conclusion: "failure" })
  expect((calls.checksUpdate[0]!.actions as { identifier: string }[]).map((x) => x.identifier)).toEqual(["apply-fixes", "dismiss"])

  const forged = await callTool(tools, "update_check_run", {
    check_run_id: 999, status: "completed", title: "t", summary: "s",
  })
  expect(forged.isError).toBe(true)
  expect(calls.checksUpdate).toHaveLength(1)

  const bad = await callTool(tools, "update_check_run", { status: "completed", title: "t", summary: "s", action_keys: ["nope"] })
  expect(bad.isError).toBe(true)
  expect(text(bad)).toContain("unknown action key: nope")
})

// ── fork gate (security-critical) ─────────────────────────────────────────────

test("merge_pr NEVER auto-merges a fork (fork gate), and squash-merges same-repo", async () => {
  const forkClient = fakeOctokit({ prGet: { head: { repo: { full_name: "attacker/repo" } } } })
  const forkTools = buildTools({ octokit: forkClient.octokit, repo: REPO, env: { BOT_TASK: "lgtm_merge", BOT_PR_NUMBER: "8" } })
  const fork = await callTool(forkTools, "merge_pr", {})
  expect(text(fork)).toContain('"merged":false')
  expect(text(fork)).toContain("fork")
  expect(forkClient.calls.merge).toHaveLength(0)

  const deletedForkClient = fakeOctokit({ prGet: { head: { repo: null } } })
  const forkNull = await callTool(buildTools({ octokit: deletedForkClient.octokit, repo: REPO, env: { BOT_TASK: "lgtm_merge", BOT_PR_NUMBER: "8" } }), "merge_pr", {})
  expect(text(forkNull)).toContain('"merged":false')
  expect(deletedForkClient.calls.merge).toHaveLength(0)

  const sameRepoClient = fakeOctokit({ prGet: { head: { repo: { full_name: REPO } } } })
  const sameTools = buildTools({ octokit: sameRepoClient.octokit, repo: REPO, env: { BOT_TASK: "lgtm_merge", BOT_PR_NUMBER: "8" } })
  const forged = await callTool(sameTools, "merge_pr", { pr_number: 9 })
  expect(forged.isError).toBe(true)
  expect(sameRepoClient.calls.merge).toHaveLength(0)
  const same = await callTool(sameTools, "merge_pr", {})
  expect(text(same)).toContain('"merged":true')
  expect(sameRepoClient.calls.merge[0]).toMatchObject({ pull_number: 8, merge_method: "squash" })
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
  const tools = buildTools({ octokit, repo: REPO, env: { BOT_TASK: "engage" } })
  const res = await callTool(tools, "get_pr_context", { pr_number: 8 })
  const parsed = JSON.parse(text(res))
  expect(parsed).toMatchObject({ number: 8, title: "feat: x", head_repo_full_name: "CCH-HQ/repo" })
  expect(parsed.files[0].filename).toBe("foo.ts")
  expect(parsed.reviews[0].user).toBe("bob")
})

test("get_pr_diff returns the raw unified diff text", async () => {
  const { octokit, calls } = fakeOctokit({ prGetDiff: PATCH })
  const tools = buildTools({ octokit, repo: REPO, env: { BOT_TASK: "engage" } })
  const res = await callTool(tools, "get_pr_diff", { pr_number: 8 })
  expect(text(res)).toBe(PATCH)
  expect((calls.prGet[0]!.mediaType as { format: string }).format).toBe("diff")
})

// ── mutations (raw Octokit) ────────────────────────────────────────────────────

test("roadmap_move_item runs the updateProjectV2ItemFieldValue mutation via the shared client", async () => {
  const { octokit, calls } = fakeOctokit({ graphqlResult: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "IT_1" } } } })
  const tools = buildTools({ octokit, repo: REPO, env: { BOT_TASK: "roadmap_item" } })
  const res = await callTool(tools, "roadmap_move_item", { project_id: "PVT_1", item_id: "IT_1", field_id: "F_1", option_id: "OPT_done" })
  expect(text(res)).toContain('"item_id":"IT_1"')
  expect(calls.graphql[0]!.query).toContain("updateProjectV2ItemFieldValue")
  expect(calls.graphql[0]!.variables).toMatchObject({ p: "PVT_1", i: "IT_1", f: "F_1", o: "OPT_done" })
})

test("roadmap_archive_item runs the fixed archive mutation", async () => {
  const { octokit, calls } = fakeOctokit({ graphqlResult: { archiveProjectV2Item: { item: { id: "IT_1" } } } })
  const tools = buildTools({ octokit, repo: REPO, env: { BOT_TASK: "roadmap_item" } })
  const res = await callTool(tools, "roadmap_archive_item", { project_id: "PVT_1", item_id: "IT_1" })
  expect(JSON.parse(text(res))).toEqual({ item_id: "IT_1" })
  expect(calls.graphql[0]!.query).toContain("archiveProjectV2Item")
  expect(calls.graphql[0]!.variables).toEqual({ p: "PVT_1", i: "IT_1" })
})

test("roadmap bootstrap creates or updates Status before normalizing the trusted project", async () => {
  const created = fakeOctokit({
    graphqlResults: [
      { createProjectV2Field: { projectV2Field: { id: "F_NEW" } } },
      { updateProjectV2: { projectV2: { id: "PVT_1" } } },
    ],
  })
  const createTools = buildTools({ octokit: created.octokit, repo: REPO, env: { BOT_TASK: "roadmap_sync" } })
  const createResult = await callTool(createTools, "roadmap_bootstrap_status_schema", { project_id: "PVT_1" })
  expect(JSON.parse(text(createResult))).toMatchObject({ project_id: "PVT_1", status_field_id: "F_NEW", created: true })
  expect(created.calls.graphql.map((call) => call.query)).toEqual([
    expect.stringContaining("createProjectV2Field"),
    expect.stringContaining("updateProjectV2"),
  ])

  const updated = fakeOctokit({
    graphqlResults: [
      { updateProjectV2Field: { projectV2Field: { id: "F_1" } } },
      { updateProjectV2: { projectV2: { id: "PVT_1" } } },
    ],
  })
  const updateTools = buildTools({ octokit: updated.octokit, repo: REPO, env: { BOT_TASK: "roadmap_sync" } })
  const updateResult = await callTool(updateTools, "roadmap_bootstrap_status_schema", { project_id: "PVT_1", status_field_id: "F_1" })
  expect(JSON.parse(text(updateResult))).toMatchObject({ status_field_id: "F_1", created: false })
  expect(updated.calls.graphql.map((call) => call.query)).toEqual([
    expect.stringContaining("updateProjectV2Field"),
    expect.stringContaining("updateProjectV2"),
  ])
})

test("roadmap bootstrap short-circuits before project mutation when Status creation fails", async () => {
  const { octokit, calls } = fakeOctokit({ graphqlError: new Error("status create failed") })
  const tools = buildTools({ octokit, repo: REPO, env: { BOT_TASK: "roadmap_sync" } })
  const result = await callTool(tools, "roadmap_bootstrap_status_schema", { project_id: "PVT_1" })
  expect(result.isError).toBe(true)
  expect(text(result)).toContain("status create failed")
  expect(calls.graphql).toHaveLength(1)
  expect(calls.graphql[0]!.query).toContain("createProjectV2Field")
})

test("discussion tools bind the trusted number and use fixed query and mutation documents", async () => {
  const { octokit, calls } = fakeOctokit({
    graphqlResults: [
      {
        repository: {
          discussion: {
            id: "D_1",
            number: 9,
            title: "Design",
            comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "DC_1", body: "old" }] },
          },
        },
      },
      { addDiscussionComment: { comment: { id: "DC_2" } } },
      { updateDiscussionComment: { comment: { id: "DC_2" } } },
    ],
  })
  const tools = buildTools({ octokit, repo: REPO, env: { BOT_TASK: "engage", BOT_DISCUSSION_NUMBER: "9" } })

  const discussion = await callTool(tools, "get_discussion", { number: 9 })
  expect(JSON.parse(text(discussion))).toMatchObject({ id: "D_1", number: 9, comments: [{ id: "DC_1" }] })
  expect(calls.graphql[0]!.query).toContain("discussion(number:$number)")
  expect(calls.graphql[0]!.variables).toMatchObject({ owner: "CCH-HQ", name: "repo", number: 9 })

  const wrong = await callTool(tools, "get_discussion", { number: 10 })
  expect(wrong.isError).toBe(true)
  expect(calls.graphql).toHaveLength(1)

  expect(JSON.parse(text(await callTool(tools, "add_discussion_comment", { discussion_id: "D_1", body: "new" })))).toEqual({ comment_id: "DC_2" })
  expect(calls.graphql[1]!.query).toContain("addDiscussionComment")
  expect(calls.graphql[1]!.variables).toEqual({ id: "D_1", body: "new" })

  expect(JSON.parse(text(await callTool(tools, "update_discussion_comment", { comment_id: "DC_2", body: "edited" })))).toEqual({ comment_id: "DC_2" })
  expect(calls.graphql[2]!.query).toContain("updateDiscussionComment")
  expect(calls.graphql[2]!.variables).toEqual({ id: "DC_2", body: "edited" })
})

test("create_pull_request maps the trusted repository and branch metadata", async () => {
  const { octokit, calls } = fakeOctokit()
  const tools = buildTools({ octokit, repo: REPO, env: { BOT_TASK: "engage" } })
  const res = await callTool(tools, "create_pull_request", {
    base: "dev",
    head: "bot/fix",
    title: "fix: repair CI",
    body: "Automated repair",
  })
  expect(JSON.parse(text(res))).toEqual({ number: 42, url: "https://gh/pr/42" })
  expect(calls.pullsCreate).toEqual([{
    owner: "CCH-HQ",
    repo: "repo",
    base: "dev",
    head: "bot/fix",
    title: "fix: repair CI",
    body: "Automated repair",
  }])
})

test("milestone tools list, create, and close by milestone number", async () => {
  const { octokit, calls } = fakeOctokit({
    milestones: [{ number: 3, title: "v1", state: "open", due_on: null }],
  })
  const tools = buildTools({ octokit, repo: REPO, env: { BOT_TASK: "engage" } })
  expect(JSON.parse(text(await callTool(tools, "list_milestones", {})))).toEqual([
    { number: 3, title: "v1", state: "open", due_on: null },
  ])
  expect(JSON.parse(text(await callTool(tools, "create_milestone", { title: "v2", description: "Next" })))).toEqual({
    number: 7,
    title: "v2",
    state: "open",
  })
  expect(calls.milestonesCreate[0]).toMatchObject({ owner: "CCH-HQ", repo: "repo", title: "v2", description: "Next" })
  expect(JSON.parse(text(await callTool(tools, "close_milestone", { milestone_number: 7 })))).toEqual({ number: 7, state: "closed" })
  expect(calls.milestonesUpdate[0]).toMatchObject({ milestone_number: 7, state: "closed" })
})

test("release tools bind BOT_RELEASE_TAG, compare refs, and update the discovered release", async () => {
  const { octokit, calls } = fakeOctokit({
    releases: [{ id: 90, tag_name: "v0.9.0", name: "Old", draft: false, prerelease: false, created_at: "t" }],
  })
  const tools = buildTools({ octokit, repo: REPO, env: { BOT_TASK: "release_notes", BOT_RELEASE_TAG: "v1.0.0" } })
  expect(JSON.parse(text(await callTool(tools, "list_releases", {})))[0]).toMatchObject({ id: 90, tag_name: "v0.9.0" })

  const wrong = await callTool(tools, "get_release", { tag: "v2.0.0" })
  expect(wrong.isError).toBe(true)
  expect(calls.releaseGet).toHaveLength(0)

  expect(JSON.parse(text(await callTool(tools, "get_release", { tag: "v1.0.0" })))).toMatchObject({ id: 91, tag_name: "v1.0.0" })
  expect(calls.releaseGet[0]).toMatchObject({ owner: "CCH-HQ", repo: "repo", tag: "v1.0.0" })

  const comparison = JSON.parse(text(await callTool(tools, "compare_commits", { base: "v0.9.0", head: "v1.0.0" })))
  expect(comparison).toMatchObject({ status: "ahead", total_commits: 1, commits: [{ sha: "abc", author: "alice" }] })
  expect(calls.compareCommits[0]).toMatchObject({ base: "v0.9.0", head: "v1.0.0" })

  expect(JSON.parse(text(await callTool(tools, "update_release_notes", { tag: "v1.0.0", body: "# Notes" })))).toEqual({
    id: 91,
    tag_name: "v1.0.0",
    url: "https://gh/release/v1.0.0",
  })
  expect(calls.releaseGet).toHaveLength(2)
  expect(calls.releaseUpdate[0]).toMatchObject({ release_id: 91, body: "# Notes" })
})

test("add_label validates the labels array before calling Octokit", async () => {
  const { octokit, calls } = fakeOctokit()
  const tools = buildTools({ octokit, repo: REPO, env: { BOT_TASK: "engage" } })
  const ok = await callTool(tools, "add_label", { number: 5, labels: ["needs-triage"] })
  expect(ok.isError).toBeUndefined()
  expect(calls.addLabels[0]).toMatchObject({ issue_number: 5, labels: ["needs-triage"] })

  const bad = await callTool(tools, "add_label", { number: 5, labels: [] })
  expect(bad.isError).toBe(true)
  expect(calls.addLabels).toHaveLength(1) // unchanged
})

test("add_reaction posts the reaction and rejects unknown content", async () => {
  const { octokit, calls } = fakeOctokit()
  const tools = buildTools({ octokit, repo: REPO, env: { BOT_TASK: "engage" } })
  const ok = await callTool(tools, "add_reaction", { number: 8, content: "+1" })
  expect(ok.isError).toBeUndefined()
  expect(calls.reactions[0]).toMatchObject({ issue_number: 8, content: "+1" })

  const bad = await callTool(tools, "add_reaction", { number: 8, content: "sparkles" })
  expect(bad.isError).toBe(true)
  expect(calls.reactions).toHaveLength(1)
})

test("list_review_threads pages through reviewThreads and returns every reviewer's threads", async () => {
  const thread = {
    id: "RT_1",
    isResolved: false,
    isOutdated: false,
    path: "foo.ts",
    line: 2,
    startLine: null,
    comments: { nodes: [{ databaseId: 9, author: { login: "greptile-apps" }, body: "nil deref", createdAt: "t" }] },
  }
  const { octokit, calls } = fakeOctokit({
    graphqlResult: {
      repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [thread] } } },
    },
  })
  const tools = buildTools({ octokit, repo: REPO, env: { BOT_TASK: "engage" } })
  const res = await callTool(tools, "list_review_threads", { pr_number: 8 })
  const parsed = JSON.parse(text(res))
  expect(parsed.pr_number).toBe(8)
  expect(parsed.threads).toEqual([thread])
  expect(calls.graphql[0]!.query).toContain("reviewThreads")
  expect(calls.graphql[0]!.variables).toMatchObject({ number: 8 })
})

test("resolve_review_thread runs the resolveReviewThread mutation by node id", async () => {
  const { octokit, calls } = fakeOctokit({
    graphqlResult: { resolveReviewThread: { thread: { id: "RT_1", isResolved: true } } },
  })
  const tools = buildTools({ octokit, repo: REPO, env: { BOT_TASK: "engage" } })
  const res = await callTool(tools, "resolve_review_thread", { thread_id: "RT_1" })
  expect(JSON.parse(text(res))).toEqual({ thread_id: "RT_1", is_resolved: true })
  expect(calls.graphql[0]!.query).toContain("resolveReviewThread")
  expect(calls.graphql[0]!.variables).toMatchObject({ id: "RT_1" })
})

// ── entry guards ───────────────────────────────────────────────────────────────

test("main() fails fast without BOT_REPO / GH_TOKEN", async () => {
  const { main } = await import("./server")
  await expect(main({})).rejects.toThrow("BOT_REPO is required")
  await expect(main({ BOT_REPO: REPO })).rejects.toThrow("GH_TOKEN is required")
})

test("resolveTokenSource accepts only the direct static fallback", async () => {
  const { resolveTokenSource } = await import("./server")
  expect(resolveTokenSource({ GH_TOKEN: "ghs_static" })).toBe("ghs_static")
  expect(() => resolveTokenSource({})).toThrow("GH_TOKEN is required")
})
