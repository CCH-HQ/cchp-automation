import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openRegularFileSnapshot, type FileSnapshot } from "../codex/file-snapshot"
import type { GitHubClient } from "../github/client"
import { CHECK_RUN_NAME } from "../publish/checkrun"
import { makeBrokerGitHubClient, startGitHubBroker } from "./github-broker"
import {
  DISCUSSION_ADD_COMMENT,
  DISCUSSION_QUERY,
  DISCUSSION_UPDATE_COMMENT,
  MINIMIZE_COMMENT,
  RESOLVE_THREAD_MUTATION,
  REVIEW_THREADS_QUERY,
  ROADMAP_ADD_ITEM,
  ROADMAP_ARCHIVE_ITEM,
  ROADMAP_CREATE_STATUS_FIELD,
  ROADMAP_DISCOVERY_QUERY,
  ROADMAP_MOVE_ITEM,
  ROADMAP_PROJECT_DESCRIPTION,
  ROADMAP_PROJECT_README,
  ROADMAP_STATUS_OPTIONS,
  ROADMAP_UPDATE_PROJECT,
  ROADMAP_UPDATE_STATUS_FIELD,
} from "./graphql-contract"

interface FakeClientOptions {
  prHeadRepo?: string | null
  prHeadSha?: string
  releaseResponseTag?: string
  roadmapForeignContent?: boolean
}

type RunCommand = NonNullable<Parameters<typeof startGitHubBroker>[0]["runCommand"]>

