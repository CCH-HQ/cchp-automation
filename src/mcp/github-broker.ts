import { createServer, connect, type Server, type Socket } from "node:net"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { chmodSync, existsSync } from "node:fs"
import { spawn } from "node:child_process"
import { unlink } from "node:fs/promises"
import { dirname } from "node:path"
import { mkdirSync } from "node:fs"
import { openRegularFileSnapshot, type FileSnapshot } from "../codex/file-snapshot"
import { assertNoForbiddenMaterial } from "../security/secret-material"
import type { GitHubClient, TokenSource } from "../github/client"
import { CHECK_RUN_NAME } from "../publish/checkrun"
import { ARTIFACT_SCHEMA_VERSION, TASKS, type Task } from "../types"
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
  canonicalGraphql,
  parseSingleOperation,
} from "./graphql-contract"

type Json = Record<string, unknown>

export interface GitHubBrokerOptions {
  socketPath: string
  repo: string
  task?: string
  target?: number
  targetKind?: "pr" | "issue" | "discussion"
  trustedCommentId?: number
  roadmapProject?: number
  workflowRunId?: number
  releaseTag?: string
  finalizerMarker?: string
  expectedHeadSha?: string
  expectedRunId?: string
  snapshotFile?: (path: string) => FileSnapshot
  octokit: GitHubClient
  repoDir?: string
  allowRepositoryMutation?: boolean
  herouiAuthToken?: string
  seeUpload?: (path: string, name?: string, isPrivate?: boolean) => Promise<unknown>
  forbiddenValues?: () => readonly string[]
  runCommand?: (command: string, args: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number }) => Promise<{ stdout: string; stderr: string }>
}

export interface GitHubBrokerHandle {
  socketPath: string
  token: string
  close(): Promise<void>
}

const PR_OPENED_READ = new Set([
  "rest.pulls.get",
  "rest.pulls.listFiles",
  "rest.pulls.listReviews",
  "rest.pulls.listReviewComments",
  "rest.issues.listComments",
  "rest.actions.getWorkflowRun",
  "rest.actions.listJobsForWorkflowRun",
  "rest.actions.downloadJobLogsForWorkflowRun",
  "graphql",
])
const PR_OPENED_MUTATIONS = new Set([
  "rest.pulls.createReview",
  "rest.pulls.createReviewComment",
  "rest.issues.createComment",
  "rest.issues.updateComment",
  "rest.reactions.createForIssue",
])
const PR_OPENED_TRIAGE = new Set([
  "rest.pulls.update",
  "rest.issues.update",
  "rest.issues.lock",
  "rest.issues.getLabel",
  "rest.issues.createLabel",
  "rest.issues.addLabels",
])
const BROKER_PURPOSE_KEY = "_cchp_broker_purpose"
const PR_TRIAGE_CLOSE_PURPOSE = "pr_opened_triage_close"
const PR_TITLE_NOTE_PURPOSE = "pr_opened_title_note"
const TRIAGE_LABEL_COLORS: Record<string, string> = { spam: "b60205", invalid: "e4e669" }

function union(...sets: ReadonlySet<string>[]): Set<string> {
  return new Set(sets.flatMap((set) => [...set]))
}

const PR_READ = new Set([
  "rest.pulls.get",
  "rest.pulls.listFiles",
  "rest.pulls.listReviews",
  "rest.pulls.listReviewComments",
])
const ISSUE_READ = new Set([
  "rest.issues.get",
  "rest.issues.listComments",
])
const COMMENT_READ = new Set(["rest.issues.getComment"])
const SEARCH_READ = new Set(["rest.search.issuesAndPullRequests"])
const ACTOR_READ = new Set([
  "rest.repos.getCollaboratorPermissionLevel",
  "rest.orgs.checkMembershipForUser",
])
const WORKFLOW_READ = new Set([
  "rest.actions.getWorkflowRun",
  "rest.actions.listJobsForWorkflowRun",
  "rest.actions.downloadJobLogsForWorkflowRun",
])
const COMMENT_MUTATIONS = new Set([
  "rest.issues.createComment",
  "rest.issues.updateComment",
])
const MODERATION_MUTATIONS = new Set([
  "rest.pulls.update",
  "rest.issues.update",
  "rest.issues.lock",
  "rest.issues.getLabel",
  "rest.issues.createLabel",
  "rest.issues.addLabels",
  "rest.issues.removeLabel",
  "rest.reactions.createForIssue",
  "rest.issues.deleteComment",
  "rest.pulls.deleteReviewComment",
  "rest.reactions.listForIssueComment",
])
const REVIEW_MUTATIONS = new Set(["rest.pulls.createReview", "rest.pulls.createReviewComment"])
const CHECK_MUTATIONS = new Set(["rest.checks.create", "rest.checks.update"])
const WORKFLOW_MUTATIONS = new Set([
  "rest.actions.reRunWorkflowFailedJobs",
  "rest.actions.reRunWorkflow",
  "rest.actions.cancelWorkflowRun",
])
const MERGE_MUTATIONS = new Set(["rest.pulls.merge"])
const PULL_REQUEST_MUTATIONS = new Set(["rest.pulls.create"])
const ROADMAP_REST = new Set([
  "rest.issues.listMilestones",
  "rest.issues.createMilestone",
  "rest.issues.updateMilestone",
])
const RELEASE_REST = new Set([
  "rest.repos.listReleases",
  "rest.repos.getReleaseByTag",
  "rest.repos.updateRelease",
  "rest.repos.compareCommits",
])

const TASK_REST: Record<Task, ReadonlySet<string>> = {
  engage: union(PR_READ, ISSUE_READ, COMMENT_READ, SEARCH_READ, ACTOR_READ, COMMENT_MUTATIONS, MODERATION_MUTATIONS, PULL_REQUEST_MUTATIONS, ROADMAP_REST),
  pr_opened: union(PR_OPENED_READ, PR_OPENED_MUTATIONS, PR_OPENED_TRIAGE, SEARCH_READ, ISSUE_READ, ACTOR_READ, new Set([
    "rest.issues.deleteComment", "rest.pulls.deleteReviewComment", "rest.reactions.listForIssueComment",
  ])),
  lgtm_merge: union(PR_READ, ACTOR_READ, COMMENT_MUTATIONS, new Set([
    "rest.issues.listComments",
    "rest.issues.getLabel", "rest.issues.createLabel", "rest.issues.addLabels",
  ]), MERGE_MUTATIONS),
  ci_fix: union(PR_READ, ISSUE_READ, COMMENT_READ, SEARCH_READ, ACTOR_READ, WORKFLOW_READ, COMMENT_MUTATIONS, CHECK_MUTATIONS, WORKFLOW_MUTATIONS, PULL_REQUEST_MUTATIONS),
  release_notes: union(ISSUE_READ, SEARCH_READ, new Set(["rest.issues.update"]), RELEASE_REST, ROADMAP_REST),
  roadmap_item: union(PR_READ, ISSUE_READ, SEARCH_READ, new Set(["rest.issues.update"]), ROADMAP_REST),
  roadmap_sync: union(PR_READ, ISSUE_READ, SEARCH_READ, new Set(["rest.issues.update"]), ROADMAP_REST),
  reaction_execute: union(ISSUE_READ, COMMENT_READ, SEARCH_READ, ACTOR_READ, new Set(["rest.issues.updateComment"]), PULL_REQUEST_MUTATIONS),
  manual: new Set(),
  dispatch: new Set(),
}

