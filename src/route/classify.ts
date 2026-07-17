// The event router's DECISION core, ported from route.sh. Pure: given a parsed
// event + injected Lookups (the only I/O), it returns whether to act, whether a
// write token is needed, the BOT_* env to export, and the prompt intent. No
// network, no fs — so every gating invariant is unit-tested (classify.test.ts).
//
// SECURITY INVARIANTS preserved verbatim from route.sh:
//   * Never act on the bot's own events (no feedback loops).
//   * Code execution on a human's behalf (write) only for repo/org members.
//   * A Fork PR (head repo != base repo) never receives a code-write token for
//     engage, and is never auto-merged on LGTM.
//   * All event/comment/diff text is UNTRUSTED — surfaced as data, never acted on.
import type { Overlay } from "../config/overlay"
import { isForkPr, newlyCheckedActionIds, type BotEnv, type RouteResult, type Task } from "../types"

export interface PrInfo {
  base: string
  head: string
  sha: string
  headRepoFullName: string | null
}
export interface PendingRocket {
  issueNumber: number
  commentId: number
  reactor: string
}

/** The only I/O classify performs, injected so decisions stay pure + mockable. */
export interface Lookups {
  /** write+ = collaborator push/admin OR org member. */
  canWrite(actor: string): Promise<boolean>
  /** PR base/head/sha + head repo full name (for fork detection). */
  prInfo(num: number): Promise<PrInfo>
  /** First PR number associated with a commit sha, or null. */
  prForSha(sha: string): Promise<number | null>
  /** Scheduled 🚀 poll: find a pending plan-execution, or null. */
  findPendingRocketExecution(botUser: string): Promise<PendingRocket | null>
}

export interface ClassifyInput {
  eventName: string
  event: Record<string, any>
  repo: string
  botUser: string
  overlay: Overlay
  /** For workflow_run self-exclusion — the bot's own workflow name (GITHUB_WORKFLOW). */
  selfWorkflowName?: string
  dispatch?: { task?: string; prompt?: string; branch?: string; canWrite?: string }
}

const isBotActor = (login: unknown): boolean => typeof login === "string" && login.endsWith("[bot]")
const isLgtm = (body: unknown): boolean => typeof body === "string" && /^[\t ]*lgtm\b/i.test(body)
const cwEnv = (b: boolean): "0" | "1" => (b ? "1" : "0")