function fakeClient(options: FakeClientOptions = {}) {
  const calls: Array<{ operation: string; args: Record<string, unknown> }> = []
  const client = {
    rest: {
      pulls: {
        get: async (args: Record<string, unknown>) => {
          calls.push({ operation: "pulls.get", args })
          return { data: {
            number: args.pull_number,
            node_id: `PR_${args.pull_number}`,
            head: {
              sha: options.prHeadSha ?? "a".repeat(40),
              repo: options.prHeadRepo === null ? null : { full_name: options.prHeadRepo ?? "CCH-HQ/fixture" },
            },
          } }
        },
        listFiles: async (args: Record<string, unknown>) => { calls.push({ operation: "pulls.listFiles", args }); return [{ filename: "README.md" }] },
        listReviews: async (args: Record<string, unknown>) => { calls.push({ operation: "pulls.listReviews", args }); return [] },
        listReviewComments: async (args: Record<string, unknown>) => { calls.push({ operation: "pulls.listReviewComments", args }); return [] },
        createReview: async (args: Record<string, unknown>) => { calls.push({ operation: "pulls.createReview", args }); return { data: { id: 1 } } },
        createReviewComment: async (args: Record<string, unknown>) => { calls.push({ operation: "pulls.createReviewComment", args }); return { data: { id: 2 } } },
        update: async (args: Record<string, unknown>) => { calls.push({ operation: "pulls.update", args }); return { data: { number: args.pull_number, title: args.title } } },
        merge: async (args: Record<string, unknown>) => { calls.push({ operation: "pulls.merge", args }); return { data: { merged: true } } },
        deleteReviewComment: async (args: Record<string, unknown>) => { calls.push({ operation: "pulls.deleteReviewComment", args }); return { data: {} } },
        create: async (args: Record<string, unknown>) => { calls.push({ operation: "pulls.create", args }); return { data: { number: 43 } } },
      },
      issues: {
        get: async (args: Record<string, unknown>) => {
          calls.push({ operation: "issues.get", args })
          return { data: { number: args.issue_number, node_id: `ISSUE_${args.issue_number}`, pull_request: undefined } }
        },
        listComments: async (args: Record<string, unknown>) => { calls.push({ operation: "issues.listComments", args }); return [{ id: 91, node_id: "IC_91" }] },
        createComment: async (args: Record<string, unknown>) => { calls.push({ operation: "issues.createComment", args }); return { data: { id: 2 } } },
        updateComment: async (args: Record<string, unknown>) => { calls.push({ operation: "issues.updateComment", args }); return { data: { id: args.comment_id } } },
        listMilestones: async (args: Record<string, unknown>) => {
          calls.push({ operation: "issues.listMilestones", args })
          return [{ id: 9001, number: 7, title: "v1", state: "open" }]
        },
        createMilestone: async (args: Record<string, unknown>) => {
          calls.push({ operation: "issues.createMilestone", args })
          return { data: { id: 9002, number: 8, title: args.title, state: "open" } }
        },
        updateMilestone: async (args: Record<string, unknown>) => {
          calls.push({ operation: "issues.updateMilestone", args })
          return { data: { id: 9002, number: args.milestone_number, state: args.state } }
        },
        update: async (args: Record<string, unknown>) => { calls.push({ operation: "issues.update", args }); return { data: { number: args.issue_number, state: args.state } } },
        lock: async (args: Record<string, unknown>) => { calls.push({ operation: "issues.lock", args }); return { data: {} } },
        getLabel: async (args: Record<string, unknown>) => { calls.push({ operation: "issues.getLabel", args }); return { data: { name: args.name } } },
        createLabel: async (args: Record<string, unknown>) => { calls.push({ operation: "issues.createLabel", args }); return { data: { name: args.name, color: args.color } } },
        addLabels: async (args: Record<string, unknown>) => { calls.push({ operation: "issues.addLabels", args }); return { data: [] } },
        removeLabel: async (args: Record<string, unknown>) => { calls.push({ operation: "issues.removeLabel", args }); return { data: [] } },
        deleteComment: async (args: Record<string, unknown>) => { calls.push({ operation: "issues.deleteComment", args }); return { data: {} } },
      },
      reactions: {
        createForIssue: async (args: Record<string, unknown>) => { calls.push({ operation: "reactions.createForIssue", args }); return { data: { id: 3 } } },
        listForIssueComment: async (args: Record<string, unknown>) => { calls.push({ operation: "reactions.listForIssueComment", args }); return [{ id: 4 }] },
      },
      actions: {
        getWorkflowRun: async (args: Record<string, unknown>) => ({ data: args }),
        listJobsForWorkflowRun: async (args: Record<string, unknown>) => [{ id: 4, ...args }],
        downloadJobLogsForWorkflowRun: async () => ({ data: "logs" }),
        reRunWorkflowFailedJobs: async (args: Record<string, unknown>) => { calls.push({ operation: "actions.reRunWorkflowFailedJobs", args }); return { data: {} } },
        reRunWorkflow: async (args: Record<string, unknown>) => { calls.push({ operation: "actions.reRunWorkflow", args }); return { data: {} } },
        cancelWorkflowRun: async (args: Record<string, unknown>) => { calls.push({ operation: "actions.cancelWorkflowRun", args }); return { data: {} } },
      },
      checks: {
        create: async (args: Record<string, unknown>) => { calls.push({ operation: "checks.create", args }); return { data: { id: 777 } } },
        update: async (args: Record<string, unknown>) => { calls.push({ operation: "checks.update", args }); return { data: { id: args.check_run_id } } },
      },
      search: {
        issuesAndPullRequests: async (args: Record<string, unknown>) => {
          calls.push({ operation: "search.issuesAndPullRequests", args })
          return [
            { number: 9, node_id: "ISSUE_9", title: "Issue", pull_request: undefined },
            { number: 10, node_id: "PR_10", title: "PR", pull_request: { url: "x" } },
          ]
        },
      },
      repos: {
        getCollaboratorPermissionLevel: async (args: Record<string, unknown>) => {
          calls.push({ operation: "repos.getCollaboratorPermissionLevel", args })
          return { data: { permission: "write" } }
        },
        listReleases: async (args: Record<string, unknown>) => {
          calls.push({ operation: "repos.listReleases", args })
          return [{ id: 90, tag_name: "v0.9.0" }]
        },
        getReleaseByTag: async (args: Record<string, unknown>) => {
          calls.push({ operation: "repos.getReleaseByTag", args })
          return { data: { id: 91, tag_name: options.releaseResponseTag ?? args.tag } }
        },
        updateRelease: async (args: Record<string, unknown>) => {
          calls.push({ operation: "repos.updateRelease", args })
          return { data: { id: args.release_id, tag_name: "v1.0.0" } }
        },
        compareCommits: async (args: Record<string, unknown>) => { calls.push({ operation: "repos.compareCommits", args }); return { data: {} } },
      },
      orgs: {
        checkMembershipForUser: async (args: Record<string, unknown>) => { calls.push({ operation: "orgs.checkMembershipForUser", args }); return { data: {} } },
      },
      users: {
        getAuthenticated: async (args: Record<string, unknown>) => { calls.push({ operation: "users.getAuthenticated", args }); return { data: { login: "bot" } } },
      },
    },
    paginate: async (fn: (args: Record<string, unknown>) => Promise<unknown>, args: Record<string, unknown>) => fn(args),
    graphql: async (query: string, variables: Record<string, unknown>) => {
      calls.push({ operation: "graphql", args: { query, ...variables } })
      if (query.includes("projectV2(number:")) {
        return { organization: { projectV2: {
          id: "PVT_1",
          fields: { nodes: [{ id: "F_1", options: [{ id: "O_1" }] }] },
          items: { nodes: [
            { id: "PVTI_1", content: { id: "ISSUE_9", number: 9, __typename: "Issue", repository: { nameWithOwner: "CCH-HQ/fixture" } } },
            { id: "PVTI_OTHER", content: {
              id: "ISSUE_OTHER",
              number: 10,
              __typename: "Issue",
              repository: { nameWithOwner: options.roadmapForeignContent ? "CCH-HQ/other" : "CCH-HQ/fixture" },
            } },
          ] },
        } } }
      }
      if (query.includes("discussion(number:")) {
        return { repository: { discussion: { id: "D_1", comments: { nodes: [{ id: "DC_1" }] } } } }
      }
      if (query.includes("addProjectV2ItemById")) return { addProjectV2ItemById: { item: { id: "PVTI_2" } } }
      if (query.includes("updateProjectV2ItemFieldValue")) return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } } }
      if (query.includes("archiveProjectV2Item")) return { archiveProjectV2Item: { item: { id: "PVTI_1" } } }
      if (query.includes("createProjectV2Field")) return { createProjectV2Field: { projectV2Field: { id: "F_NEW" } } }
      if (query.includes("updateProjectV2Field")) return { updateProjectV2Field: { projectV2Field: { id: variables.f } } }
      if (query.includes("updateProjectV2(")) return { updateProjectV2: { projectV2: { id: variables.p } } }
      if (query.includes("minimizeComment")) return { minimizeComment: { minimizedComment: { isMinimized: true } } }
      if (query.includes("addDiscussionComment")) return { addDiscussionComment: { comment: { id: "DC_2" } } }
      if (query.includes("updateDiscussionComment")) return { updateDiscussionComment: { comment: { id: variables.id } } }
      if (query.includes("reviewThreads")) return { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "RT_1" }] } } } }
      if (query.includes("resolveReviewThread")) return { resolveReviewThread: { thread: { id: variables.id, isResolved: true } } }
      return { ok: true }
    },
  } as unknown as GitHubClient
  return { client, calls }
}