const ROADMAP_TASKS = new Set<Task>(["engage", "pr_opened", "release_notes", "roadmap_item", "roadmap_sync"])
const FULL_BOARD_ROADMAP_TASKS = new Set<Task>(["release_notes", "roadmap_sync"])
const DISCUSSION_TASKS = new Set<Task>(["engage"])
const REVIEW_THREAD_TASKS = new Set<Task>(["engage", "pr_opened"])
const REPOSITORY_WIDE_TARGET_TASKS = new Set<Task>(["release_notes", "roadmap_item", "roadmap_sync"])

interface BrokerAuthorizationState {
  commentIds: Set<number>
  commentNodeIds: Set<string>
  protectedProgressCommentIds: Set<number>
  protectedProgressCommentNodeIds: Set<string>
  reviewCommentIds: Set<number>
  reviewThreadIds: Set<string>
  discussionIds: Set<string>
  discussionCommentIds: Set<string>
  checkRunIds: Set<number>
  checkRunStatus: Map<number, "queued" | "in_progress" | "completed">
  workflowJobIds: Set<number>
  trustedReleaseId?: number
  milestoneNumbers: Set<number>
  issueNumbers: Set<number>
  prNumbers: Set<number>
  roadmapProjectIds: Set<string>
  roadmapContentIds: Set<string>
  roadmapItemIds: Set<string>
  roadmapFieldIds: Set<string>
  roadmapOptionIds: Set<string>
  prDisposition: "active" | "title_updated" | "title_noted" | "triage_closing" | "triage_closed" | "review_started"
}

function createAuthorizationState(options: GitHubBrokerOptions): BrokerAuthorizationState {
  return {
    commentIds: new Set(options.trustedCommentId ? [options.trustedCommentId] : []),
    commentNodeIds: new Set(),
    protectedProgressCommentIds: new Set(),
    protectedProgressCommentNodeIds: new Set(),
    reviewCommentIds: new Set(),
    reviewThreadIds: new Set(),
    discussionIds: new Set(),
    discussionCommentIds: new Set(),
    checkRunIds: new Set(),
    checkRunStatus: new Map(),
    workflowJobIds: new Set(),
    trustedReleaseId: undefined,
    milestoneNumbers: new Set(),
    issueNumbers: new Set(),
    prNumbers: new Set(),
    roadmapProjectIds: new Set(),
    roadmapContentIds: new Set(),
    roadmapItemIds: new Set(),
    roadmapFieldIds: new Set(),
    roadmapOptionIds: new Set(),
    prDisposition: "active",
  }
}

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

const SHA40 = /^[0-9a-f]{40}$/i
const SHA256 = /^[0-9a-f]{64}$/i
const MAX_REQUEST_BYTES = 1024 * 1024
const PROGRESS_MARKER_PREFIX = "<!-- cchp-bot:progress:"

function containsProgressMarker(value: unknown): boolean {
  return typeof value === "string" && value.includes(PROGRESS_MARKER_PREFIX)
}

function markerValid(path: string | undefined, options: GitHubBrokerOptions): boolean {
  return Boolean(validMarkerSnapshot(path, options))
}

function validMarkerSnapshot(path: string | undefined, options: GitHubBrokerOptions): FileSnapshot | undefined {
  if (!path) return undefined
  try {
    const snapshot = (options.snapshotFile ?? openRegularFileSnapshot)(path)
    const value = JSON.parse(snapshot.bytes.toString("utf8")) as Json
    const artifacts = value.artifacts as Json | undefined
    const valid = value.valid === true &&
      value.schema_version === ARTIFACT_SCHEMA_VERSION &&
      value.repository === options.repo &&
      (options.target == null || value.pr_number === options.target) &&
      (!options.expectedRunId || value.run_id === options.expectedRunId) &&
      typeof value.provenance_sha256 === "string" && SHA256.test(value.provenance_sha256) &&
      typeof value.head_sha === "string" && SHA40.test(value.head_sha) &&
      (!options.expectedHeadSha || value.head_sha === options.expectedHeadSha) &&
      typeof value.trusted_manifest_sha256 === "string" && SHA256.test(value.trusted_manifest_sha256) &&
      typeof value.patch_sha256 === "string" && SHA256.test(value.patch_sha256) &&
      !!artifacts &&
      ["manifest", "coverage", "candidates", "verification", "report", "admission_ledger", "review_results"].every((key) =>
        typeof artifacts[key] === "string" && SHA256.test(artifacts[key] as string),
      )
    return valid ? snapshot : undefined
  } catch {
    return undefined
  }
}

function trustedRepo(repo: string): { owner: string; name: string } {
  const [owner, name, extra] = repo.split("/")
  if (!owner || !name || extra) throw new Error(`invalid trusted repository: ${repo}`)
  return { owner, name }
}

function repoMatches(args: Json, repo: string): boolean {
  const trusted = trustedRepo(repo)
  if (args.owner != null && args.owner !== trusted.owner) return false
  if (args.repo != null && args.repo !== trusted.name) return false
  return true
}

function brokerTask(options: GitHubBrokerOptions): Task {
  if (!options.task || !(TASKS as readonly string[]).includes(options.task)) {
    throw new Error(`unsupported GitHub broker task: ${options.task || "<empty>"}`)
  }
  return options.task as Task
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

function assertOnlyKeys(args: Json, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed)
  const unexpected = Object.keys(args).filter((key) => !allowedSet.has(key))
  if (unexpected.length) throw new Error(`broker request contains unexpected fields: ${unexpected.join(", ")}`)
}

function requireOneLineText(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.includes("\n") || value.includes("\r")) {
    throw new Error(`broker ${label} must be one line with length 1..${max}`)
  }
  return value
}

const REST_TARGETS: Record<string, { key: string; kinds: ReadonlySet<"pr" | "issue"> }> = {
  "rest.issues.get": { key: "issue_number", kinds: new Set(["pr", "issue"]) },
  "rest.pulls.get": { key: "pull_number", kinds: new Set(["pr"]) },
  "rest.pulls.listFiles": { key: "pull_number", kinds: new Set(["pr"]) },
  "rest.pulls.listReviews": { key: "pull_number", kinds: new Set(["pr"]) },
  "rest.pulls.listReviewComments": { key: "pull_number", kinds: new Set(["pr"]) },
  "rest.pulls.createReview": { key: "pull_number", kinds: new Set(["pr"]) },
  "rest.pulls.createReviewComment": { key: "pull_number", kinds: new Set(["pr"]) },
  "rest.pulls.update": { key: "pull_number", kinds: new Set(["pr"]) },
  "rest.pulls.merge": { key: "pull_number", kinds: new Set(["pr"]) },
  "rest.issues.listComments": { key: "issue_number", kinds: new Set(["pr", "issue"]) },
  "rest.issues.createComment": { key: "issue_number", kinds: new Set(["pr", "issue"]) },
  "rest.issues.update": { key: "issue_number", kinds: new Set(["pr", "issue"]) },
  "rest.issues.lock": { key: "issue_number", kinds: new Set(["pr", "issue"]) },
  "rest.issues.addLabels": { key: "issue_number", kinds: new Set(["pr", "issue"]) },
  "rest.issues.removeLabel": { key: "issue_number", kinds: new Set(["pr", "issue"]) },
  "rest.reactions.createForIssue": { key: "issue_number", kinds: new Set(["pr", "issue"]) },
}