export async function classify(input: ClassifyInput, lookups: Lookups): Promise<RouteResult> {
  const { eventName: ev, event: e, repo, botUser, overlay } = input
  const defaultBranch = overlay.defaultBranch
  const base = { BOT_REPO: repo, BOT_DEFAULT_BRANCH: defaultBranch } satisfies Partial<BotEnv>
  const noAct = (reason: string): RouteResult => ({ act: false, needsWrite: false, env: base, reason })
  const act = (
    env: Partial<BotEnv>,
    task: Task,
    vars: Record<string, string | number | boolean>,
    opts: { needsWrite: boolean; ack?: RouteResult["ack"] } = { needsWrite: false },
  ): RouteResult => ({
    act: true,
    needsWrite: opts.needsWrite,
    env: { ...base, ...env, BOT_TASK: task },
    intent: { task, vars },
    ack: opts.ack,
  })

  switch (ev) {
    // ── issues ────────────────────────────────────────────────────────────────
    case "issues": {
      const a = String(e.action ?? "")
      const num = Number(e.issue?.number)
      if (["closed", "assigned", "unassigned", "milestoned", "demilestoned", "labeled", "unlabeled"].includes(a)) {
        // Board upkeep — fires even for bot actors (only writes the project board,
        // never comments; no feedback loop). No label allowlist.
        const detail = a === "closed" ? ` (reason: ${e.issue?.state_reason ?? "unknown"})` : ""
        return act(
          { BOT_CAN_WRITE: "0", BOT_ISSUE_NUMBER: String(num), BOT_TARGET_BRANCH: defaultBranch },
          "roadmap_item",
          { issueNumber: num, action: a, detail },
          { needsWrite: false },
        )
      }
      if (!["opened", "edited", "reopened"].includes(a)) return noAct(`issues.${a}`)
      if (isBotActor(e.sender?.login)) return noAct("issue event by bot")
      // Authority derives from the SENDER (who did this edit/reopen), not the author.
      const actor = String(e.sender?.login ?? "")
      const cw = await lookups.canWrite(actor)
      return act(
        { BOT_CAN_WRITE: cwEnv(cw), BOT_ISSUE_NUMBER: String(num), BOT_TARGET_BRANCH: defaultBranch },
        "engage",
        { issueNumber: num, action: a, actor, member: cw },
        { needsWrite: cw, ack: { kind: "rest", target: `issues/${num}` } },
      )
    }

    // ── issue_comment ───────────────────────────────────────────────────────────
    case "issue_comment": {
      const a = String(e.action ?? "")
      if (!["created", "edited"].includes(a)) return noAct(`issue_comment.${a}`)
      const actor = String(e.comment?.user?.login ?? "")
      const num = Number(e.issue?.number)
      const body = String(e.comment?.body ?? "")
      const cid = Number(e.comment?.id)
      const sender = String(e.sender?.login ?? "")
      const isPr = e.issue?.pull_request != null

      // Interactive action menu: a human checking a box on a BOT-authored menu
      // arrives as `edited` with author=bot + sender=human.
      if (a === "edited" && isBotActor(actor) && sender && !isBotActor(sender) && body.includes("<!-- cchp-action:")) {
        if (!(await lookups.canWrite(sender))) return noAct(`action box checked by non-member @${sender}`)
        const prevBody = String(e.changes?.body?.from ?? "")
        const actionId = newlyCheckedActionIds(prevBody, body)[0]
        if (!actionId) return noAct("edit did not newly check any action box")
        const ackMenu = { kind: "rest", target: `issues/comments/${cid}` } as const
        if (isPr) {
          const pr = await lookups.prInfo(num)
          const fork = isForkPr(pr.headRepoFullName, repo)
          const effectiveCw = fork ? false : true
          return act(
            {
              BOT_PR_NUMBER: String(num), BOT_PR_BASE: pr.base, BOT_TARGET_BRANCH: pr.head,
              BOT_HEAD_SHA: pr.sha, BOT_CAN_WRITE: cwEnv(effectiveCw), BOT_PR_IS_FORK: fork ? "1" : "0",
            },
            "engage",
            { kind: "action_menu_pr", prNumber: num, fork, actionId, commentId: cid, sender },
            { needsWrite: effectiveCw, ack: ackMenu },
          )
        }
        return act(
          { BOT_CAN_WRITE: "1", BOT_ISSUE_NUMBER: String(num), BOT_TARGET_BRANCH: defaultBranch },
          "engage",
          { kind: "action_menu_issue", issueNumber: num, actionId, commentId: cid, sender },
          { needsWrite: true, ack: ackMenu },
        )
      }

      if (isBotActor(actor)) return noAct("comment by bot")
      const ackComment = { kind: "rest", target: `issues/comments/${cid}` } as const
      const cw = await lookups.canWrite(actor)
      if (isPr) {
        const pr = await lookups.prInfo(num)
        const fork = isForkPr(pr.headRepoFullName, repo)
        const prEnv: Partial<BotEnv> = {
          BOT_PR_NUMBER: String(num), BOT_PR_BASE: pr.base, BOT_TARGET_BRANCH: pr.head,
          BOT_HEAD_SHA: pr.sha, BOT_PR_IS_FORK: fork ? "1" : "0",
        }
        if (isLgtm(body) && cw) {
          // ADR 0004: a Fork PR is never auto-merged. Withhold the write token
          // (base token = Contents:read = physically cannot merge); the bot may
          // still label + comment, but a maintainer merges the fork manually.
          return act(
            { ...prEnv, BOT_CAN_WRITE: fork ? "0" : "1" },
            "lgtm_merge",
            { prNumber: num, base: pr.base, fork, actor },
            { needsWrite: !fork, ack: ackComment },
          )
        }
        const effectiveCw = fork ? false : cw
        return act(
          { ...prEnv, BOT_CAN_WRITE: cwEnv(effectiveCw) },
          "engage",
          { kind: "pr_comment", prNumber: num, actor, member: cw, fork },
          { needsWrite: effectiveCw, ack: ackComment },
        )
      }
      return act(
        { BOT_CAN_WRITE: cwEnv(cw), BOT_ISSUE_NUMBER: String(num), BOT_TARGET_BRANCH: defaultBranch },
        "engage",
        { kind: "issue_comment", issueNumber: num, actor, member: cw },
        { needsWrite: cw, ack: ackComment },
      )
    }

    // ── pull_request_target ─────────────────────────────────────────────────────
    case "pull_request_target": {
      const a = String(e.action ?? "")
      const num = Number(e.pull_request?.number)
      const prBase = String(e.pull_request?.base?.ref ?? "")
      const head = String(e.pull_request?.head?.ref ?? "")
      const fork = isForkPr(e.pull_request?.head?.repo?.full_name ?? null, repo)
      if (a === "closed") {
        // Fires for merged AND abandoned PRs incl. bot-merged — sits BEFORE the
        // bot-actor guard. Fork PRs sync too (read-only board write).
        return act(
          { BOT_CAN_WRITE: "0", BOT_PR_NUMBER: String(num), BOT_TARGET_BRANCH: defaultBranch, BOT_PR_IS_FORK: fork ? "1" : "0" },
          "roadmap_item",
          { prNumber: num, merged: Boolean(e.pull_request?.merged) },
          { needsWrite: false },
        )
      }
      if (isBotActor(e.sender?.login)) return noAct("PR event by bot")
      if (a === "labeled") {
        if (!/^lgtm$/i.test(String(e.label?.name ?? ""))) return noAct("label not LGTM")
        const sender = String(e.sender?.login ?? "")
        if (!(await lookups.canWrite(sender))) return noAct(`LGTM label by non-member @${sender}`)
        // ADR 0004: Fork PRs are never auto-merged — withhold the write token.
        return act(
          {
            BOT_PR_NUMBER: String(num), BOT_PR_BASE: prBase, BOT_TARGET_BRANCH: head,
            BOT_HEAD_SHA: String(e.pull_request?.head?.sha ?? ""), BOT_CAN_WRITE: fork ? "0" : "1", BOT_PR_IS_FORK: fork ? "1" : "0",
          },
          "lgtm_merge",
          { prNumber: num, base: prBase, fork, sender },
          { needsWrite: !fork, ack: { kind: "rest", target: `issues/${num}` } },
        )
      }
      if (["opened", "edited", "reopened", "ready_for_review", "synchronize"].includes(a)) {
        const actor = String(e.pull_request?.user?.login ?? "")
        if (actor === botUser) return noAct("PR by self")
        const metadataOnly = a === "edited" && !e.changes?.base?.ref?.from
        const prEnv: Partial<BotEnv> = {
          BOT_CAN_WRITE: "1", BOT_PR_NUMBER: String(num), BOT_PR_BASE: prBase,
          BOT_HEAD_SHA: String(e.pull_request?.head?.sha ?? ""), BOT_TARGET_BRANCH: prBase,
          BOT_PR_IS_FORK: fork ? "1" : "0",
        }
        if (metadataOnly) prEnv.BOT_SKIP_PR_INSPECT = "1"
        return act(
          prEnv,
          "pr_opened",
          { prNumber: num, action: a, actor, fork, metadataOnly },
          { needsWrite: false, ack: { kind: "rest", target: `issues/${num}` } },
        )
      }
      return noAct(`pr.${a}`)
    }

    // ── pull_request_review | pull_request_review_comment ───────────────────────
    case "pull_request_review":
    case "pull_request_review_comment": {
      const a = String(e.action ?? "")
      if (!["submitted", "created"].includes(a)) return noAct(`${ev}.${a}`)
      const actor = ev === "pull_request_review" ? String(e.review?.user?.login ?? "") : String(e.comment?.user?.login ?? "")
      if (isBotActor(actor)) return noAct("review by bot")
      const num = Number(e.pull_request?.number)
      const cw = await lookups.canWrite(actor)
      const fork = isForkPr(e.pull_request?.head?.repo?.full_name ?? null, repo)
      const effectiveCw = fork ? false : cw
      const ackTarget = ev === "pull_request_review_comment" ? `pulls/comments/${e.comment?.id}` : `issues/${num}`
      return act(
        {
          BOT_CAN_WRITE: cwEnv(effectiveCw), BOT_PR_NUMBER: String(num),
          BOT_HEAD_SHA: String(e.pull_request?.head?.sha ?? ""), BOT_TARGET_BRANCH: String(e.pull_request?.head?.ref ?? ""),
          BOT_PR_BASE: String(e.pull_request?.base?.ref ?? ""), BOT_PR_IS_FORK: fork ? "1" : "0",
        },
        "engage",
        { kind: "pr_review", prNumber: num, actor, member: cw, fork },
        { needsWrite: effectiveCw, ack: { kind: "rest", target: ackTarget } },
      )
    }

    // ── discussion | discussion_comment ─────────────────────────────────────────
    case "discussion":
    case "discussion_comment": {
      if (String(e.action ?? "") !== "created") return noAct(`${ev}.${e.action}`)
      if (isBotActor(e.sender?.login)) return noAct("discussion event by bot")
      const actor = ev === "discussion" ? String(e.discussion?.user?.login ?? "") : String(e.comment?.user?.login ?? "")
      const node = ev === "discussion" ? String(e.discussion?.node_id ?? "") : String(e.comment?.node_id ?? "")
      if (isBotActor(actor)) return noAct("discussion by bot")
      const num = Number(e.discussion?.number)
      const cw = await lookups.canWrite(actor)
      return act(
        { BOT_CAN_WRITE: cwEnv(cw), BOT_DISCUSSION_NUMBER: String(num), BOT_TARGET_BRANCH: defaultBranch },
        "engage",
        { kind: "discussion", discussionNumber: num, event: ev, actor, member: cw },
        { needsWrite: cw, ack: { kind: "node", target: node } },
      )
    }

    // ── workflow_run → CI auto-fix on failure ───────────────────────────────────
    case "workflow_run": {
      if (String(e.workflow_run?.conclusion ?? "") !== "failure") return noAct(`run conclusion ${e.workflow_run?.conclusion}`)
      const wfname = String(e.workflow_run?.name ?? "")
      if (input.selfWorkflowName && wfname === input.selfWorkflowName) return noAct("own workflow")
      const rid = String(e.workflow_run?.id ?? "")
      const sha = String(e.workflow_run?.head_sha ?? "")
      const br = String(e.workflow_run?.head_branch ?? "")
      const pr = await lookups.prForSha(sha)
      const env: Partial<BotEnv> = { BOT_CAN_WRITE: "1", BOT_RUN_ID: rid, BOT_HEAD_SHA: sha }
      if (pr != null) {
        const info = await lookups.prInfo(pr)
        if (isForkPr(info.headRepoFullName, repo)) return noAct("failed workflow belongs to fork PR")
        env.BOT_PR_NUMBER = String(pr)
        env.BOT_TARGET_BRANCH = br
      } else {
        env.BOT_TARGET_BRANCH = br || defaultBranch
      }
      return act(env, "ci_fix", { workflow: wfname, runId: rid, branch: br, sha, prNumber: pr ?? "" }, { needsWrite: true })
    }

    // ── release → release notes ─────────────────────────────────────────────────
    case "release": {
      const a = String(e.action ?? "")
      if (!["published", "released", "created", "prereleased"].includes(a)) return noAct(`release.${a}`)
      if (isBotActor(e.sender?.login)) return noAct("release by self")
      const tag = String(e.release?.tag_name ?? "")
      return act(
        { BOT_CAN_WRITE: "1", BOT_RELEASE_TAG: tag, BOT_TARGET_BRANCH: defaultBranch },
        "release_notes",
        { tag, event: ev },
        { needsWrite: true },
      )
    }

    // ── schedule → roadmap reconcile OR 🚀 reaction poll ────────────────────────
    case "schedule": {
      const sched = String(e.schedule ?? "")
      if (sched === "23 1,13 * * *") {
        return act(
          { BOT_CAN_WRITE: "0", BOT_TARGET_BRANCH: defaultBranch },
          "roadmap_sync",
          { roadmapProject: overlay.roadmapProject },
          { needsWrite: false },
        )
      }
      // Only the two known crons; anything else means the workflow + this case drifted.
      if (sched !== "*/10 * * * *") return noAct(`UNKNOWN cron '${sched}' — update the schedule case to match the workflow`)
      const found = await lookups.findPendingRocketExecution(botUser)
      if (!found) return noAct("no pending 🚀 reactions")
      return act(
        {
          BOT_CAN_WRITE: "1", BOT_ISSUE_NUMBER: String(found.issueNumber),
          BOT_PLAN_COMMENT_ID: String(found.commentId), BOT_TARGET_BRANCH: defaultBranch,
        },
        "reaction_execute",
        { issueNumber: found.issueNumber, commentId: found.commentId, reactor: found.reactor },
        { needsWrite: true },
      )
    }

    // ── workflow_dispatch → manual escape hatch ─────────────────────────────────
    case "workflow_dispatch": {
      const canWrite = (input.dispatch?.canWrite ?? "1") === "1"
      const task = (input.dispatch?.task || "engage") as Task
      return act(
        { BOT_CAN_WRITE: cwEnv(canWrite), BOT_TARGET_BRANCH: input.dispatch?.branch || defaultBranch },
        task,
        { kind: "manual", prompt: input.dispatch?.prompt ?? "" },
        { needsWrite: canWrite },
      )
    }

    default:
      return noAct(`unhandled event ${ev}`)
  }
}