async function withBroker(
  run: (client: GitHubClient, marker: string, calls: Array<{ operation: string; args: Record<string, unknown> }>) => Promise<void>,
  options: {
    task?: string
    target?: number
    targetKind?: "pr" | "issue" | "discussion"
    trustedCommentId?: number
    roadmapProject?: number
    releaseTag?: string
    workflowRunId?: number
    fake?: FakeClientOptions
    noDefaultTarget?: boolean
    snapshotFile?: (path: string) => FileSnapshot
    repoDir?: string
    allowRepositoryMutation?: boolean
    herouiAuthToken?: string
    runCommand?: RunCommand
  } = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "cchp-github-broker-"))
  const marker = join(root, "review-finalized.json")
  const fake = fakeClient(options.fake)
  const broker = await startGitHubBroker({
    socketPath: join(root, "broker.sock"),
    repo: "CCH-HQ/fixture",
    task: options.task ?? "pr_opened",
    target: options.noDefaultTarget ? options.target : options.target ?? 42,
    targetKind: options.noDefaultTarget ? options.targetKind : options.targetKind ?? "pr",
    trustedCommentId: options.trustedCommentId,
    roadmapProject: options.roadmapProject,
    releaseTag: options.releaseTag,
    workflowRunId: options.workflowRunId,
    finalizerMarker: marker,
    expectedHeadSha: "a".repeat(40),
    expectedRunId: "run-1",
    snapshotFile: options.snapshotFile,
    octokit: fake.client,
    repoDir: options.repoDir,
    allowRepositoryMutation: options.allowRepositoryMutation,
    herouiAuthToken: options.herouiAuthToken,
    runCommand: options.runCommand,
  })
  try {
    expect(statSync(broker.socketPath).mode & 0o777).toBe(0o600)
    await run(makeBrokerGitHubClient(broker.socketPath, broker.token), marker, fake.calls)
  } finally {
    await broker.close()
  }
}

function finalizedMarker() {
  return {
    schema_version: 1,
    valid: true,
    repository: "CCH-HQ/fixture",
    pr_number: 42,
    run_id: "run-1",
    provenance_sha256: "d".repeat(64),
    head_sha: "a".repeat(40),
    trusted_manifest_sha256: "b".repeat(64),
    patch_sha256: "e".repeat(64),
    artifacts: Object.fromEntries(["manifest", "coverage", "candidates", "verification", "report", "admission_ledger", "review_results"].map((key) => [key, "c".repeat(64)])),
    finalized_at: "2026-08-05T00:00:00Z",
  }
}

test("review mutations require the trusted finalized head SHA", async () => {
  await withBroker(async (client, marker) => {
    writeFileSync(marker, JSON.stringify(finalizedMarker()))
    const trusted = "a".repeat(40)
    await expect(client.rest.pulls.createReview({
      owner: "CCH-HQ", repo: "fixture", pull_number: 42, event: "COMMENT", body: "ok",
    })).rejects.toThrow("commit SHA")
    await expect(client.rest.pulls.createReview({
      owner: "CCH-HQ", repo: "fixture", pull_number: 42, event: "COMMENT", body: "ok", commit_id: "b".repeat(40),
    })).rejects.toThrow("commit SHA")
    await expect(client.rest.pulls.createReview({
      owner: "CCH-HQ", repo: "fixture", pull_number: 42, event: "COMMENT", body: "ok", commit_id: trusted,
    })).resolves.toMatchObject({ data: { id: 1 } })

    await expect(client.rest.pulls.createReviewComment({
      owner: "CCH-HQ", repo: "fixture", pull_number: 42, body: "ok", path: "README.md", line: 1,
    } as never)).rejects.toThrow("commit SHA")
    await expect(client.rest.pulls.createReviewComment({
      owner: "CCH-HQ", repo: "fixture", pull_number: 42, body: "ok", path: "README.md", line: 1, commit_id: "b".repeat(40),
    })).rejects.toThrow("commit SHA")
    await expect(client.rest.pulls.createReviewComment({
      owner: "CCH-HQ", repo: "fixture", pull_number: 42, body: "ok", path: "README.md", line: 1, commit_id: trusted,
    })).resolves.toMatchObject({ data: { id: 2 } })
  })
})

test("review publication and thread resolution reject a live PR head change before mutation", async () => {
  await withBroker(async (client, marker, calls) => {
    writeFileSync(marker, JSON.stringify(finalizedMarker()))
    await client.graphql(REVIEW_THREADS_QUERY, { owner: "CCH-HQ", name: "fixture", number: 42, cursor: null })
    const trusted = "a".repeat(40)
    await expect(client.rest.pulls.createReview({
      owner: "CCH-HQ", repo: "fixture", pull_number: 42, event: "COMMENT", body: "summary", commit_id: trusted,
    })).rejects.toThrow("live PR head changed")
    await expect(client.rest.pulls.createReviewComment({
      owner: "CCH-HQ", repo: "fixture", pull_number: 42, body: "inline", path: "a.ts", line: 1, side: "RIGHT", commit_id: trusted,
    })).rejects.toThrow("live PR head changed")
    await expect(client.rest.issues.createComment({
      owner: "CCH-HQ", repo: "fixture", issue_number: 42, body: "top-level summary",
    })).rejects.toThrow("live PR head changed")
    await expect(client.graphql(RESOLVE_THREAD_MUTATION, { id: "RT_1" })).rejects.toThrow("live PR head changed")
    expect(calls.filter((call) => ["pulls.createReview", "pulls.createReviewComment", "issues.createComment"].includes(call.operation))).toEqual([])
    expect(calls.filter((call) => call.operation === "graphql")).toHaveLength(1)
  }, { fake: { prHeadSha: "b".repeat(40) } })
})