const TARGET_MUTATIONS = new Set([
  "rest.pulls.createReview",
  "rest.pulls.createReviewComment",
  "rest.pulls.update",
  "rest.pulls.merge",
  "rest.issues.createComment",
  "rest.issues.update",
  "rest.issues.lock",
  "rest.issues.addLabels",
  "rest.issues.removeLabel",
  "rest.reactions.createForIssue",
])

function requireDiscoveredRestTarget(state: BrokerAuthorizationState, rule: { key: string }, args: Json): void {
  const number = positiveInteger(args[rule.key])
  if (!number) throw new Error("broker operation requires a trusted or discovered target")
  const discovered = rule.key === "pull_number" ? state.prNumbers : state.issueNumbers
  if (!discovered.has(number)) throw new Error("broker target was not discovered by a trusted repository read")
}

function authorizeRest(
  options: GitHubBrokerOptions,
  state: BrokerAuthorizationState,
  operation: string,
  args: Json,
): void {
  const task = brokerTask(options)
  if (!TASK_REST[task].has(operation)) throw new Error(`broker operation is not allowed for ${task}: ${operation}`)
  if (operation === "rest.orgs.checkMembershipForUser") {
    assertOnlyKeys(args, ["org", "username"])
    if (args.org !== trustedRepo(options.repo).owner) throw new Error("broker organization does not match the trusted repository owner")
  } else if (operation !== "rest.search.issuesAndPullRequests") {
    if (typeof args.owner !== "string" || typeof args.repo !== "string") {
      throw new Error("broker REST request must bind the trusted repository")
    }
    if (!repoMatches(args, options.repo)) throw new Error("broker repository does not match trusted current repository")
  }

  const targetRule = REST_TARGETS[operation]
  if (targetRule) {
    if (options.target != null || options.targetKind) {
      if (options.target == null || !options.targetKind) throw new Error("broker target binding is incomplete")
      if (options.targetKind === "discussion" || !targetRule.kinds.has(options.targetKind)) {
        throw new Error(`broker operation does not match trusted current ${options.targetKind}`)
      }
      if (positiveInteger(args[targetRule.key]) !== options.target) {
        const label = options.targetKind === "pr" ? "PR" : "issue"
        throw new Error(`broker target does not match trusted current ${label}`)
      }
    } else if (!REPOSITORY_WIDE_TARGET_TASKS.has(task)) {
      throw new Error(`broker operation requires a trusted current target: ${operation}`)
    } else if (TARGET_MUTATIONS.has(operation)) {
      requireDiscoveredRestTarget(state, targetRule, args)
    }
  }

  if (
    (operation === "rest.issues.createComment" || operation === "rest.issues.updateComment") &&
    containsProgressMarker(args.body)
  ) throw new Error("broker progress comments are supervisor-owned")

  if (operation === "rest.issues.getComment" || operation === "rest.issues.updateComment") {
    const commentId = positiveInteger(args.comment_id)
    if (!commentId || !state.commentIds.has(commentId)) throw new Error("broker comment id was not trusted or discovered")
    if (operation === "rest.issues.updateComment" && state.protectedProgressCommentIds.has(commentId)) {
      throw new Error("broker progress comments are supervisor-owned")
    }
  }
  if (operation === "rest.issues.deleteComment" || operation === "rest.reactions.listForIssueComment") {
    const commentId = positiveInteger(args.comment_id)
    if (!commentId || !state.commentIds.has(commentId)) throw new Error("broker comment id was not trusted or discovered")
    if (operation === "rest.issues.deleteComment" && state.protectedProgressCommentIds.has(commentId)) {
      throw new Error("broker progress comments are supervisor-owned")
    }
  }
  if (operation === "rest.pulls.deleteReviewComment") {
    const commentId = positiveInteger(args.comment_id)
    if (!commentId || !state.reviewCommentIds.has(commentId)) throw new Error("broker review comment id was not discovered")
  }
  if (operation === "rest.checks.create") {
    assertOnlyKeys(args, ["owner", "repo", "name", "head_sha", "status", "external_id"])
    if (!options.expectedHeadSha || args.head_sha !== options.expectedHeadSha) {
      throw new Error("broker check run head SHA does not match trusted run")
    }
    if (!options.expectedRunId || args.external_id !== options.expectedRunId) {
      throw new Error("broker check run external id does not match trusted run")
    }
    if (args.name !== CHECK_RUN_NAME) throw new Error("broker check run name does not match the trusted check")
    if (args.status !== "queued") throw new Error("broker check run must be created queued")
    if (state.checkRunIds.size > 0) throw new Error("broker check run already exists for this run")
  }
  if (operation === "rest.checks.update") {
    assertOnlyKeys(args, ["owner", "repo", "check_run_id", "status", "conclusion", "output", "actions"])
    const checkRunId = positiveInteger(args.check_run_id)
    if (!checkRunId || !state.checkRunIds.has(checkRunId)) throw new Error("broker check run id was not discovered")
    const status = String(args.status ?? "")
    if (!new Set(["queued", "in_progress", "completed"]).has(status)) throw new Error("broker check run status is invalid")
    const previous = state.checkRunStatus.get(checkRunId)
    if (previous === "completed" || (previous === "in_progress" && status === "queued")) {
      throw new Error("broker check run status transition is invalid")
    }
    if (status === "completed" && typeof args.conclusion !== "string") {
      throw new Error("broker completed check run requires a conclusion")
    }
    if (status !== "completed" && args.conclusion != null) throw new Error("broker non-terminal check run cannot have a conclusion")
  }
  if (operation === "rest.actions.downloadJobLogsForWorkflowRun") {
    const jobId = positiveInteger(args.job_id)
    if (!jobId || !state.workflowJobIds.has(jobId)) throw new Error("broker workflow job id was not discovered")
  }
  if (operation.startsWith("rest.actions.") && operation !== "rest.actions.downloadJobLogsForWorkflowRun" && options.workflowRunId) {
    if (positiveInteger(args.run_id) !== options.workflowRunId) throw new Error("broker workflow run does not match trusted run")
  }
  if (operation === "rest.repos.getReleaseByTag") {
    if (!options.releaseTag || args.tag !== options.releaseTag) {
      throw new Error("broker release tag does not match trusted release")
    }
  }
  if (operation === "rest.repos.updateRelease") {
    const releaseId = positiveInteger(args.release_id)
    if (!releaseId || releaseId !== state.trustedReleaseId) throw new Error("broker release id was not discovered from the trusted tag")
  }
  if (operation === "rest.issues.updateMilestone") {
    const milestoneNumber = positiveInteger(args.milestone_number)
    if (!milestoneNumber || !state.milestoneNumbers.has(milestoneNumber)) {
      throw new Error("broker milestone number was not discovered")
    }
  }
  if (operation === "rest.search.issuesAndPullRequests") {
    assertOnlyKeys(args, ["q", "per_page", "page"])
    const query = typeof args.q === "string" ? args.q.trim() : ""
    const qualifiers = query.match(/\brepo:[^\s]+/gi) ?? []
    if (qualifiers.length !== 1 || qualifiers[0]!.toLowerCase() !== `repo:${options.repo}`.toLowerCase()) {
      throw new Error("broker search must bind exactly the trusted repository")
    }
  }
  if (operation === "rest.pulls.merge") {
    assertOnlyKeys(args, ["owner", "repo", "pull_number", "merge_method"])
    if (args.merge_method != null && !new Set(["squash", "merge", "rebase"]).has(String(args.merge_method))) {
      throw new Error("broker merge method is invalid")
    }
  }

  if (task === "pr_opened") {
    const purpose = args[BROKER_PURPOSE_KEY]
    if (purpose != null && purpose !== PR_TRIAGE_CLOSE_PURPOSE && purpose !== PR_TITLE_NOTE_PURPOSE) {
      throw new Error("broker purpose is not allowed")
    }

    if (operation === "rest.pulls.update") {
      if (state.prDisposition !== "active") throw new Error("PR triage is no longer active")
      assertOnlyKeys(args, ["owner", "repo", "pull_number", "title"])
      requireOneLineText(args.title, 256, "PR title")
    }
    if (operation === "rest.issues.lock") {
      if (state.prDisposition !== "active") throw new Error("PR triage is no longer active")
      assertOnlyKeys(args, ["owner", "repo", "issue_number", "lock_reason"])
      if (!new Set(["spam", "off-topic", "resolved", "too heated"]).has(String(args.lock_reason))) {
        throw new Error("broker lock reason is not allowed")
      }
    }
    if (operation === "rest.issues.getLabel") {
      if (state.prDisposition !== "active") throw new Error("PR triage is no longer active")
      assertOnlyKeys(args, ["owner", "repo", "name"])
      if (!TRIAGE_LABEL_COLORS[String(args.name)]) throw new Error("broker triage label is not allowed")
    }
    if (operation === "rest.issues.createLabel") {
      if (state.prDisposition !== "active") throw new Error("PR triage is no longer active")
      assertOnlyKeys(args, ["owner", "repo", "name", "color"])
      if (TRIAGE_LABEL_COLORS[String(args.name)] !== args.color) throw new Error("broker triage label or color is not allowed")
    }
    if (operation === "rest.issues.addLabels") {
      if (state.prDisposition !== "active") throw new Error("PR triage is no longer active")
      assertOnlyKeys(args, ["owner", "repo", "issue_number", "labels"])
      if (!Array.isArray(args.labels) || args.labels.length !== 1 || !TRIAGE_LABEL_COLORS[String(args.labels[0])]) {
        throw new Error("broker triage labels are not allowed")
      }
    }

    const triageClose = purpose === PR_TRIAGE_CLOSE_PURPOSE
    const titleNote = purpose === PR_TITLE_NOTE_PURPOSE
    if (operation === "rest.issues.createComment" && titleNote) {
      if (state.prDisposition !== "title_updated") throw new Error("PR title must be updated before its note")
      assertOnlyKeys(args, ["owner", "repo", "issue_number", "body", BROKER_PURPOSE_KEY])
      if (args.body !== "Updated the PR title to match the repository's Conventional Commit format.") {
        throw new Error("broker title note body is not allowed")
      }
    } else if (titleNote) {
      throw new Error("broker title-note purpose is not allowed for this operation")
    } else if (operation === "rest.issues.createComment" && triageClose) {
      if (state.prDisposition !== "active") throw new Error("PR triage close cannot start in the current disposition")
      assertOnlyKeys(args, ["owner", "repo", "issue_number", "body", BROKER_PURPOSE_KEY])
      requireOneLineText(args.body, 512, "triage close reason")
    } else if (operation === "rest.issues.update" && triageClose) {
      if (state.prDisposition !== "triage_closing") throw new Error("PR triage close comment must succeed before closing")
      assertOnlyKeys(args, ["owner", "repo", "issue_number", "state", BROKER_PURPOSE_KEY])
      if (args.state !== "closed") throw new Error("broker triage update must close the current PR")
    } else if (triageClose) {
      throw new Error("broker triage-close purpose is not allowed for this operation")
    } else if (operation === "rest.issues.update") {
      throw new Error("broker issue update is only allowed for the bounded triage-close flow")
    }

    if (PR_OPENED_MUTATIONS.has(operation) && !triageClose && !titleNote) {
      if (state.prDisposition === "triage_closing" || state.prDisposition === "triage_closed") {
        throw new Error("review publication is not allowed after triage close")
      }
      if (!markerValid(options.finalizerMarker, options)) {
        throw new Error("review finalization marker is required before GitHub publication")
      }
      if (operation === "rest.pulls.createReview" || operation === "rest.pulls.createReviewComment") {
        const allowed = operation === "rest.pulls.createReview"
          ? ["owner", "repo", "pull_number", "event", "body", "comments", "commit_id"]
          : ["owner", "repo", "pull_number", "body", "path", "line", "side", "start_line", "start_side", "subject_type", "commit_id"]
        assertOnlyKeys(args, allowed)
        if (!options.expectedHeadSha || args.commit_id !== options.expectedHeadSha) {
          throw new Error("broker review commit SHA does not match trusted run")
        }
      }
    }
  }
}

