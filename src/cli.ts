#!/usr/bin/env bun
// Engine entry: the `route` step. Reads the event, classifies it (pure), exports
// BOT_* env + act/needs_write outputs, best-effort 👀 acks, renders the prompt,
// and gathers task-specific context. Every GitHub call goes through the one
// Octokit client (ADR 0003). The bash route.sh + context.sh, in TS.
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { randomUUID } from "node:crypto"
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
} from "./context"
import { makeReviewContext } from "./review/review-context"
import { classify } from "./route/classify"
import { makeLookups } from "./route/lookups"
import { renderPrompt } from "./route/prompts"
import type { RouteResult } from "./types"

function need(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is required`)
  return v
}

type RouteAck = NonNullable<RouteResult["ack"]>

function routeAckPath(workdir: string): string {
  return `${workdir}/ctx/route-ack.json`
}

function parseRouteAck(value: unknown): RouteAck {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid route ack record")
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(",") !== "kind,target") throw new Error("invalid route ack record")
  if (record.kind !== "rest" && record.kind !== "node") throw new Error("invalid route ack kind")
  if (typeof record.target !== "string" || record.target.length === 0 || record.target.length > 1024) {
    throw new Error("invalid route ack target")
  }
  return { kind: record.kind, target: record.target }
}

export function persistRouteAck(workdir: string, value: RouteAck): string {
  const ack = parseRouteAck(value)
  const ctxDir = `${workdir}/ctx`
  const path = routeAckPath(workdir)
  const temporary = `${ctxDir}/.route-ack.${randomUUID()}.tmp`
  mkdirSync(ctxDir, { recursive: true })
  try {
    writeFileSync(temporary, `${JSON.stringify(ack)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
    return path
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function readRouteAck(workdir: string): RouteAck | undefined {
  const path = routeAckPath(workdir)
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error("route ack record must be a private regular file")
  }
  return parseRouteAck(JSON.parse(readFileSync(path, "utf8")))
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

async function runAckMode(): Promise<void> {
  const workdir = need("BOT_WORKDIR")
  const routeAck = readRouteAck(workdir)
  if (!routeAck) return
  await ack(makeOctokit(need("GH_TOKEN")), need("GH_REPO"), routeAck)
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
  if (process.env.CCHP_ROUTE_ACK === "1") {
    await runAckMode()
    return
  }
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

  mkdirSync(`${workdir}/ctx`, { recursive: true })
  if (result.ack) persistRouteAck(workdir, result.ack)

  if (result.intent) appendFileSync(promptFile, renderPrompt(result.intent, { repo, overlay }))

  // The route step runs before repository preparation (which later creates
  // ${workdir}/ctx), so ensure it exists now — otherwise the first oversized
  // context / trigger / pr-diff / manifest write below throws ENOENT and aborts
  // the whole run. (Regression from the bash route.sh → TS port.)
  const reviewDeps = {
    octokit,
    repo,
    ctxDir: `${workdir}/ctx`,
    appendPrompt: (t: string) => appendFileSync(promptFile, t),
  }
  // The real ReviewContext (#5): pr_opened diff capture + schema_version:1 manifest.
  const deps: CtxDeps = { ...reviewDeps, review: makeReviewContext(reviewDeps) }
  await gatherContext(deps, eventName, event, result)
}

if (import.meta.main) {
  run().catch((err) => {
    console.error(`[route] fatal: ${err?.message ?? err}`)
    process.exit(1)
  })
}
