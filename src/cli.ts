#!/usr/bin/env bun
// Engine entry: the `route` step. Reads the event, classifies it (pure), exports
// BOT_* env + act/needs_write outputs, best-effort 👀 acks, renders the prompt,
// and gathers task-specific context. Every GitHub call goes through the one
// Octokit client (ADR 0003). The bash route.sh + context.sh, in TS.
import { appendFileSync } from "node:fs"
import { loadOverlay } from "./config/overlay"
import { makeOctokit, type GitHubClient } from "./github/client"
import { readEvent, setEnv, setOutput } from "./github/actions-io"
import {
  type CtxDeps,
  ctxDiscussion,
  ctxIssue,
  ctxPr,
  ctxPrReview,
  ctxWorkflow,
  noopReviewContext,
} from "./context"
import { classify } from "./route/classify"
import { makeLookups } from "./route/lookups"
import { renderPrompt } from "./route/prompts"
import type { RouteResult } from "./types"

function need(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is required`)
  return v
}

/** Best-effort 👀 so a human sees the bot picked the event up (never fatal). */
async function ack(octokit: GitHubClient, repo: string, a: NonNullable<RouteResult["ack"]>): Promise<void> {
  try {
    if (a.kind === "rest") {
      await octokit.request(`POST /repos/${repo}/${a.target}/reactions`, { content: "eyes" })
    } else {
      await octokit.graphql(
        `mutation($id:ID!){addReaction(input:{subjectId:$id,content:EYES}){clientMutationId}}`,
        { id: a.target },
      )
    }
  } catch {
    // Reactions are cosmetic; a failure must never block the run.
  }
}

/** Gather task-specific context into ctx/ + append to the prompt, mirroring
 *  route.sh's per-branch ctx_* calls. */
async function gatherContext(deps: CtxDeps, ev: string, e: Record<string, any>, r: RouteResult): Promise<void> {
  const task = r.env.BOT_TASK
  const isFork = r.env.BOT_PR_IS_FORK === "1"
  const kind = r.intent?.vars.kind
  const menu = kind === "action_menu_pr" || kind === "action_menu_issue"
  switch (ev) {
    case "issues":
      if (task === "roadmap_item") {
        if (e.action === "closed") await ctxIssue(deps, e.issue.number, "")
      } else {
        await ctxIssue(deps, e.issue.number, e.issue?.body)
      }
      break
    case "issue_comment": {
      const num = e.issue.number
      const body = menu ? "" : (e.comment?.body ?? "")
      if (e.issue?.pull_request != null) await ctxPr(deps, num, body, isFork)
      else await ctxIssue(deps, num, body)
      break
    }
    case "pull_request_target": {
      const num = e.pull_request.number
      if (task === "pr_opened") await ctxPrReview(deps, num, e.pull_request?.body)
      else if (task === "roadmap_item" || task === "lgtm_merge") await ctxPr(deps, num, "")
      break
    }
    case "pull_request_review":
    case "pull_request_review_comment": {
      const body = ev === "pull_request_review" ? e.review?.body : e.comment?.body
      await ctxPr(deps, e.pull_request.number, body, isFork)
      break
    }
    case "discussion":
    case "discussion_comment": {
      const body = ev === "discussion" ? e.discussion?.body : e.comment?.body
      await ctxDiscussion(deps, e.discussion.number, body)
      break
    }
    case "workflow_run":
      await ctxWorkflow(deps, e.workflow_run.id)
      break
    // release / roadmap_sync / reaction_execute / workflow_dispatch: no pre-fetch.
  }
}

export async function run(): Promise<void> {
  const eventName = need("GITHUB_EVENT_NAME")
  const event = readEvent()
  const repo = need("GH_REPO")
  const botUser = `${need("BOT_SLUG")}[bot]`
  const overlay = loadOverlay()
  const token = need("GH_TOKEN")
  const workdir = need("BOT_WORKDIR")
  const promptFile = `${workdir}/prompt.md`
  const octokit = makeOctokit(token)

  const result = await classify(
    {
      eventName,
      event,
      repo,
      botUser,
      overlay,
      selfWorkflowName: process.env.GITHUB_WORKFLOW,
      dispatch: {
        task: process.env.BOT_DISPATCH_TASK,
        prompt: process.env.BOT_DISPATCH_PROMPT,
        branch: process.env.BOT_DISPATCH_BRANCH,
        canWrite: process.env.BOT_DISPATCH_CAN_WRITE,
      },
    },
    makeLookups(octokit, repo),
  )

  // Export env for later steps AND this process (context/review read some in-proc).
  for (const [k, v] of Object.entries(result.env)) {
    if (v == null) continue
    setEnv(k, v)
    process.env[k] = v
  }

  if (!result.act) {
    setOutput("act", "false")
    console.error(`[route] no action: ${result.reason ?? ""}`)
    return
  }
  setOutput("act", "true")
  setOutput("needs_write", result.needsWrite ? "true" : "false")

  if (result.ack) await ack(octokit, repo, result.ack)

  if (result.intent) appendFileSync(promptFile, renderPrompt(result.intent, { repo, overlay }))

  const deps: CtxDeps = {
    octokit,
    repo,
    ctxDir: `${workdir}/ctx`,
    appendPrompt: (t) => appendFileSync(promptFile, t),
    // TODO(cchp: swap for the real ReviewContext once #5 review pipeline lands —
    // pr_opened diff + manifest are no-op until then).
    review: noopReviewContext,
  }
  await gatherContext(deps, eventName, event, result)
}

if (import.meta.main) {
  run().catch((err) => {
    console.error(`[route] fatal: ${err?.message ?? err}`)
    process.exit(1)
  })
}