function expectBoundRepository(options: GitHubBrokerOptions, variables: Json): void {
  if (typeof variables.owner !== "string" || typeof variables.name !== "string") {
    throw new Error("broker GraphQL request must bind the trusted repository")
  }
  const trusted = trustedRepo(options.repo)
  if (variables.owner !== trusted.owner || variables.name !== trusted.name) {
    throw new Error("broker GraphQL repository does not match trusted current repository")
  }
}

function expectBoundTarget(options: GitHubBrokerOptions, variables: Json, kind: "pr" | "discussion"): void {
  if (options.targetKind !== kind || !options.target || positiveInteger(variables.number) !== options.target) {
    const label = kind === "pr" ? "PR" : "discussion"
    throw new Error(`broker GraphQL target does not match trusted current ${label}`)
  }
}

function requireTypedId(ids: ReadonlySet<string>, variables: Json, key: string, label: string): void {
  const value = variables[key]
  if (typeof value !== "string" || !ids.has(value)) {
    throw new Error(`broker ${label} id ${key} was not discovered by an authorized read`)
  }
}

function expectRoadmapDiscovery(options: GitHubBrokerOptions, variables: Json): void {
  const trusted = trustedRepo(options.repo)
  if (variables.owner !== trusted.owner) throw new Error("roadmap GraphQL owner does not match the trusted owner")
  if (!options.roadmapProject || positiveInteger(variables.number) !== options.roadmapProject) {
    throw new Error("roadmap GraphQL project does not match the trusted project")
  }
  if (variables.cursor != null && typeof variables.cursor !== "string") throw new Error("roadmap GraphQL cursor must be a string or null")
}

const TRUSTED_ROADMAP_OPTIONS = ROADMAP_STATUS_OPTIONS.map(({ name, color, description }) => ({ name, color, description }))