test("typed host Git and dependency operations use fixed commands, cwd and secret boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-broker-runtime-"))
  const repoDir = join(root, "repo")
  mkdirSync(join(repoDir, "web"), { recursive: true })
  writeFileSync(join(repoDir, "web", "package.json"), "{}\n")
  const calls: Array<{ command: string; args: string[]; cwd: string; env: Record<string, string> }> = []
  const runCommand: RunCommand = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env })
    return { stdout: "ok", stderr: "" }
  }
  await withBroker(async (client) => {
    await expect((client as unknown as { cchp: { gitFetch(args: Record<string, never>): Promise<unknown> } }).cchp.gitFetch({})).resolves.toEqual({ stdout: "ok", stderr: "" })
    await expect((client as unknown as { cchp: { gitPush(args: Record<string, never>): Promise<unknown> } }).cchp.gitPush({})).resolves.toEqual({ stdout: "ok", stderr: "" })
    await expect((client as unknown as { cchp: { installWebDependencies(args: { mode: "frozen" }): Promise<unknown> } }).cchp.installWebDependencies({ mode: "frozen" })).resolves.toEqual({ stdout: "ok", stderr: "" })
  }, {
    task: "manual",
    noDefaultTarget: true,
    repoDir,
    allowRepositoryMutation: true,
    herouiAuthToken: "heroui-secret",
    runCommand,
  })
  expect(calls.map(({ command, args, cwd }) => ({ command, args, cwd }))).toEqual([
    { command: "git", args: ["fetch", "--prune", "origin"], cwd: repoDir },
    { command: "git", args: ["push", "origin", "HEAD"], cwd: repoDir },
    { command: "bun", args: ["install", "--frozen-lockfile"], cwd: join(repoDir, "web") },
  ])
  expect(calls[0]?.env).not.toHaveProperty("GH_TOKEN")
  expect(calls[1]?.env).not.toHaveProperty("CCHP_APP_PRIVATE_KEY")
  expect(calls[2]?.env).toMatchObject({ HEROUI_AUTH_TOKEN: "heroui-secret" })
  expect(calls[2]?.env).not.toHaveProperty("GH_TOKEN")
})

test("typed Git mutation and dependency installation fail closed for read-only runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-broker-read-only-"))
  mkdirSync(join(root, "web"), { recursive: true })
  writeFileSync(join(root, "web", "package.json"), "{}\n")
  await withBroker(async (client) => {
    const cchp = (client as unknown as { cchp: { gitPush(args: Record<string, never>): Promise<unknown>; installWebDependencies(args: { mode: "update" }): Promise<unknown> } }).cchp
    await expect(cchp.gitPush({})).rejects.toThrow("not allowed")
    await expect(cchp.installWebDependencies({ mode: "update" })).rejects.toThrow("not allowed")
  }, { task: "manual", noDefaultTarget: true, repoDir: root, allowRepositoryMutation: false })
})

test("binds REST and paginate calls to the trusted repository and PR", async () => {
  await withBroker(async (client) => {
    await expect(client.rest.pulls.get({ owner: "CCH-HQ", repo: "fixture", pull_number: 42 })).resolves.toMatchObject({ data: { number: 42 } })
    const files = await client.paginate(client.rest.pulls.listFiles, { owner: "CCH-HQ", repo: "fixture", pull_number: 42 })
    expect(files[0]?.filename).toBe("README.md")
    await expect(client.rest.pulls.get({ owner: "other", repo: "fixture", pull_number: 42 })).rejects.toThrow("repository")
    await expect(client.rest.pulls.get({ owner: "CCH-HQ", repo: "fixture", pull_number: 7 })).rejects.toThrow("trusted current PR")
    await expect(client.paginate(client.rest.pulls.listFiles, { owner: "other", repo: "fixture", pull_number: 42 })).rejects.toThrow("repository")
    await expect(client.paginate(client.rest.users.getAuthenticated, {})).rejects.toThrow("not allowed")
  })
})

test("non-PR tasks reject unknown REST operations and cross-repository calls", async () => {
  await withBroker(async (client) => {
    await expect(client.rest.users.getAuthenticated({})).rejects.toThrow("not allowed")
    await expect(client.rest.issues.listComments({ owner: "other", repo: "fixture", issue_number: 9 })).rejects.toThrow("repository")
    await expect(client.rest.issues.listComments({ owner: "CCH-HQ", repo: "fixture", issue_number: 10 })).rejects.toThrow("trusted current issue")
    const comments = await client.rest.issues.listComments({ owner: "CCH-HQ", repo: "fixture", issue_number: 9 })
    expect(comments as unknown).toEqual([{ id: 91, node_id: "IC_91" }])
  }, { task: "engage", target: 9, targetKind: "issue" })
})

test("task operation allowlists expose implemented tools without inheriting unrelated mutations", async () => {
  await withBroker(async (client, _marker, calls) => {
    const repo = { owner: "CCH-HQ", repo: "fixture" }
    const found = await client.paginate(client.rest.search.issuesAndPullRequests, { q: "repo:CCH-HQ/fixture is:issue", per_page: 100 })
    expect(found).toHaveLength(2)
    await expect(client.rest.issues.get({ ...repo, issue_number: 9 })).resolves.toHaveProperty("data.node_id", "ISSUE_9")
    await expect(client.rest.repos.getCollaboratorPermissionLevel({ ...repo, username: "alice" })).resolves.toHaveProperty("data.permission", "write")
    await client.rest.issues.listComments({ ...repo, issue_number: 9 })
    await expect(client.rest.reactions.listForIssueComment({ ...repo, comment_id: 91 })).resolves.toHaveLength(1)
    await expect(client.graphql(MINIMIZE_COMMENT, { id: "IC_91", classifier: "SPAM" })).resolves.toHaveProperty("minimizeComment.minimizedComment.isMinimized", true)
    await expect(client.rest.issues.deleteComment({ ...repo, comment_id: 91 })).resolves.toBeDefined()
    expect(calls.some((call) => call.operation === "issues.deleteComment")).toBe(true)
  }, { task: "engage", target: 9, targetKind: "issue" })

  await withBroker(async (client) => {
    await expect(client.rest.issues.lock({ owner: "CCH-HQ", repo: "fixture", issue_number: 42, lock_reason: "spam" })).rejects.toThrow("not allowed")
  }, { task: "lgtm_merge", target: 42, targetKind: "pr" })
})

