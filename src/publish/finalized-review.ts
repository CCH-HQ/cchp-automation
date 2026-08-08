import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import { splitRepo } from "../context"
import type { GitHubClient } from "../github/client"
import type { ReviewPublicationBundle } from "../mcp/server"
import { materializeInlinePublication } from "../mcp/server"
import type { FinalizedMarker } from "../review/finalize"
import { hidden, MARKER, type Verdict } from "../types"
import { durableWriteFile } from "../codex/durable-file"
import { assertNoForbiddenMaterial } from "../security/secret-material"
import { LOGO_HEADING, postReviewBatch, reviewHistory, sanitizeText } from "./inline"
import { autoApproveDisabled, submitReview } from "./review"
import { progressMarkerKey } from "./sticky"

type PublicationPhase = "prepared" | "inline_published" | "formal_review_published" | "complete"

export interface ReviewPublicationState {
  schemaVersion: 1
  idempotencyKey: string
  repository: string
  prNumber: number
  runId: string
  headSha: string
  finalizedMarkerSha256: string
  requestedVerdict: Verdict
  effectiveVerdict?: Verdict
  phase: PublicationPhase
  updatedAt: string
}

export interface PublishFinalizedReviewInput {
  octokit: GitHubClient
  repository: string
  prNumber: number
  marker: FinalizedMarker
  bundle: ReviewPublicationBundle
  idempotencyKey: string
  statePath: string
  env?: Record<string, string | undefined>
  forbiddenValues?: () => readonly string[]
}

const PHASES: PublicationPhase[] = ["prepared", "inline_published", "formal_review_published", "complete"]
const GITHUB_BODY_LIMIT = 65_536
const REPORT_CHUNK_BYTES = 58_000
const INLINE_BODY_BYTES = 60_000
const REVIEW_BODY_BYTES = 64_000

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

function takeUtf8(value: string, maxBytes: number): string {
  let result = ""
  let used = 0
  for (const character of value) {
    const size = bytes(character)
    if (used + size > maxBytes) break
    result += character
    used += size
  }
  return result
}

function splitUtf8(value: string, maxBytes: number): string[] {
  if (!value) return [""]
  const chunks: string[] = []
  let chunk = ""
  let used = 0
  for (const character of value) {
    const size = bytes(character)
    if (chunk && used + size > maxBytes) {
      chunks.push(chunk)
      chunk = ""
      used = 0
    }
    chunk += character
    used += size
  }
  if (chunk) chunks.push(chunk)
  return chunks
}

function boundedContent(prefix: string, content: string, suffix: string, maxBytes = GITHUB_BODY_LIMIT): string {
  const available = maxBytes - bytes(prefix) - bytes(suffix)
  if (available < 0) throw new Error("review publication wrapper exceeds GitHub body limit")
  const body = `${prefix}${takeUtf8(content, available)}${suffix}`
  if (bytes(body) > maxBytes) throw new Error("review publication body exceeds GitHub body limit")
  return body
}

function reviewStateVerdict(state: string | undefined): Verdict {
  if (state === "APPROVED") return "APPROVE"
  if (state === "CHANGES_REQUESTED") return "REQUEST_CHANGES"
  if (state === "COMMENTED" || state === "DISMISSED" || state === "PENDING") return "COMMENT"
  throw new Error(`published review has unsupported GitHub state: ${state ?? "<missing>"}`)
}

function markerHash(marker: FinalizedMarker): string {
  return createHash("sha256").update(JSON.stringify(marker)).digest("hex")
}

function readState(path: string): ReviewPublicationState | undefined {
  if (!existsSync(path)) return undefined
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("review publication state must be a regular file")
  const value = JSON.parse(readFileSync(path, "utf8")) as ReviewPublicationState
  if (value.schemaVersion !== 1 || !PHASES.includes(value.phase)) throw new Error("review publication state is invalid")
  return value
}

function saveState(path: string, state: ReviewPublicationState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  durableWriteFile(path, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`)
}

function phaseAtLeast(state: ReviewPublicationState, phase: PublicationPhase): boolean {
  return PHASES.indexOf(state.phase) >= PHASES.indexOf(phase)
}

async function assertOpenHead(
  octokit: GitHubClient,
  repository: string,
  prNumber: number,
  headSha: string,
): Promise<void> {
  const { owner, name } = splitRepo(repository)
  const { data } = await octokit.rest.pulls.get({ owner, repo: name, pull_number: prNumber })
  if (data.number !== prNumber || data.state !== "open" || data.merged || data.merged_at) {
    throw new Error("finalized review target is no longer an open pull request")
  }
  if (data.head.sha !== headSha) throw new Error("finalized review head SHA changed before publication")
}

async function publishSummary(
  octokit: GitHubClient,
  repository: string,
  prNumber: number,
  headSha: string,
  report: string,
  idempotencyKey: string,
  forbiddenValues: () => readonly string[],
): Promise<void> {
  const { owner, name } = splitRepo(repository)
  let comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo: name,
    issue_number: prNumber,
    per_page: 100,
  })
  const summaryMarker = MARKER.sticky("review-summary")
  const progressMarker = progressMarkerKey("pr_opened")
  const exact = (marker: string) => comments.filter((comment) => (comment.body ?? "").includes(hidden(marker)))
  const progress = exact(progressMarker)
  const summaries = exact(summaryMarker)
  const primary = progress[0] ?? summaries[0]
  const chunks = splitUtf8(sanitizeText(report), REPORT_CHUNK_BYTES)
  const used = new Set<number>()
  for (let index = 0; index < chunks.length; index++) {
    const partMarker = `cchp-review-report:${idempotencyKey}:${index + 1}-of-${chunks.length}`
    const suffix = [
      "",
      "---",
      index === 0 ? hidden(summaryMarker) : "",
      hidden(partMarker),
    ].filter(Boolean).join("\n")
    const prefix = `### ${LOGO_HEADING} Code Review Result${chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : ""}\n\n`
    const body = boundedContent(prefix, chunks[index]!, `\n\n${suffix}`)
    assertNoForbiddenMaterial(body, forbiddenValues(), "finalized review publication contains credential material")
    const existing = index === 0
      ? primary
      : comments.find((comment) => (comment.body ?? "").includes(hidden(partMarker)))
    await assertOpenHead(octokit, repository, prNumber, headSha)
    if (existing) {
      await octokit.rest.issues.updateComment({ owner, repo: name, comment_id: existing.id, body })
      used.add(existing.id)
    } else {
      const { data } = await octokit.rest.issues.createComment({ owner, repo: name, issue_number: prNumber, body })
      used.add(data.id)
      comments = [...comments, data]
    }
  }

  for (const comment of comments) {
    const body = comment.body ?? ""
    const owned = body.includes(hidden(summaryMarker))
      || body.includes(hidden(progressMarker))
      || body.includes("<!-- cchp-review-report:")
    if (!owned || used.has(comment.id)) continue
    await assertOpenHead(octokit, repository, prNumber, headSha)
    await octokit.rest.issues.deleteComment({ owner, repo: name, comment_id: comment.id })
  }
}