function expectRoadmapOptions(variables: Json): void {
  if (JSON.stringify(variables.opts) !== JSON.stringify(TRUSTED_ROADMAP_OPTIONS)) {
    throw new Error("roadmap Status options do not match the trusted schema")
  }
}

function authorizeGraphql(options: GitHubBrokerOptions, state: BrokerAuthorizationState, args: Json): void {
  const task = brokerTask(options)
  const query = String(args.query ?? "")
  const variables = args.variables && typeof args.variables === "object" && !Array.isArray(args.variables)
    ? args.variables as Json
    : {}
  let canonical: string
  try {
    canonical = canonicalGraphql(query)
  } catch (error) {
    throw new Error(`invalid GraphQL document: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (canonical === canonicalGraphql(REVIEW_THREADS_QUERY)) {
    if (!REVIEW_THREAD_TASKS.has(task)) throw new Error(`review-thread GraphQL is not allowed for ${task}`)
    expectBoundRepository(options, variables)
    expectBoundTarget(options, variables, "pr")
    return
  }
  if (canonical === canonicalGraphql(RESOLVE_THREAD_MUTATION)) {
    if (!REVIEW_THREAD_TASKS.has(task)) throw new Error(`resolve-thread GraphQL is not allowed for ${task}`)
    requireTypedId(state.reviewThreadIds, variables, "id", "review thread")
    if (task === "pr_opened") {
      if (state.prDisposition === "triage_closing" || state.prDisposition === "triage_closed") {
        throw new Error("review-thread mutation is not allowed after triage close")
      }
      if (!markerValid(options.finalizerMarker, options)) {
        throw new Error("review finalization marker is required before resolving review threads")
      }
    }
    return
  }
  if (canonical === canonicalGraphql(DISCUSSION_QUERY)) {
    if (!DISCUSSION_TASKS.has(task)) throw new Error(`discussion GraphQL is not allowed for ${task}`)
    expectBoundRepository(options, variables)
    expectBoundTarget(options, variables, "discussion")
    return
  }
  if (canonical === canonicalGraphql(DISCUSSION_ADD_COMMENT)) {
    if (!DISCUSSION_TASKS.has(task)) throw new Error(`discussion mutation is not allowed for ${task}`)
    requireTypedId(state.discussionIds, variables, "id", "discussion")
    return
  }
  if (canonical === canonicalGraphql(DISCUSSION_UPDATE_COMMENT)) {
    if (!DISCUSSION_TASKS.has(task)) throw new Error(`discussion mutation is not allowed for ${task}`)
    requireTypedId(state.discussionCommentIds, variables, "id", "discussion comment")
    return
  }
  if (canonical === canonicalGraphql(MINIMIZE_COMMENT)) {
    if (!new Set<Task>(["engage", "pr_opened"]).has(task)) throw new Error(`comment minimization is not allowed for ${task}`)
    requireTypedId(state.commentNodeIds, variables, "id", "comment node")
    if (state.protectedProgressCommentNodeIds.has(String(variables.id))) {
      throw new Error("broker progress comments are supervisor-owned")
    }
    if (!new Set(["SPAM", "ABUSE", "OFF_TOPIC"]).has(String(variables.classifier))) {
      throw new Error("comment minimization classifier is not allowed")
    }
    return
  }
  if (canonical === canonicalGraphql(ROADMAP_DISCOVERY_QUERY)) {
    if (!ROADMAP_TASKS.has(task)) throw new Error(`roadmap discovery is not allowed for ${task}`)
    expectRoadmapDiscovery(options, variables)
    return
  }
  if (canonical === canonicalGraphql(ROADMAP_ADD_ITEM)) {
    if (!ROADMAP_TASKS.has(task)) throw new Error(`roadmap mutation is not allowed for ${task}`)
    requireTypedId(state.roadmapProjectIds, variables, "p", "roadmap project")
    requireTypedId(state.roadmapContentIds, variables, "c", "roadmap content")
    return
  }
  if (canonical === canonicalGraphql(ROADMAP_MOVE_ITEM)) {
    if (!ROADMAP_TASKS.has(task)) throw new Error(`roadmap mutation is not allowed for ${task}`)
    requireTypedId(state.roadmapProjectIds, variables, "p", "roadmap project")
    requireTypedId(state.roadmapItemIds, variables, "i", "roadmap item")
    requireTypedId(state.roadmapFieldIds, variables, "f", "roadmap field")
    requireTypedId(state.roadmapOptionIds, variables, "o", "roadmap option")
    return
  }
  if (canonical === canonicalGraphql(ROADMAP_ARCHIVE_ITEM)) {
    if (!ROADMAP_TASKS.has(task)) throw new Error(`roadmap mutation is not allowed for ${task}`)
    requireTypedId(state.roadmapProjectIds, variables, "p", "roadmap project")
    requireTypedId(state.roadmapItemIds, variables, "i", "roadmap item")
    return
  }
  if (canonical === canonicalGraphql(ROADMAP_CREATE_STATUS_FIELD)) {
    if (task !== "roadmap_sync") throw new Error(`roadmap bootstrap is not allowed for ${task}`)
    requireTypedId(state.roadmapProjectIds, variables, "p", "roadmap project")
    expectRoadmapOptions(variables)
    return
  }
  if (canonical === canonicalGraphql(ROADMAP_UPDATE_STATUS_FIELD)) {
    if (task !== "roadmap_sync") throw new Error(`roadmap bootstrap is not allowed for ${task}`)
    requireTypedId(state.roadmapFieldIds, variables, "f", "roadmap field")
    expectRoadmapOptions(variables)
    return
  }
  if (canonical === canonicalGraphql(ROADMAP_UPDATE_PROJECT)) {
    if (task !== "roadmap_sync") throw new Error(`roadmap bootstrap is not allowed for ${task}`)
    requireTypedId(state.roadmapProjectIds, variables, "p", "roadmap project")
    if (variables.description !== ROADMAP_PROJECT_DESCRIPTION || variables.readme !== ROADMAP_PROJECT_README) {
      throw new Error("roadmap project metadata does not match the trusted contract")
    }
    return
  }
  try {
    const { operation } = parseSingleOperation(query)
    if (operation.operation !== "query") throw new Error("roadmap GraphQL passthrough is read-only")
  } catch (error) {
    if (error instanceof Error && error.message.includes("read-only")) throw error
  }
  throw new Error(`GraphQL document is not allowed for ${task}; use a fixed typed tool or roadmap discovery`)
}

function authorize(options: GitHubBrokerOptions, state: BrokerAuthorizationState, operation: string, args: Json): void {
  if (operation.startsWith("cchp.")) {
    assertOnlyKeys(args,
      operation === "cchp.installWebDependencies" ? ["mode"]
        : operation === "cchp.seeUpload" ? ["path", "name", "is_private"]
          : [],
    )
    if (!options.repoDir) throw new Error("broker runtime operation has no trusted repository directory")
    if (operation === "cchp.gitFetch") return
    if (operation === "cchp.gitPush") {
      if (!options.allowRepositoryMutation) throw new Error("broker Git push is not allowed for this run")
      return
    }
    if (operation === "cchp.installWebDependencies") {
      if (!options.allowRepositoryMutation) throw new Error("broker dependency installation is not allowed for this run")
      if (!new Set(["frozen", "update"]).has(String(args.mode))) throw new Error("dependency install mode must be frozen or update")
      return
    }
    if (operation === "cchp.seeUpload") {
      if (!options.seeUpload) throw new Error("SEE upload is unavailable for this run")
      if (typeof args.path !== "string" || !args.path.trim()) throw new Error("SEE upload path must be a non-empty string")
      if (args.name != null && (typeof args.name !== "string" || !args.name.trim())) throw new Error("SEE upload name must be a non-empty string")
      if (args.is_private != null && typeof args.is_private !== "boolean") throw new Error("SEE upload privacy flag must be boolean")
      return
    }
    throw new Error(`unknown broker runtime operation: ${operation}`)
  }
  if (operation === "graphql") authorizeGraphql(options, state, args)
  else authorizeRest(options, state, operation, args)
}

async function defaultRunCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })
    let stdout = ""
    let stderr = ""
    const append = (current: string, chunk: Buffer): string => (current + chunk.toString("utf8")).slice(-64 * 1024)
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk) })
    const timer = setTimeout(() => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch { /* process already exited */ }
    }, options.timeoutMs)
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("exit", (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} failed (${signal ?? code ?? "unknown"}): ${(stderr || stdout).trim()}`))
    })
  })
}