test("targeted operations fail closed when the broker has no trusted target binding", async () => {
  await withBroker(async (client) => {
    await expect(client.rest.issues.update({ owner: "CCH-HQ", repo: "fixture", issue_number: 999, title: "other" })).rejects.toThrow(/trusted|target|not allowed/)
    await expect(client.rest.pulls.get({ owner: "CCH-HQ", repo: "fixture", pull_number: 999 })).rejects.toThrow(/trusted|target|not allowed/)
  }, { task: "release_notes", releaseTag: "v1.0.0", noDefaultTarget: true })
})

test("comment updates require a trusted or previously discovered comment id", async () => {
  await withBroker(async (client) => {
    await expect(client.rest.issues.updateComment({ owner: "CCH-HQ", repo: "fixture", comment_id: 999, body: "x" })).rejects.toThrow("comment")
    await client.rest.issues.listComments({ owner: "CCH-HQ", repo: "fixture", issue_number: 9 })
    await expect(client.rest.issues.updateComment({ owner: "CCH-HQ", repo: "fixture", comment_id: 91, body: "x" })).resolves.toMatchObject({ data: { id: 91 } })
    await expect(client.rest.issues.updateComment({ owner: "CCH-HQ", repo: "fixture", comment_id: 77, body: "x" })).resolves.toMatchObject({ data: { id: 77 } })
  }, { task: "engage", target: 9, targetKind: "issue", trustedCommentId: 77 })
})

test("release updates are bound only to the trusted tag lookup, never listReleases ids", async () => {
  await withBroker(async (client) => {
    const repo = { owner: "CCH-HQ", repo: "fixture" }
    await client.paginate(client.rest.repos.listReleases, { ...repo, per_page: 100 })
    await expect(client.rest.repos.updateRelease({ ...repo, release_id: 90, body: "wrong" })).rejects.toThrow("release id")
    await expect(client.rest.repos.getReleaseByTag({ ...repo, tag: "v2.0.0" })).rejects.toThrow("trusted release")
    await expect(client.rest.repos.getReleaseByTag({ ...repo, tag: "v1.0.0" })).resolves.toHaveProperty("data.id", 91)
    await expect(client.rest.repos.updateRelease({ ...repo, release_id: 91, body: "notes" })).resolves.toHaveProperty("data.id", 91)
  }, { task: "release_notes", releaseTag: "v1.0.0", noDefaultTarget: true })

  await withBroker(async (client) => {
    const repo = { owner: "CCH-HQ", repo: "fixture" }
    await client.rest.repos.getReleaseByTag({ ...repo, tag: "v1.0.0" })
    await expect(client.rest.repos.updateRelease({ ...repo, release_id: 91, body: "notes" })).rejects.toThrow("release id")
  }, {
    task: "release_notes",
    releaseTag: "v1.0.0",
    noDefaultTarget: true,
    fake: { releaseResponseTag: "v0.9.0" },
  })
})

test("Check Runs are bound to the trusted head, run id, name, and created id", async () => {
  await withBroker(async (client, _marker, calls) => {
    const repo = { owner: "CCH-HQ", repo: "fixture" }
    const base = { ...repo, name: CHECK_RUN_NAME, head_sha: "a".repeat(40), status: "queued" as const, external_id: "run-1" }
    await expect(client.rest.checks.create({ ...base, head_sha: "b".repeat(40) })).rejects.toThrow("head SHA")
    await expect(client.rest.checks.create({ ...base, external_id: "other" })).rejects.toThrow("external id")
    await expect(client.rest.checks.create({ ...base, name: "required-ci" })).rejects.toThrow("name")
    await expect(client.rest.checks.create({ ...base, status: "in_progress" })).rejects.toThrow("queued")
    await expect(client.rest.checks.update({ ...repo, check_run_id: 777, status: "completed", conclusion: "success" })).rejects.toThrow("check run id")

    await expect(client.rest.checks.create(base)).resolves.toHaveProperty("data.id", 777)
    await expect(client.rest.checks.update({
      ...repo,
      check_run_id: 777,
      status: "completed",
      conclusion: "failure",
      output: { title: "Failed", summary: "reason" },
    })).resolves.toHaveProperty("data.id", 777)
    await expect(client.rest.checks.update({ ...repo, check_run_id: 777, status: "completed", name: "required-ci" } as never)).rejects.toThrow("unexpected fields")
    expect(calls.filter((call) => call.operation === "checks.create")).toHaveLength(1)
  }, { task: "ci_fix", target: 42, targetKind: "pr", workflowRunId: 1 })
})