export async function publishFinalizedReview(input: PublishFinalizedReviewInput): Promise<ReviewPublicationState> {
  const expected: Omit<ReviewPublicationState, "effectiveVerdict" | "phase" | "updatedAt"> = {
    schemaVersion: 1,
    idempotencyKey: input.idempotencyKey,
    repository: input.repository,
    prNumber: input.prNumber,
    runId: input.marker.run_id,
    headSha: input.marker.head_sha,
    finalizedMarkerSha256: markerHash(input.marker),
    requestedVerdict: input.bundle.formalVerdict,
  }
  let state = readState(input.statePath) ?? { ...expected, phase: "prepared" as const, updatedAt: new Date().toISOString() }
  for (const [key, value] of Object.entries(expected)) {
    if (state[key as keyof ReviewPublicationState] !== value) {
      throw new Error(`review publication state binding changed: ${key}`)
    }
  }
  saveState(input.statePath, state)

  if (!phaseAtLeast(state, "inline_published")) {
    const fingerprints = Object.keys(input.bundle.publishableInline).sort()
    for (let offset = 0; offset < fingerprints.length; offset += 50) {
      await assertOpenHead(input.octokit, input.repository, input.prNumber, input.bundle.headSha)
      const comments = materializeInlinePublication(input.bundle, fingerprints.slice(offset, offset + 50)).map((comment) => ({
        ...comment,
        body: boundedContent("", comment.body, "\n\n_Full details are retained in the finalized review report._", INLINE_BODY_BYTES),
      }))
      assertNoForbiddenMaterial(comments, input.forbiddenValues?.() ?? [], "finalized review publication contains credential material")
      const outcome = await postReviewBatch(input.octokit, input.repository, {
        prNumber: input.prNumber,
        headSha: input.bundle.headSha,
        patch: input.bundle.patch,
        comments,
        summary: "Finalized inline findings. The complete report is published in the review summary comments.",
      })
      if (outcome.status === "rejected" || outcome.rejected?.length) {
        throw new Error("finalized inline findings failed trusted patch validation")
      }
    }
    state = { ...state, phase: "inline_published" }
    saveState(input.statePath, state)
  }

  if (!phaseAtLeast(state, "formal_review_published")) {
    await assertOpenHead(input.octokit, input.repository, input.prNumber, input.bundle.headSha)
    const publicationMarker = `cchp-review-publication:${input.idempotencyKey}`
    const history = await reviewHistory(input.octokit, input.repository, input.prNumber)
    const publishedReview = history.find((entry) => entry.kind === "review" && (entry.body ?? "").includes(hidden(publicationMarker)))
    let effectiveVerdict = state.effectiveVerdict
    if (!publishedReview) {
      const reviewBody = boundedContent(
        "### Finalized Code Review\n\n",
        sanitizeText(input.bundle.report),
        `\n\n_The complete report is published in the review summary comments._\n\n${hidden(publicationMarker)}`,
        REVIEW_BODY_BYTES,
      )
      assertNoForbiddenMaterial(reviewBody, input.forbiddenValues?.() ?? [], "finalized review publication contains credential material")
      const outcome = await submitReview(input.octokit, input.repository, input.prNumber, {
        event: input.bundle.formalVerdict,
        body: reviewBody,
        headSha: input.bundle.headSha,
        autoApproveDisabled: autoApproveDisabled(input.env),
      })
      effectiveVerdict = outcome.event
    } else {
      effectiveVerdict = reviewStateVerdict(publishedReview.state)
    }
    const killSwitchVerdict = input.bundle.formalVerdict === "APPROVE" && autoApproveDisabled(input.env)
      ? "COMMENT"
      : input.bundle.formalVerdict
    state = { ...state, phase: "formal_review_published", effectiveVerdict: effectiveVerdict ?? killSwitchVerdict }
    saveState(input.statePath, state)
  }

  if (!phaseAtLeast(state, "complete")) {
    await publishSummary(
      input.octokit,
      input.repository,
      input.prNumber,
      input.bundle.headSha,
      input.bundle.report,
      input.idempotencyKey,
      input.forbiddenValues ?? (() => []),
    )
    state = { ...state, phase: "complete" }
    saveState(input.statePath, state)
  }
  return state
}