async function executeRuntimeOperation(options: GitHubBrokerOptions, operation: string, args: Json): Promise<unknown> {
  const repoDir = options.repoDir!
  const run = options.runCommand ?? defaultRunCommand
  const baseEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? repoDir,
    LANG: process.env.LANG ?? "C.UTF-8",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
  }
  if (operation === "cchp.gitFetch") {
    return run("git", ["fetch", "--prune", "origin"], { cwd: repoDir, env: baseEnv, timeoutMs: 300_000 })
  }
  if (operation === "cchp.gitPush") {
    return run("git", ["push", "origin", "HEAD"], { cwd: repoDir, env: baseEnv, timeoutMs: 300_000 })
  }
  if (operation === "cchp.seeUpload") {
    return options.seeUpload!(
      String(args.path),
      typeof args.name === "string" ? args.name : undefined,
      args.is_private === true,
    )
  }
  const webDir = `${repoDir}/web`
  if (!existsSync(`${webDir}/package.json`)) throw new Error("trusted repository has no web/package.json")
  return run("bun", ["install", ...(args.mode === "frozen" ? ["--frozen-lockfile"] : [])], {
    cwd: webDir,
    env: { ...baseEnv, HEROUI_AUTH_TOKEN: options.herouiAuthToken ?? "" },
    timeoutMs: 600_000,
  })
}

function resolveOperation(client: GitHubClient, operation: string): (...args: any[]) => Promise<unknown> {
  let current: any = client
  for (const part of operation.split(".")) current = current?.[part]
  if (typeof current !== "function") throw new Error(`unknown broker operation: ${operation}`)
  return current.bind(operation === "graphql" ? client : resolveReceiver(client, operation))
}

function resolveReceiver(client: GitHubClient, operation: string): unknown {
  const parts = operation.split(".")
  parts.pop()
  let current: any = client
  for (const part of parts) current = current?.[part]
  return current
}

function dataOf(result: unknown): unknown {
  if (result && typeof result === "object" && !Array.isArray(result) && "data" in result) {
    return (result as Json).data
  }
  return result
}

function rememberNumericProperty(target: Set<number>, result: unknown, property: "id" | "number" = "id"): void {
  const value = dataOf(result)
  const items = Array.isArray(value) ? value : [value]
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const id = positiveInteger((item as Json)[property])
    if (id) target.add(id)
  }
}

function stringId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const id = (value as Json).id
  return typeof id === "string" && id.length > 0 ? id : undefined
}

function jsonObject(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined
}

function jsonArray(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(jsonObject).filter((item): item is Json => !!item) : []
}

function rememberNodeId(target: Set<string>, value: unknown): void {
  const object = jsonObject(value)
  const id = object?.node_id ?? object?.id
  if (typeof id === "string" && id.length > 0) target.add(id)
}

function rememberRepositoryItem(options: GitHubBrokerOptions, state: BrokerAuthorizationState, value: unknown, kind?: "issue" | "pr"): void {
  const object = jsonObject(value)
  if (!object) return
  const number = positiveInteger(object.number)
  if (!number) return
  const isPr = kind === "pr" || (kind == null && object.pull_request != null)
  if (isPr) state.prNumbers.add(number)
  else state.issueNumbers.add(number)
  const nodeId = object.node_id
  if (typeof nodeId === "string" && nodeId.length > 0) {
    if (!options.target || (number === options.target && options.targetKind === (isPr ? "pr" : "issue")) || FULL_BOARD_ROADMAP_TASKS.has(brokerTask(options))) {
      state.roadmapContentIds.add(nodeId)
    }
  }
}

function rememberComment(
  targetIds: Set<number>,
  nodeIds: Set<string>,
  value: unknown,
  protectedIds?: Set<number>,
  protectedNodeIds?: Set<string>,
): void {
  for (const object of Array.isArray(dataOf(value)) ? jsonArray(dataOf(value)) : [jsonObject(dataOf(value))].filter((item): item is Json => !!item)) {
    const id = positiveInteger(object.id)
    if (id) targetIds.add(id)
    rememberNodeId(nodeIds, object)
    if (containsProgressMarker(object.body)) {
      if (id) protectedIds?.add(id)
      const nodeId = typeof object.node_id === "string" && object.node_id ? object.node_id : stringId(object)
      if (nodeId) protectedNodeIds?.add(nodeId)
    }
  }
}

function rememberReviewThreads(state: BrokerAuthorizationState, result: unknown): void {
  const repository = jsonObject(result)?.repository
  const pullRequest = jsonObject(jsonObject(repository)?.pullRequest)
  const reviewThreads = jsonObject(pullRequest?.reviewThreads)
  for (const thread of jsonArray(reviewThreads?.nodes)) {
    const id = stringId(thread)
    if (id) state.reviewThreadIds.add(id)
  }
}

function rememberDiscussion(state: BrokerAuthorizationState, result: unknown): void {
  const repository = jsonObject(result)?.repository
  const discussion = jsonObject(jsonObject(repository)?.discussion)
  const discussionId = stringId(discussion)
  if (discussionId) state.discussionIds.add(discussionId)
  const comments = jsonObject(discussion?.comments)
  for (const comment of jsonArray(comments?.nodes)) {
    const id = stringId(comment)
    if (id) state.discussionCommentIds.add(id)
  }
}