test("direct broker merge performs a live same-repository fork gate and binds the live head SHA", async () => {
  await withBroker(async (client, _marker, calls) => {
    await expect(client.rest.pulls.merge({ owner: "CCH-HQ", repo: "fixture", pull_number: 42, merge_method: "squash" })).rejects.toThrow("fork PRs")
    expect(calls.filter((call) => call.operation === "pulls.merge")).toHaveLength(0)
  }, { task: "lgtm_merge", target: 42, targetKind: "pr", fake: { prHeadRepo: "attacker/fork" } })

  await withBroker(async (client, _marker, calls) => {
    await expect(client.rest.pulls.merge({ owner: "CCH-HQ", repo: "fixture", pull_number: 42, merge_method: "squash", sha: "model-selected" } as never)).rejects.toThrow("unexpected fields")
    await expect(client.rest.pulls.merge({ owner: "CCH-HQ", repo: "fixture", pull_number: 42, merge_method: "squash" })).resolves.toHaveProperty("data.merged", true)
    expect(calls.find((call) => call.operation === "pulls.merge")?.args).toMatchObject({ sha: "a".repeat(40) })
  }, { task: "lgtm_merge", target: 42, targetKind: "pr" })
})

test("allows only the fixed current-PR GraphQL read and rejects mutation bypasses", async () => {
  await withBroker(async (client) => {
    await expect(client.graphql(REVIEW_THREADS_QUERY, { owner: "CCH-HQ", name: "fixture", number: 42, cursor: null })).resolves.toHaveProperty("repository.pullRequest.reviewThreads.nodes.0.id", "RT_1")
    await expect(client.graphql(REVIEW_THREADS_QUERY, { owner: "CCH-HQ", name: "other", number: 42 })).rejects.toThrow("repository")
    await expect(client.graphql(REVIEW_THREADS_QUERY, { owner: "CCH-HQ", name: "fixture", number: 99 })).rejects.toThrow("trusted current PR")
    await expect(client.graphql(`# harmless comment\nmutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}`, { id: "x" })).rejects.toThrow("read-only")
    await expect(client.graphql(`query { viewer { login } }`, {})).rejects.toThrow("not allowed")
  })
})

test("pr_opened triage mutations are field-bounded and the close flow is terminal", async () => {
  await withBroker(async (client, marker, calls) => {
    const repo = { owner: "CCH-HQ", repo: "fixture" }
    await expect(client.rest.issues.lock({ ...repo, issue_number: 42, lock_reason: "spam" })).resolves.toBeDefined()
    await expect(client.rest.issues.createLabel({ ...repo, name: "spam", color: "ffffff" })).rejects.toThrow("color")
    await expect(client.rest.issues.createLabel({ ...repo, name: "spam", color: "b60205" })).resolves.toBeDefined()
    await expect(client.rest.issues.addLabels({ ...repo, issue_number: 42, labels: ["spam", "invalid"] })).rejects.toThrow("labels")
    await expect(client.rest.issues.addLabels({ ...repo, issue_number: 42, labels: ["spam"] })).resolves.toBeDefined()

    await expect(client.rest.issues.createComment({ ...repo, issue_number: 42, body: "spam" })).rejects.toThrow("finalization marker")
    const purpose = { _cchp_broker_purpose: "pr_opened_triage_close" }
    await expect(client.rest.issues.update({ ...repo, issue_number: 42, state: "closed", ...purpose } as never)).rejects.toThrow("comment must succeed")
    await expect(client.rest.issues.createComment({ ...repo, issue_number: 42, body: "Closing obvious spam.", ...purpose } as never)).resolves.toBeDefined()
    await expect(client.rest.issues.update({ ...repo, issue_number: 42, state: "open", ...purpose } as never)).rejects.toThrow("must close")
    await expect(client.rest.issues.update({ ...repo, issue_number: 42, state: "closed", ...purpose } as never)).resolves.toHaveProperty("data.state", "closed")

    expect(calls.filter((call) => call.operation === "issues.createComment").at(-1)?.args).not.toHaveProperty("_cchp_broker_purpose")
    expect(calls.filter((call) => call.operation === "issues.update").at(-1)?.args).not.toHaveProperty("_cchp_broker_purpose")
    writeFileSync(marker, JSON.stringify(finalizedMarker()))
    await expect(client.rest.pulls.createReview({ ...repo, pull_number: 42, event: "COMMENT", body: "review" })).rejects.toThrow("after triage close")
  })
})

test("pr_opened title note is fixed, ordered, one-time, and does not require review finalization", async () => {
  await withBroker(async (client, _marker, calls) => {
    const repo = { owner: "CCH-HQ", repo: "fixture" }
    const purpose = { _cchp_broker_purpose: "pr_opened_title_note" }
    const body = "Updated the PR title to match the repository's Conventional Commit format."

    await expect(client.rest.issues.createComment({ ...repo, issue_number: 42, body, ...purpose } as never)).rejects.toThrow("title must be updated")
    await expect(client.rest.pulls.update({ ...repo, pull_number: 42, title: "x", state: "closed" } as never)).rejects.toThrow("unexpected fields")
    await expect(client.rest.pulls.update({ ...repo, pull_number: 42, title: "fix: safe title" })).resolves.toBeDefined()
    await expect(client.rest.issues.createComment({ ...repo, issue_number: 42, body: "arbitrary", ...purpose } as never)).rejects.toThrow("body is not allowed")
    await expect(client.rest.issues.createComment({ ...repo, issue_number: 42, body, ...purpose } as never)).resolves.toBeDefined()
    await expect(client.rest.issues.createComment({ ...repo, issue_number: 42, body, ...purpose } as never)).rejects.toThrow("title must be updated")

    expect(calls.filter((call) => call.operation === "issues.createComment")).toEqual([
      expect.objectContaining({ args: expect.objectContaining({ issue_number: 42, body }) }),
    ])
    expect(calls.filter((call) => call.operation === "issues.createComment")[0]!.args).not.toHaveProperty("_cchp_broker_purpose")
  })
})

test("pr_opened resolve-thread mutation requires discovered id and finalization", async () => {
  await withBroker(async (client, marker) => {
    await expect(client.graphql(RESOLVE_THREAD_MUTATION, { id: "RT_1" })).rejects.toThrow("discovered")
    await client.graphql(REVIEW_THREADS_QUERY, { owner: "CCH-HQ", name: "fixture", number: 42, cursor: null })
    await expect(client.graphql(RESOLVE_THREAD_MUTATION, { id: "RT_1" })).rejects.toThrow("finalization marker")
    writeFileSync(marker, JSON.stringify(finalizedMarker()))
    await expect(client.graphql(RESOLVE_THREAD_MUTATION, { id: "RT_1" })).resolves.toHaveProperty("resolveReviewThread.thread.isResolved", true)
  })
})

test("roadmap GraphQL is read-only except for exact typed mutations on discovered ids", async () => {
  await withBroker(async (client) => {
    await expect(client.graphql(`mutation { deleteProjectV2(input:{projectId:"PVT_1"}) { projectV2 { id } } }`, {})).rejects.toThrow("read-only")
    await expect(client.graphql(`query($owner:String!){organization(login:$owner){projectsV2(first:10){nodes{id}}}}`, { owner: "CCH-HQ" })).rejects.toThrow(/document|discovery|allowed/)
    await expect(client.graphql(ROADMAP_DISCOVERY_QUERY, { owner: "other", number: 1, cursor: null })).rejects.toThrow("owner")
    await expect(client.graphql(ROADMAP_DISCOVERY_QUERY, { owner: "CCH-HQ", number: 2, cursor: null })).rejects.toThrow("project")
    await expect(client.graphql(ROADMAP_DISCOVERY_QUERY, { owner: "CCH-HQ", number: 1, cursor: null })).resolves.toHaveProperty("organization.projectV2.id", "PVT_1")
    await expect(client.graphql(ROADMAP_ADD_ITEM, { p: "OTHER", c: "ISSUE_1" })).rejects.toThrow("discovered")
    await expect(client.graphql(ROADMAP_ADD_ITEM, { p: "ISSUE_9", c: "PVT_1" })).rejects.toThrow(/project|content|discovered/)
    await expect(client.graphql(ROADMAP_ADD_ITEM, { p: "PVT_1", c: "ISSUE_9" })).resolves.toHaveProperty("addProjectV2ItemById.item.id", "PVTI_2")
    await expect(client.graphql(ROADMAP_MOVE_ITEM, { p: "PVT_1", i: "PVTI_1", f: "OTHER", o: "OTHER" })).rejects.toThrow("discovered")
    await expect(client.graphql(ROADMAP_MOVE_ITEM, { p: "PVT_1", i: "F_1", f: "PVTI_1", o: "O_1" })).rejects.toThrow(/item|field|discovered/)
    await expect(client.graphql(ROADMAP_MOVE_ITEM, { p: "PVT_1", i: "PVTI_1", f: "F_1", o: "O_1" })).resolves.toHaveProperty("updateProjectV2ItemFieldValue.projectV2Item.id", "PVTI_1")
    await expect(client.graphql(ROADMAP_ARCHIVE_ITEM, { p: "PVT_1", i: "PVTI_1" })).resolves.toHaveProperty("archiveProjectV2Item.item.id", "PVTI_1")
    await expect(client.graphql(ROADMAP_ARCHIVE_ITEM, { p: "PVT_1", i: "PVTI_OTHER" })).rejects.toThrow("discovered")
  }, { task: "roadmap_item", target: 9, targetKind: "issue", roadmapProject: 1 })

  await withBroker(async (client) => {
    await expect(client.graphql(ROADMAP_ADD_ITEM, { p: "PVT_1", c: "ISSUE_1" })).rejects.toThrow("not allowed")
  }, { task: "lgtm_merge", target: 9, targetKind: "pr", roadmapProject: 1 })
})

test("roadmap full-board discovery never trusts content from another repository", async () => {
  await withBroker(async (client) => {
    await client.graphql(ROADMAP_DISCOVERY_QUERY, { owner: "CCH-HQ", number: 1, cursor: null })
    await expect(client.graphql(ROADMAP_ADD_ITEM, { p: "PVT_1", c: "ISSUE_OTHER" })).rejects.toThrow(/content|discovered/)
  }, { task: "roadmap_sync", roadmapProject: 1, noDefaultTarget: true, fake: { roadmapForeignContent: true } })
})

test("roadmap bootstrap accepts only typed discovered project and Status field ids", async () => {
  await withBroker(async (client) => {
    const opts = ROADMAP_STATUS_OPTIONS.map(({ name, color, description }) => ({ name, color, description }))
    await client.graphql(ROADMAP_DISCOVERY_QUERY, { owner: "CCH-HQ", number: 1, cursor: null })
    await expect(client.graphql(ROADMAP_CREATE_STATUS_FIELD, { p: "ISSUE_9", opts })).rejects.toThrow(/project|discovered/)
    await expect(client.graphql(ROADMAP_CREATE_STATUS_FIELD, { p: "PVT_1", opts })).resolves.toHaveProperty("createProjectV2Field.projectV2Field.id", "F_NEW")
    await expect(client.graphql(ROADMAP_UPDATE_STATUS_FIELD, { f: "PVTI_1", opts })).rejects.toThrow(/field|discovered/)
    await expect(client.graphql(ROADMAP_UPDATE_STATUS_FIELD, { f: "F_1", opts })).resolves.toHaveProperty("updateProjectV2Field.projectV2Field.id", "F_1")
    await expect(client.graphql(ROADMAP_UPDATE_PROJECT, {
      p: "PVT_1", description: ROADMAP_PROJECT_DESCRIPTION, readme: ROADMAP_PROJECT_README,
    })).resolves.toHaveProperty("updateProjectV2.projectV2.id", "PVT_1")
  }, { task: "roadmap_sync", roadmapProject: 1, noDefaultTarget: true })
})