function rememberRoadmapDiscovery(options: GitHubBrokerOptions, state: BrokerAuthorizationState, result: unknown): void {
  const organization = jsonObject(result)?.organization
  const project = jsonObject(jsonObject(organization)?.projectV2)
  const projectId = stringId(project)
  if (projectId) state.roadmapProjectIds.add(projectId)
  const fields = jsonObject(project?.fields)
  for (const field of jsonArray(fields?.nodes)) {
    const fieldId = stringId(field)
    if (fieldId) state.roadmapFieldIds.add(fieldId)
    for (const option of jsonArray(field.options)) {
      const optionId = stringId(option)
      if (optionId) state.roadmapOptionIds.add(optionId)
    }
  }
  const items = jsonObject(project?.items)
  for (const item of jsonArray(items?.nodes)) {
    const content = jsonObject(item.content)
    const repository = jsonObject(content?.repository)
    if (!content || repository?.nameWithOwner !== options.repo) continue
    const type = content.__typename
    const kind = type === "PullRequest" ? "pr" : type === "Issue" ? "issue" : undefined
    if (!kind) continue
    const number = positiveInteger(content.number)
    const fullBoard = FULL_BOARD_ROADMAP_TASKS.has(brokerTask(options)) && options.target == null
    if (!fullBoard && (!number || number !== options.target || kind !== options.targetKind)) continue
    const itemId = stringId(item)
    const contentId = stringId(content)
    if (itemId) state.roadmapItemIds.add(itemId)
    if (contentId) state.roadmapContentIds.add(contentId)
  }
}

function rememberReturnedGraphqlId(target: Set<string>, result: unknown, ...path: string[]): void {
  let current: unknown = result
  for (const key of path) current = jsonObject(current)?.[key]
  const id = stringId(current)
  if (id) target.add(id)
}

function rememberResult(options: GitHubBrokerOptions, state: BrokerAuthorizationState, operation: string, args: Json, result: unknown): void {
  if (operation === "graphql") {
    const canonical = canonicalGraphql(String(args.query ?? ""))
    if (canonical === canonicalGraphql(REVIEW_THREADS_QUERY)) rememberReviewThreads(state, result)
    if (canonical === canonicalGraphql(DISCUSSION_QUERY)) rememberDiscussion(state, result)
    if (canonical === canonicalGraphql(DISCUSSION_ADD_COMMENT)) {
      rememberReturnedGraphqlId(state.discussionCommentIds, result, "addDiscussionComment", "comment")
    }
    if (canonical === canonicalGraphql(ROADMAP_DISCOVERY_QUERY)) rememberRoadmapDiscovery(options, state, result)
    if (canonical === canonicalGraphql(ROADMAP_ADD_ITEM)) {
      rememberReturnedGraphqlId(state.roadmapItemIds, result, "addProjectV2ItemById", "item")
    }
    if (canonical === canonicalGraphql(ROADMAP_CREATE_STATUS_FIELD)) {
      rememberReturnedGraphqlId(state.roadmapFieldIds, result, "createProjectV2Field", "projectV2Field")
    }
    if (canonical === canonicalGraphql(ROADMAP_UPDATE_STATUS_FIELD)) {
      rememberReturnedGraphqlId(state.roadmapFieldIds, result, "updateProjectV2Field", "projectV2Field")
    }
  }
  if (["rest.issues.listComments", "rest.issues.getComment", "rest.issues.createComment", "rest.issues.updateComment"].includes(operation)) {
    rememberComment(
      state.commentIds,
      state.commentNodeIds,
      result,
      state.protectedProgressCommentIds,
      state.protectedProgressCommentNodeIds,
    )
  }
  if (operation === "rest.pulls.listReviewComments") rememberComment(state.reviewCommentIds, state.commentNodeIds, result)
  if (operation === "rest.checks.create") {
    rememberNumericProperty(state.checkRunIds, result)
    for (const id of state.checkRunIds) state.checkRunStatus.set(id, "queued")
  }
  if (operation === "rest.checks.update") {
    const id = positiveInteger(args.check_run_id)
    const status = args.status
    if (id && (status === "queued" || status === "in_progress" || status === "completed")) {
      state.checkRunStatus.set(id, status)
    }
  }
  if (operation === "rest.actions.listJobsForWorkflowRun") rememberNumericProperty(state.workflowJobIds, result)
  if (operation === "rest.repos.getReleaseByTag") {
    const release = jsonObject(dataOf(result))
    const id = positiveInteger(release?.id)
    if (id && release?.tag_name === options.releaseTag && args.tag === options.releaseTag) state.trustedReleaseId = id
  }
  if (["rest.issues.listMilestones", "rest.issues.createMilestone", "rest.issues.updateMilestone"].includes(operation)) {
    rememberNumericProperty(state.milestoneNumbers, result, "number")
  }
  if (operation === "rest.search.issuesAndPullRequests") {
    for (const item of jsonArray(dataOf(result))) rememberRepositoryItem(options, state, item)
  }
  if (operation === "rest.issues.get") rememberRepositoryItem(options, state, dataOf(result))
  if (operation === "rest.pulls.get") rememberRepositoryItem(options, state, dataOf(result), "pr")
}

function transitionAfterSuccess(options: GitHubBrokerOptions, state: BrokerAuthorizationState, operation: string, args: Json): void {
  if (brokerTask(options) !== "pr_opened") return
  const purpose = args[BROKER_PURPOSE_KEY]
  if (operation === "rest.pulls.update") {
    state.prDisposition = "title_updated"
    return
  }
  if (operation === "rest.issues.createComment" && purpose === PR_TITLE_NOTE_PURPOSE) {
    state.prDisposition = "title_noted"
    return
  }
  if (operation === "rest.issues.createComment" && purpose === PR_TRIAGE_CLOSE_PURPOSE) {
    state.prDisposition = "triage_closing"
    return
  }
  if (operation === "rest.issues.update" && purpose === PR_TRIAGE_CLOSE_PURPOSE) {
    state.prDisposition = "triage_closed"
    return
  }
  if (PR_OPENED_MUTATIONS.has(operation)) state.prDisposition = "review_started"
  if (operation === "graphql" && canonicalGraphql(String(args.query ?? "")) === canonicalGraphql(RESOLVE_THREAD_MUTATION)) {
    state.prDisposition = "review_started"
  }
}

function upstreamArgs(args: Json): Json {
  if (!(BROKER_PURPOSE_KEY in args)) return args
  const { [BROKER_PURPOSE_KEY]: _purpose, ...rest } = args
  return rest
}

async function assertLiveReviewHead(options: GitHubBrokerOptions): Promise<void> {
  if (!options.expectedHeadSha || options.targetKind !== "pr" || !options.target) {
    throw new Error("broker review publication is missing trusted PR head ownership")
  }
  const { owner, name } = trustedRepo(options.repo)
  const { data: pull } = await options.octokit.rest.pulls.get({ owner, repo: name, pull_number: options.target })
  if (pull.head?.sha !== options.expectedHeadSha) {
    throw new Error("broker review publication rejected because the live PR head changed")
  }
}

async function execute(options: GitHubBrokerOptions, state: BrokerAuthorizationState, operation: string, args: Json): Promise<unknown> {
  if (operation === "paginate") {
    const targetOperation = String(args.operation ?? "")
    const targetArgs = (args.args && typeof args.args === "object" && !Array.isArray(args.args) ? args.args : {}) as Json
    authorize(options, state, targetOperation, targetArgs)
    const fn = resolveOperation(options.octokit, targetOperation)
    const result = await options.octokit.paginate(fn as never, targetArgs as never)
    rememberResult(options, state, targetOperation, targetArgs, result)
    return result
  }
  authorize(options, state, operation, args)
  if (operation.startsWith("cchp.")) return executeRuntimeOperation(options, operation, args)
  const purpose = args[BROKER_PURPOSE_KEY]
  const reviewPublication = brokerTask(options) === "pr_opened" &&
    PR_OPENED_MUTATIONS.has(operation) &&
    purpose !== PR_TRIAGE_CLOSE_PURPOSE &&
    purpose !== PR_TITLE_NOTE_PURPOSE
  const reviewGraphqlMutation = brokerTask(options) === "pr_opened" && operation === "graphql" &&
    canonicalGraphql(String(args.query ?? "")) === canonicalGraphql(RESOLVE_THREAD_MUTATION)
  const reviewMutation = reviewPublication || reviewGraphqlMutation
  const markerBeforeMutation = reviewMutation ? validMarkerSnapshot(options.finalizerMarker, options) : undefined
  if (reviewMutation) {
    if (!markerBeforeMutation) throw new Error("review finalization marker changed before GitHub publication")
    await assertLiveReviewHead(options)
    const markerAfterHeadCheck = validMarkerSnapshot(options.finalizerMarker, options)
    if (!markerAfterHeadCheck || markerAfterHeadCheck.sha256 !== markerBeforeMutation.sha256) {
      throw new Error("review finalization marker changed during GitHub publication")
    }
  }
  if (operation === "graphql") {
    const result = await options.octokit.graphql(String(args.query ?? ""), (args.variables as Json) ?? {})
    rememberResult(options, state, operation, args, result)
    transitionAfterSuccess(options, state, operation, args)
    return result
  }
  const fn = resolveOperation(options.octokit, operation)
  let trustedArgs = upstreamArgs(args)
  if (operation === "rest.pulls.merge") {
    const { owner, name } = trustedRepo(options.repo)
    const pullNumber = positiveInteger(args.pull_number)
    if (!pullNumber) throw new Error("broker merge requires a trusted PR number")
    const { data: pull } = await options.octokit.rest.pulls.get({ owner, repo: name, pull_number: pullNumber })
    if (!pull.head?.repo?.full_name || pull.head.repo.full_name !== options.repo) {
      throw new Error("fork PRs are never auto-merged (ADR 0004)")
    }
    if (typeof pull.head.sha !== "string" || !SHA40.test(pull.head.sha)) {
      throw new Error("broker merge could not establish the live PR head SHA")
    }
    trustedArgs = { ...trustedArgs, sha: pull.head.sha }
  }
  const result = await fn(trustedArgs)
  rememberResult(options, state, operation, args, result)
  transitionAfterSuccess(options, state, operation, args)
  return result
}

export async function startGitHubBroker(options: GitHubBrokerOptions): Promise<GitHubBrokerHandle> {
  brokerTask(options)
  trustedRepo(options.repo)
  if ((options.target == null) !== (options.targetKind == null)) {
    throw new Error("GitHub broker target and target kind must be provided together")
  }
  mkdirSync(dirname(options.socketPath), { recursive: true, mode: 0o700 })
  try { await unlink(options.socketPath) } catch { /* stale socket is harmless */ }
  const token = randomBytes(32).toString("hex")
  const state = createAuthorizationState(options)
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    handleConnection(socket, options, state, token)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.socketPath, () => { server.removeListener("error", reject); resolve() })
  })
  chmodSync(options.socketPath, 0o600)
  let closing: Promise<void> | undefined
  return {
    socketPath: options.socketPath,
    token,
    async close() {
      if (!closing) {
        closing = (async () => {
          try {
            for (const socket of sockets) socket.destroy()
            await new Promise<void>((resolve, reject) => {
              server.close((error) => error ? reject(error) : resolve())
            })
          } finally {
            try { await unlink(options.socketPath) } catch { /* already removed */ }
          }
        })()
      }
      await closing
    },
  }
}

function handleConnection(socket: Socket, options: GitHubBrokerOptions, state: BrokerAuthorizationState, token: string): void {
  let buffer = ""
  let queue = Promise.resolve()
  socket.setEncoding("utf8")
  socket.on("data", (chunk) => {
    buffer += chunk
    if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
      socket.end(`${JSON.stringify({ ok: false, error: "request too large" })}\n`)
      return
    }
    for (;;) {
      const index = buffer.indexOf("\n")
      if (index < 0) break
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      queue = queue.then(() => handleRequest(socket, options, state, token, line))
    }
  })
}

async function handleRequest(socket: Socket, options: GitHubBrokerOptions, state: BrokerAuthorizationState, token: string, line: string): Promise<void> {
  let request: Json
  try {
    const parsed = JSON.parse(line) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid JSON object")
    request = parsed as Json
  } catch {
    socket.write(`${JSON.stringify({ ok: false, error: "invalid JSON" })}\n`)
    return
  }
  const id = request.id
  try {
    if (typeof request.token !== "string" || !sameToken(request.token, token)) throw new Error("invalid GitHub broker token")
    const args = (request.args as Json) ?? {}
    assertNoForbiddenMaterial(args, [token, ...(options.forbiddenValues?.() ?? [])], "broker request contains credential material")
    const result = await execute(options, state, String(request.operation ?? ""), args)
    socket.write(`${JSON.stringify({ id, ok: true, result })}\n`)
  } catch (error) {
    socket.write(`${JSON.stringify({ id, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`)
  }
}

export function brokerRequest(socketPath: string, token: string, operation: string, args: Json): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = randomBytes(8).toString("hex")
    const socket = connect(socketPath)
    let buffer = ""
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      callback()
    }
    const timer = setTimeout(() => finish(() => reject(new Error(`GitHub broker timeout: ${operation}`))), 120_000)
    socket.setEncoding("utf8")
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, token, operation, args })}\n`))
    socket.on("data", (chunk) => {
      buffer += chunk
      const index = buffer.indexOf("\n")
      if (index < 0) return
      try {
        const parsed = JSON.parse(buffer.slice(0, index)) as unknown
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid broker response")
        const response = parsed as Json
        if (response.id !== id) throw new Error("GitHub broker response id mismatch")
        if (response.ok === true) finish(() => resolve(response.result))
        else finish(() => reject(new Error(String(response.error ?? "GitHub broker request failed"))))
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))))
      }
    })
    socket.on("error", (error) => finish(() => reject(error)))
  })
}

/** A structural Octokit facade: handlers keep using the existing typed paths,
 * while the GitHub token remains inside the supervisor-owned broker. */
export function makeBrokerGitHubClient(socketPath: string, token: string): GitHubClient {
  const makePath = (path: string[]): any => new Proxy(() => undefined, {
    get(_target, property) {
      if (property === "__brokerOperation") return path.join(".")
      return makePath([...path, String(property)])
    },
    apply(_target, _thisArg, args) {
      return brokerRequest(socketPath, token, path.join("."), (args[0] as Json) ?? {})
    },
  })
  const facade: any = {
    rest: makePath(["rest"]),
    cchp: makePath(["cchp"]),
    paginate: (fn: any, args: Json) => brokerRequest(socketPath, token, "paginate", { operation: fn.__brokerOperation, args }),
    graphql: (query: string, variables: Json) => brokerRequest(socketPath, token, "graphql", { query, variables }),
  }
  return facade as GitHubClient
}

export function brokerTokenSource(token: string): TokenSource {
  return token
}