test("discussion GraphQL binds the trusted discussion and exact mutation documents", async () => {
  await withBroker(async (client) => {
    await expect(client.graphql(DISCUSSION_QUERY, { owner: "CCH-HQ", name: "fixture", number: 8, cursor: null })).rejects.toThrow("discussion")
    await expect(client.graphql(DISCUSSION_QUERY, { owner: "CCH-HQ", name: "fixture", number: 7, cursor: null })).resolves.toHaveProperty("repository.discussion.id", "D_1")
    await expect(client.graphql(DISCUSSION_ADD_COMMENT, { id: "OTHER", body: "hello" })).rejects.toThrow("discovered")
    await expect(client.graphql(DISCUSSION_ADD_COMMENT, { id: "D_1", body: "hello" })).resolves.toHaveProperty("addDiscussionComment.comment.id", "DC_2")
    await expect(client.graphql(DISCUSSION_UPDATE_COMMENT, { id: "OTHER", body: "edited" })).rejects.toThrow("discovered")
    await expect(client.graphql(DISCUSSION_UPDATE_COMMENT, { id: "DC_2", body: "edited" })).resolves.toHaveProperty("updateDiscussionComment.comment.id", "DC_2")
    await expect(client.graphql(`# comment\nmutation($id:ID!){deleteDiscussionComment(input:{id:$id}){clientMutationId}}`, { id: "DC_1" })).rejects.toThrow("read-only")
  }, { task: "engage", target: 7, targetKind: "discussion" })
})

test("milestone mutations require a discovered milestone number rather than the unrelated database id", async () => {
  await withBroker(async (client) => {
    const args = { owner: "CCH-HQ", repo: "fixture", milestone_number: 7, state: "closed" as const }
    await expect(client.rest.issues.updateMilestone(args)).rejects.toThrow("number was not discovered")
    await client.paginate(client.rest.issues.listMilestones, { owner: "CCH-HQ", repo: "fixture", state: "all" })
    await expect(client.rest.issues.updateMilestone(args)).resolves.toMatchObject({ data: { number: 7, state: "closed" } })

    await client.rest.issues.createMilestone({ owner: "CCH-HQ", repo: "fixture", title: "v2" })
    await expect(client.rest.issues.updateMilestone({ owner: "CCH-HQ", repo: "fixture", milestone_number: 8, state: "closed" })).resolves.toMatchObject({ data: { number: 8 } })
    await expect(client.rest.issues.updateMilestone({ owner: "CCH-HQ", repo: "fixture", milestone_number: 9002, state: "closed" })).rejects.toThrow("number was not discovered")
  }, { task: "roadmap_item", target: 9, targetKind: "issue" })
})

test("requires a complete finalizer attestation before publication", async () => {
  await withBroker(async (client, marker) => {
    const args = { owner: "CCH-HQ", repo: "fixture", issue_number: 42, body: "review" }
    const validMarker = finalizedMarker
    await expect(client.rest.issues.createComment(args)).rejects.toThrow("finalization marker")
    writeFileSync(marker, JSON.stringify({ valid: true }))
    await expect(client.rest.issues.createComment(args)).rejects.toThrow("finalization marker")
    for (const drift of [
      { schema_version: 999 },
      { repository: "other/fixture" },
      { pr_number: 7 },
      { run_id: "other-run" },
    ]) {
      writeFileSync(marker, JSON.stringify({ ...validMarker(), ...drift }))
      await expect(client.rest.issues.createComment(args)).rejects.toThrow("finalization marker")
    }
    const incomplete = validMarker()
    delete incomplete.artifacts.admission_ledger
    writeFileSync(marker, JSON.stringify(incomplete))
    await expect(client.rest.issues.createComment(args)).rejects.toThrow("finalization marker")
    const realMarker = `${marker}.real`
    writeFileSync(realMarker, JSON.stringify(validMarker()))
    unlinkSync(marker)
    symlinkSync(realMarker, marker)
    await expect(client.rest.issues.createComment(args)).rejects.toThrow("finalization marker")
    unlinkSync(marker)
    writeFileSync(marker, JSON.stringify(validMarker()))
    await expect(client.rest.issues.createComment(args)).resolves.toMatchObject({ data: { id: 2 } })
  })
})

test("marker replacement after authorization fails closed before publication", async () => {
  let replaced = false
  await withBroker(async (client, marker) => {
    writeFileSync(marker, JSON.stringify(finalizedMarker()))
    await expect(client.rest.issues.createComment({
      owner: "CCH-HQ",
      repo: "fixture",
      issue_number: 42,
      body: "review",
    })).rejects.toThrow("finalization marker changed")
    expect(replaced).toBe(true)
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ valid: false })
  }, {
    snapshotFile: (path) => openRegularFileSnapshot(path, {
      afterOpen: () => {
        if (replaced) return
        replaced = true
        renameSync(path, `${path}.original`)
        writeFileSync(path, JSON.stringify({ valid: false }))
      },
    }),
  })
})

test("broker close destroys idle sockets, removes the socket path, and is idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-github-broker-close-"))
  const socketPath = join(root, "broker.sock")
  const broker = await startGitHubBroker({
    socketPath,
    repo: "CCH-HQ/fixture",
    task: "manual",
    octokit: fakeClient().client,
  })
  const socket = connect(socketPath)
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve)
    socket.once("error", reject)
  })
  await expect(Promise.race([
    broker.close().then(() => "closed"),
    new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 500)),
  ])).resolves.toBe("closed")
  expect(socket.destroyed).toBe(true)
  expect(existsSync(socketPath)).toBe(false)
  await expect(broker.close()).resolves.toBeUndefined()
})
