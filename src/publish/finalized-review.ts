import { createHash } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { splitRepo } from "../context"
import type { GitHubClient } from "../github/client"
import type { ReviewPublicationBundle } from "../mcp/server"
import { materializeInlinePublication } from "../mcp/server"
import type { FinalizedMarker } from "../review/finalize"
import { hidden, MARKER, type Verdict } from "../types"
import { durableWriteFile } from "../codex/durable-file"
import { openRegularFileSnapshot } from "../codex/file-snapshot"
import { assertNoForbiddenMaterial } from "../security/secret-material"
import { LOGO_HEADING, normalizeFingerprint, postReviewBatch, reviewHistory, sanitizeText, stripFingerprintMarkers, type HistoryEntry, type InlineComment, type PublishedReviewBatch } from "./inline"
import { autoApproveDisabled, submitReview } from "./review"
import { progressMarkerKey, trustedBotLogin, type StickyResult } from "./sticky"

type PublicationPhase = "prepared" | "inline_published" | "formal_review_published" | "complete"

export interface ReviewPublicationState {
  schemaVersion: 2
  idempotencyKey: string
  repository: string
  prNumber: number
  runId: string
  headSha: string
  finalizedMarkerSha256: string
  requestedVerdict: Verdict
  effectiveVerdict?: Verdict
  inlineComments?: PublishedInlineCommentManifest[]
  formalReview?: PublishedFormalReviewManifest
  summaryCommentId?: number
  summaryAction?: StickyResult["action"]
  summaryCommentUrl?: string
  summaryParts?: ReviewSummaryPartManifest[]
  pendingMutation?: PendingReviewMutation
  phase: PublicationPhase
  updatedAt: string
}

type PendingReviewMutation =
  | { kind: "inline_review"; marker: string; armedAt: string }
  | { kind: "formal_review"; marker: string; armedAt: string }
  | { kind: "summary_create"; marker: string; armedAt: string }
  | { kind: "summary_update"; commentId: number; previousBody: string; nextBodySha256: string; armedAt: string }
  | { kind: "summary_delete"; commentId: number; previousBody: string; armedAt: string }

type PendingReviewMutationInput = PendingReviewMutation extends infer Mutation
  ? Mutation extends PendingReviewMutation ? Omit<Mutation, "armedAt"> : never
  : never

export interface PublishedInlineCommentManifest {
  commentId: number
  fingerprint: string
  commitId: string
  path: string
  line: number
  side: "LEFT" | "RIGHT"
  startLine?: number
  startSide?: "LEFT" | "RIGHT"
  bodySha256: string
}

export interface PublishedFormalReviewManifest {
  reviewId: number
  commitId: string
  state: string
  bodySha256: string
}

export interface ReviewSummaryPartManifest {
  commentId: number
  marker: string
  sha256: string
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
  onSummaryPublished?: (result: StickyResult) => void | Promise<void>
  onSummaryMutationStarting?: (repair: () => Promise<void>) => void | Promise<void>
}

export interface PreparedFinalizedReviewPublication {
  schemaVersion: 1
  repository: string
  prNumber: number
  idempotencyKey: string
  marker: FinalizedMarker
  bundle: ReviewPublicationBundle
  preparedAt: string
}

const PHASES: PublicationPhase[] = ["prepared", "inline_published", "formal_review_published", "complete"]
const GITHUB_BODY_LIMIT = 65_536
const REPORT_CHUNK_BYTES = 58_000
const INLINE_BODY_BYTES = 60_000
const REVIEW_BODY_BYTES = 64_000

export function parsePreparedFinalizedReviewPublication(value: unknown): PreparedFinalizedReviewPublication {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("prepared review publication must be an object")
  const record = value as Partial<PreparedFinalizedReviewPublication>
  const marker = record.marker as Partial<FinalizedMarker> | undefined
  const bundle = record.bundle as Partial<ReviewPublicationBundle> | undefined
  if (
    record.schemaVersion !== 1 || typeof record.repository !== "string" || !record.repository ||
    !Number.isSafeInteger(record.prNumber) || Number(record.prNumber) <= 0 ||
    typeof record.idempotencyKey !== "string" || !record.idempotencyKey ||
    !marker || marker.valid !== true || marker.repository !== record.repository || marker.pr_number !== record.prNumber ||
    typeof marker.run_id !== "string" || !marker.run_id || typeof marker.head_sha !== "string" || !/^[a-f0-9]{40,64}$/.test(marker.head_sha) ||
    !bundle || bundle.headSha !== marker.head_sha || typeof bundle.report !== "string" || typeof bundle.patch !== "string" ||
    !bundle.report || !bundle.patch || !Number.isSafeInteger(bundle.findingCount) || Number(bundle.findingCount) < 0 ||
    !bundle.publishableInline || typeof bundle.publishableInline !== "object" || Array.isArray(bundle.publishableInline) ||
    !["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(String(bundle.formalVerdict)) ||
    typeof record.preparedAt !== "string" || Number.isNaN(Date.parse(record.preparedAt))
  ) throw new Error("prepared review publication binding is invalid")
  return record as PreparedFinalizedReviewPublication
}

export function writePreparedFinalizedReviewPublication(
  path: string,
  input: Pick<PublishFinalizedReviewInput, "repository" | "prNumber" | "marker" | "bundle" | "idempotencyKey" | "forbiddenValues">,
): PreparedFinalizedReviewPublication {
  const record = parsePreparedFinalizedReviewPublication({
    schemaVersion: 1,
    repository: input.repository,
    prNumber: input.prNumber,
    idempotencyKey: input.idempotencyKey,
    marker: input.marker,
    bundle: input.bundle,
    preparedAt: new Date().toISOString(),
  })
  assertNoForbiddenMaterial(record, input.forbiddenValues?.() ?? [], "prepared finalized review contains credential material")
  durableWriteFile(path, `${JSON.stringify(record, null, 2)}\n`)
  return record
}

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

function markerHash(marker: FinalizedMarker): string {
  return createHash("sha256").update(JSON.stringify(marker)).digest("hex")
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function readState(path: string): ReviewPublicationState | undefined {
  if (!existsSync(path)) return undefined
  const snapshot = openRegularFileSnapshot(path)
  if (snapshot.nlink !== 1) throw new Error("review publication state must be a single-link regular file")
  const value = JSON.parse(snapshot.bytes.toString("utf8")) as ReviewPublicationState
  if (value.schemaVersion !== 2 || !PHASES.includes(value.phase)) throw new Error("review publication state is invalid")
  if (phaseAtLeast(value, "inline_published") && !Array.isArray(value.inlineComments)) {
    throw new Error("review publication state is missing inline attestation")
  }
  if (phaseAtLeast(value, "formal_review_published") && (!value.formalReview || !value.effectiveVerdict)) {
    throw new Error("review publication state is missing formal review attestation")
  }
  if (phaseAtLeast(value, "complete") && (!value.summaryCommentId || !value.summaryAction || !value.summaryParts?.length)) {
    throw new Error("review publication state is missing summary attestation")
  }
  if (value.pendingMutation) {
    const pending = value.pendingMutation
    const validTime = typeof pending.armedAt === "string" && !Number.isNaN(Date.parse(pending.armedAt))
    const valid = validTime && (
      ((pending.kind === "inline_review" || pending.kind === "formal_review" || pending.kind === "summary_create") &&
        typeof pending.marker === "string" && /^[A-Za-z0-9:._-]{1,240}$/.test(pending.marker)) ||
      (pending.kind === "summary_update" && Number.isSafeInteger(pending.commentId) && pending.commentId > 0 &&
        typeof pending.previousBody === "string" && bytes(pending.previousBody) <= GITHUB_BODY_LIMIT &&
        typeof pending.nextBodySha256 === "string" && /^[a-f0-9]{64}$/.test(pending.nextBodySha256)) ||
      (pending.kind === "summary_delete" && Number.isSafeInteger(pending.commentId) && pending.commentId > 0 &&
        typeof pending.previousBody === "string" && bytes(pending.previousBody) <= GITHUB_BODY_LIMIT)
    )
    if (!valid) throw new Error("review publication pending mutation is invalid")
  }
  return value
}

function saveState(path: string, state: ReviewPublicationState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  durableWriteFile(path, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`)
}

function phaseAtLeast(state: ReviewPublicationState, phase: PublicationPhase): boolean {
  return PHASES.indexOf(state.phase) >= PHASES.indexOf(phase)
}

function expectedInlineComments(bundle: ReviewPublicationBundle): InlineComment[] {
  const fingerprints = Object.keys(bundle.publishableInline).sort()
  if (fingerprints.length === 0) return []
  const comments = [] as ReturnType<typeof materializeInlinePublication>
  for (let offset = 0; offset < fingerprints.length; offset += 50) {
    comments.push(...materializeInlinePublication(bundle, fingerprints.slice(offset, offset + 50)))
  }
  return comments.map((comment) => ({
    ...comment,
    body: boundedContent("", comment.body, "\n\n_Full details are retained in the finalized review report._", INLINE_BODY_BYTES),
  }))
}

function inlineManifest(
  history: HistoryEntry[],
  expected: InlineComment[],
  ownerLogin: string,
  headSha: string,
): PublishedInlineCommentManifest[] {
  return expected.map((comment) => {
    const normalized = normalizeFingerprint(comment.fingerprint)
    const side = comment.side ?? "RIGHT"
    const body = `${stripFingerprintMarkers(comment.body).trim()}\n\n${hidden(MARKER.fingerprint(normalized))}`
    const matches = history.filter((entry) =>
      entry.kind === "inline" && entry.user === ownerLogin && entry.commit_id === headSha &&
      entry.fingerprints.includes(normalized) && entry.body === body &&
      entry.path === comment.path && entry.line === comment.line && (entry.side ?? "RIGHT") === side &&
      entry.start_line === comment.start_line && entry.start_side === comment.start_side,
    )
    if (matches.length !== 1 || !matches[0]!.id) {
      throw new Error(`finalized inline finding ${normalized} is missing, duplicated, or stale`)
    }
    return {
      commentId: matches[0]!.id!,
      fingerprint: normalized,
      commitId: headSha,
      path: comment.path,
      line: comment.line,
      side,
      ...(comment.start_line === undefined ? {} : { startLine: comment.start_line }),
      ...(comment.start_side === undefined ? {} : { startSide: comment.start_side }),
      bodySha256: sha256(body),
    }
  })
}

function expectedFormalReviewBody(bundle: ReviewPublicationBundle, idempotencyKey: string): string {
  return boundedContent(
    "### Finalized Code Review\n\n",
    sanitizeText(bundle.report),
    `\n\n_The complete report is published in the review summary comments._\n\n${hidden(`cchp-review-publication:${idempotencyKey}`)}`,
    REVIEW_BODY_BYTES,
  )
}

function formalReviewManifest(
  history: HistoryEntry[],
  ownerLogin: string,
  headSha: string,
  candidates: readonly { body: string; state: string; verdict: Verdict }[],
): { manifest: PublishedFormalReviewManifest; verdict: Verdict } {
  const matches = history.filter((entry) =>
    entry.kind === "review" && entry.user === ownerLogin && entry.commit_id === headSha &&
    candidates.some((candidate) => candidate.body === (entry.body ?? "") && candidate.state === entry.state),
  )
  if (matches.length !== 1 || !matches[0]!.id || !matches[0]!.state) {
    throw new Error("finalized formal review is missing, duplicated, or stale")
  }
  const review = matches[0]!
  const candidate = candidates.find((entry) => entry.body === (review.body ?? "") && entry.state === review.state)!
  return {
    manifest: {
      reviewId: review.id!,
      commitId: headSha,
      state: review.state!,
      bodySha256: sha256(review.body ?? ""),
    },
    verdict: candidate.verdict,
  }
}

function formalReviewCandidates(bundle: ReviewPublicationBundle, idempotencyKey: string): Array<{ body: string; state: string; verdict: Verdict }> {
  const body = expectedFormalReviewBody(bundle, idempotencyKey)
  const state = bundle.formalVerdict === "APPROVE"
    ? "APPROVED"
    : bundle.formalVerdict === "REQUEST_CHANGES"
      ? "CHANGES_REQUESTED"
      : "COMMENTED"
  return [
    { body, state, verdict: bundle.formalVerdict },
    ...(bundle.formalVerdict === "APPROVE"
      ? [{
          body: `${body}\n\n_Auto-approve is disabled; posting as a comment instead of an approval._`,
          state: "COMMENTED",
          verdict: "COMMENT" as const,
        }]
      : []),
  ]
}

interface ExpectedSummaryPart {
  marker: string
  body: string
}

function expectedSummaryParts(report: string, idempotencyKey: string): ExpectedSummaryPart[] {
  const summaryMarker = MARKER.sticky("review-summary")
  const chunks = splitUtf8(sanitizeText(report), REPORT_CHUNK_BYTES)
  return chunks.map((chunk, index) => {
    const marker = `cchp-review-report:${idempotencyKey}:${index + 1}-of-${chunks.length}`
    const suffix = [
      "",
      "---",
      index === 0 ? hidden(summaryMarker) : "",
      hidden(marker),
    ].filter(Boolean).join("\n")
    const prefix = `### ${LOGO_HEADING} Code Review Result${chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : ""}\n\n`
    return { marker, body: boundedContent(prefix, chunk, `\n\n${suffix}`) }
  })
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

interface SummaryCompensation {
  description: string
  run: () => Promise<void>
}

interface ReviewCompensation {
  description: string
  run: () => Promise<void>
}

async function compensatePublishedReview(
  octokit: GitHubClient,
  repository: string,
  prNumber: number,
  publication: PublishedReviewBatch,
): Promise<void> {
  const { owner, name } = splitRepo(repository)
  const failures: unknown[] = []
  for (const commentId of [...publication.commentIds].reverse()) {
    try {
      await octokit.rest.pulls.deleteReviewComment({ owner, repo: name, comment_id: commentId })
    } catch (error) {
      failures.push(new Error(`failed to delete review comment ${commentId}`, { cause: error }))
    }
  }
  try {
    await octokit.rest.pulls.dismissReview({
      owner,
      repo: name,
      pull_number: prNumber,
      review_id: publication.reviewId,
      message: "Dismissed because the pull request head changed during CCHP publication.",
      event: "DISMISS",
    })
  } catch (error) {
    failures.push(new Error(`failed to dismiss review ${publication.reviewId}`, { cause: error }))
  }
  if (failures.length > 0) throw new AggregateError(failures, "review compensation was incomplete")
}

async function rollbackReviewMutations(
  publicationError: unknown,
  journal: ReviewCompensation[],
  onCompensated?: () => void | Promise<void>,
): Promise<never> {
  const compensationErrors: unknown[] = []
  for (const compensation of [...journal].reverse()) {
    try {
      await compensation.run()
    } catch (error) {
      compensationErrors.push(new Error(`review compensation failed: ${compensation.description}`, { cause: error }))
    }
  }
  if (compensationErrors.length > 0) {
    throw new AggregateError(
      [publicationError, ...compensationErrors],
      "finalized review publication failed and compensation was incomplete",
      { cause: publicationError },
    )
  }
  await onCompensated?.()
  throw publicationError
}

function armPendingMutation(
  input: PublishFinalizedReviewInput,
  state: ReviewPublicationState,
  mutation: PendingReviewMutationInput,
): void {
  const pending = { ...mutation, armedAt: new Date().toISOString() } as PendingReviewMutation
  assertNoForbiddenMaterial(pending, input.forbiddenValues?.() ?? [], "review publication journal contains credential material")
  state.pendingMutation = pending
  saveState(input.statePath, state)
}

function clearPendingMutation(input: PublishFinalizedReviewInput, state: ReviewPublicationState): void {
  if (!state.pendingMutation) return
  delete state.pendingMutation
  saveState(input.statePath, state)
}

async function recoverPendingMutation(
  input: PublishFinalizedReviewInput,
  ownerLogin: string,
  state: ReviewPublicationState,
): Promise<void> {
  const pending = state.pendingMutation
  if (!pending) return
  let headError: unknown
  try {
    await assertOpenHead(input.octokit, input.repository, input.prNumber, input.bundle.headSha)
    clearPendingMutation(input, state)
    return
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("finalized review ")) throw error
    headError = error
  }

  const { owner, name } = splitRepo(input.repository)
  try {
    if (pending.kind === "inline_review" || pending.kind === "formal_review") {
      const history = await reviewHistory(input.octokit, input.repository, input.prNumber)
      const matches = history.filter((entry) =>
        entry.kind === "review" && entry.user === ownerLogin && entry.commit_id === input.bundle.headSha &&
        (entry.body ?? "").includes(hidden(pending.marker)) && entry.state !== "DISMISSED" && entry.state !== "PENDING",
      )
      if (matches.length > 1 || (matches[0] && !matches[0].id)) {
        throw new Error("pending review mutation identity is duplicated or invalid")
      }
      if (matches[0]?.id) {
        const reviewId = matches[0].id
        const comments = pending.kind === "inline_review"
          ? await input.octokit.paginate(input.octokit.rest.pulls.listCommentsForReview, {
              owner,
              repo: name,
              pull_number: input.prNumber,
              review_id: reviewId,
              per_page: 100,
            })
          : []
        const commentIds = comments.map((comment) => {
          if (
            !Number.isSafeInteger(comment.id) || comment.id <= 0 ||
            comment.pull_request_review_id !== reviewId || comment.commit_id !== input.bundle.headSha
          ) throw new Error("pending review comment identity is invalid")
          return comment.id
        })
        await compensatePublishedReview(input.octokit, input.repository, input.prNumber, {
          reviewId,
          commitId: input.bundle.headSha,
          state: matches[0].state ?? "",
          commentIds,
        })
      }
    } else {
      const comments = await input.octokit.paginate(input.octokit.rest.issues.listComments, {
        owner,
        repo: name,
        issue_number: input.prNumber,
        per_page: 100,
      })
      if (pending.kind === "summary_create") {
        const matches = comments.filter((comment) =>
          comment.user?.login === ownerLogin && (comment.body ?? "").includes(hidden(pending.marker)))
        if (matches.length > 1) throw new Error("pending summary create identity is duplicated")
        if (matches[0]) {
          await input.octokit.rest.issues.deleteComment({ owner, repo: name, comment_id: matches[0].id })
        }
      } else if (pending.kind === "summary_update") {
        const comment = comments.find((entry) => entry.id === pending.commentId && entry.user?.login === ownerLogin)
        const currentBody = comment?.body ?? ""
        if (comment && sha256(currentBody) === pending.nextBodySha256) {
          await input.octokit.rest.issues.updateComment({
            owner,
            repo: name,
            comment_id: pending.commentId,
            body: pending.previousBody,
          })
        } else if (comment && currentBody !== pending.previousBody) {
          throw new Error("pending summary update remote body is ambiguous")
        }
      } else {
        const comment = comments.find((entry) => entry.id === pending.commentId && entry.user?.login === ownerLogin)
        if (!comment) {
          await input.octokit.rest.issues.createComment({
            owner,
            repo: name,
            issue_number: input.prNumber,
            body: pending.previousBody,
          })
        } else if ((comment.body ?? "") !== pending.previousBody) {
          throw new Error("pending summary delete remote body is ambiguous")
        }
      }
    }
  } catch (compensationError) {
    throw new AggregateError(
      [headError, new Error("durable review compensation failed", { cause: compensationError })],
      "pending review publication crossed a head change and compensation was incomplete",
      { cause: headError },
    )
  }
  clearPendingMutation(input, state)
  throw headError
}

async function rollbackSummaryMutations(
  publicationError: unknown,
  journal: SummaryCompensation[],
  onCompensated?: () => void | Promise<void>,
): Promise<never> {
  const compensationErrors: unknown[] = []
  for (const compensation of [...journal].reverse()) {
    try {
      await compensation.run()
    } catch (error) {
      compensationErrors.push(new Error(`summary compensation failed: ${compensation.description}`, { cause: error }))
    }
  }
  if (compensationErrors.length > 0) {
    throw new AggregateError(
      [publicationError, ...compensationErrors],
      "finalized review summary publication failed and compensation was incomplete",
      { cause: publicationError },
    )
  }
  await onCompensated?.()
  throw publicationError
}

async function publishSummary(
  octokit: GitHubClient,
  repository: string,
  prNumber: number,
  headSha: string,
  report: string,
  idempotencyKey: string,
  forbiddenValues: () => readonly string[],
  ownerLogin: string,
  armMutation: (mutation: PendingReviewMutationInput) => void,
  commitMutation: () => void,
): Promise<{ summary: StickyResult; parts: ReviewSummaryPartManifest[] }> {
  const { owner, name } = splitRepo(repository)
  let comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo: name,
    issue_number: prNumber,
    per_page: 100,
  })
  const summaryMarker = MARKER.sticky("review-summary")
  const progressMarker = progressMarkerKey("pr_opened")
  const exact = (marker: string) => comments.filter((comment) =>
    (comment.body ?? "").includes(hidden(marker)) &&
    comment.user?.login === ownerLogin,
  )
  const progress = exact(progressMarker)
  const summaries = exact(summaryMarker)
  const primary = progress[0] ?? summaries[0]
  const parts = expectedSummaryParts(report, idempotencyKey)
  const used = new Set<number>()
  const publishedParts: ReviewSummaryPartManifest[] = []
  const compensationJournal: SummaryCompensation[] = []
  let summaryResult: StickyResult | undefined
  try {
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!
      const body = part.body
      assertNoForbiddenMaterial(body, forbiddenValues(), "finalized review publication contains credential material")
      const existing = index === 0
        ? primary
        : comments.find((comment) =>
            (comment.body ?? "").includes(hidden(part.marker)) &&
            comment.user?.login === ownerLogin)
      await assertOpenHead(octokit, repository, prNumber, headSha)
      if (existing) {
        const previousBody = existing.body ?? ""
        armMutation({ kind: "summary_update", commentId: existing.id, previousBody, nextBodySha256: sha256(body) })
        const { data } = await octokit.rest.issues.updateComment({ owner, repo: name, comment_id: existing.id, body })
        compensationJournal.push({
          description: `restore comment ${existing.id}`,
          run: async () => {
            await octokit.rest.issues.updateComment({ owner, repo: name, comment_id: existing.id, body: previousBody })
          },
        })
        await assertOpenHead(octokit, repository, prNumber, headSha)
        commitMutation()
        used.add(existing.id)
        publishedParts.push({ commentId: existing.id, marker: part.marker, sha256: createHash("sha256").update(body).digest("hex") })
        if (index === 0) summaryResult = {
          action: "updated",
          id: existing.id,
          htmlUrl: data.html_url ?? "",
        }
      } else {
        armMutation({ kind: "summary_create", marker: part.marker })
        const { data } = await octokit.rest.issues.createComment({ owner, repo: name, issue_number: prNumber, body })
        compensationJournal.push({
          description: `delete created comment ${data.id}`,
          run: async () => {
            await octokit.rest.issues.deleteComment({ owner, repo: name, comment_id: data.id })
          },
        })
        await assertOpenHead(octokit, repository, prNumber, headSha)
        commitMutation()
        used.add(data.id)
        publishedParts.push({ commentId: data.id, marker: part.marker, sha256: createHash("sha256").update(body).digest("hex") })
        comments = [...comments, data]
        if (index === 0) summaryResult = {
          action: "created",
          id: data.id,
          htmlUrl: data.html_url ?? "",
        }
      }
    }

    await assertOpenHead(octokit, repository, prNumber, headSha)
    for (const comment of comments) {
      const body = comment.body ?? ""
      const owned = comment.user?.login === ownerLogin && (body.includes(hidden(summaryMarker))
        || body.includes(hidden(progressMarker))
        || body.includes("<!-- cchp-review-report:")
      )
      if (!owned || used.has(comment.id)) continue
      await assertOpenHead(octokit, repository, prNumber, headSha)
      armMutation({ kind: "summary_delete", commentId: comment.id, previousBody: body })
      await octokit.rest.issues.deleteComment({ owner, repo: name, comment_id: comment.id })
      compensationJournal.push({
        description: `recreate deleted comment ${comment.id}`,
        run: async () => {
          await octokit.rest.issues.createComment({ owner, repo: name, issue_number: prNumber, body })
        },
      })
      await assertOpenHead(octokit, repository, prNumber, headSha)
      commitMutation()
    }
    await assertOpenHead(octokit, repository, prNumber, headSha)
  } catch (error) {
    return rollbackSummaryMutations(error, compensationJournal, compensationJournal.length > 0 ? commitMutation : undefined)
  }
  if (!summaryResult) throw new Error("finalized review summary publication produced no primary comment")
  return { summary: summaryResult, parts: publishedParts }
}

async function assertSummaryStillComplete(
  input: PublishFinalizedReviewInput,
  ownerLogin: string,
  state: ReviewPublicationState,
): Promise<void> {
  await assertOpenHead(input.octokit, input.repository, input.prNumber, input.bundle.headSha)
  if (!input.marker || !input.idempotencyKey) throw new Error("finalized review resume identity is incomplete")
  if (!state.summaryCommentId || !state.summaryAction) {
    throw new Error("complete review publication state is missing summary identity")
  }
  const { owner, name } = splitRepo(input.repository)
  const comments = await input.octokit.paginate(input.octokit.rest.issues.listComments, {
    owner,
    repo: name,
    issue_number: input.prNumber,
    per_page: 100,
  })
  const owned = (comment: (typeof comments)[number]): boolean =>
    comment.user?.login === ownerLogin
  const parts = expectedSummaryParts(input.bundle.report, input.idempotencyKey)
  if (!state.summaryParts || state.summaryParts.length !== parts.length) {
    throw new Error("complete review publication state is missing the summary manifest")
  }
  const expectedMarkers = new Set(parts.map((part) => hidden(part.marker)))
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!
    const marker = hidden(part.marker)
    const matches = comments.filter((comment) => owned(comment) && (comment.body ?? "").includes(marker))
    if (matches.length !== 1 || matches[0]!.body !== part.body) {
      throw new Error(`finalized review summary part ${index + 1} is missing, duplicated, or stale`)
    }
    const manifest = state.summaryParts[index]!
    if (
      manifest.commentId !== matches[0]!.id || manifest.marker !== part.marker ||
      manifest.sha256 !== createHash("sha256").update(part.body).digest("hex")
    ) throw new Error(`finalized review summary manifest part ${index + 1} is stale`)
    if (index === 0 && matches[0]!.id !== state.summaryCommentId) {
      throw new Error("finalized review summary primary identity changed")
    }
  }
  const summaryMarker = hidden(MARKER.sticky("review-summary"))
  const progressMarker = hidden(progressMarkerKey("pr_opened"))
  const summaries = comments.filter((comment) => owned(comment) && (comment.body ?? "").includes(summaryMarker))
  if (summaries.length !== 1 || summaries[0]!.id !== state.summaryCommentId) {
    throw new Error("finalized review summary primary is missing or duplicated")
  }
  if (comments.some((comment) => owned(comment) && (comment.body ?? "").includes(progressMarker))) {
    throw new Error("finalized review summary has stale owned progress")
  }
  for (const comment of comments) {
    if (!owned(comment)) continue
    const body = comment.body ?? ""
    if (!body.includes("<!-- cchp-review-report:")) continue
    if (![...expectedMarkers].some((marker) => body.includes(marker))) {
      throw new Error("finalized review summary has stale owned fragments")
    }
  }
}

async function assertReviewArtifactsStillComplete(
  input: PublishFinalizedReviewInput,
  ownerLogin: string,
  state: ReviewPublicationState,
): Promise<void> {
  await assertOpenHead(input.octokit, input.repository, input.prNumber, input.bundle.headSha)
  const history = await reviewHistory(input.octokit, input.repository, input.prNumber)
  const inline = inlineManifest(history, expectedInlineComments(input.bundle), ownerLogin, input.bundle.headSha)
  if (JSON.stringify(inline) !== JSON.stringify(state.inlineComments)) {
    throw new Error("finalized inline attestation changed after publication")
  }
  const formal = formalReviewManifest(
    history,
    ownerLogin,
    input.bundle.headSha,
    formalReviewCandidates(input.bundle, input.idempotencyKey),
  )
  if (
    JSON.stringify(formal.manifest) !== JSON.stringify(state.formalReview) ||
    formal.verdict !== state.effectiveVerdict
  ) throw new Error("finalized formal review attestation changed after publication")
}

export async function publishFinalizedReview(input: PublishFinalizedReviewInput): Promise<ReviewPublicationState> {
  const expected: Omit<ReviewPublicationState, "effectiveVerdict" | "phase" | "updatedAt"> = {
    schemaVersion: 2,
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
  const publicationOwner = trustedBotLogin(input.env)
  if (!publicationOwner) throw new Error("finalized review publication requires a trusted bot login")
  await recoverPendingMutation(input, publicationOwner, state)
  const expectedInline = expectedInlineComments(input.bundle)

  if (!phaseAtLeast(state, "inline_published")) {
    const compensationJournal: ReviewCompensation[] = []
    try {
      for (let offset = 0; offset < expectedInline.length; offset += 50) {
        await assertOpenHead(input.octokit, input.repository, input.prNumber, input.bundle.headSha)
        const comments = expectedInline.slice(offset, offset + 50)
        const batchMarker = `cchp-inline-publication:${input.idempotencyKey}:${offset / 50 + 1}`
        assertNoForbiddenMaterial(comments, input.forbiddenValues?.() ?? [], "finalized review publication contains credential material")
        const outcome = await postReviewBatch(input.octokit, input.repository, {
          prNumber: input.prNumber,
          headSha: input.bundle.headSha,
          patch: input.bundle.patch,
          comments,
          summary: "Finalized inline findings. The complete report is published in the review summary comments.",
          publicationMarker: batchMarker,
          canonicalOwnerLogin: publicationOwner,
          beforeMutation: async () => {
            await assertOpenHead(input.octokit, input.repository, input.prNumber, input.bundle.headSha)
            armPendingMutation(input, state, { kind: "inline_review", marker: batchMarker })
          },
        })
        if (outcome.status === "rejected" || outcome.rejected?.length) {
          throw new Error("finalized inline findings failed trusted patch validation")
        }
        if (outcome.status === "posted") {
          compensationJournal.push({
            description: `remove inline review ${outcome.publication.reviewId}`,
            run: () => compensatePublishedReview(input.octokit, input.repository, input.prNumber, outcome.publication),
          })
          await assertOpenHead(input.octokit, input.repository, input.prNumber, input.bundle.headSha)
          clearPendingMutation(input, state)
        }
      }
      await assertOpenHead(input.octokit, input.repository, input.prNumber, input.bundle.headSha)
      const history = await reviewHistory(input.octokit, input.repository, input.prNumber)
      await assertOpenHead(input.octokit, input.repository, input.prNumber, input.bundle.headSha)
      state = {
        ...state,
        phase: "inline_published",
        inlineComments: inlineManifest(history, expectedInline, publicationOwner, input.bundle.headSha),
      }
      saveState(input.statePath, state)
    } catch (error) {
      return rollbackReviewMutations(
        error,
        compensationJournal,
        compensationJournal.length > 0 ? () => clearPendingMutation(input, state) : undefined,
      )
    }
  }

  if (!phaseAtLeast(state, "formal_review_published")) {
    const compensationJournal: ReviewCompensation[] = []
    try {
      await assertOpenHead(input.octokit, input.repository, input.prNumber, input.bundle.headSha)
      const publicationMarker = `cchp-review-publication:${input.idempotencyKey}`
      let history = await reviewHistory(input.octokit, input.repository, input.prNumber)
      const reviewCandidates = formalReviewCandidates(input.bundle, input.idempotencyKey)
      const publishedReview = history.find((entry) =>
        entry.kind === "review" &&
        entry.user === publicationOwner &&
        (entry.body ?? "").includes(hidden(publicationMarker)) &&
        reviewCandidates.some((candidate) => candidate.body === entry.body && candidate.state === entry.state))
      const reviewBody = expectedFormalReviewBody(input.bundle, input.idempotencyKey)
      if (!publishedReview) {
        assertNoForbiddenMaterial(reviewBody, input.forbiddenValues?.() ?? [], "finalized review publication contains credential material")
        const publication = await submitReview(input.octokit, input.repository, input.prNumber, {
          event: input.bundle.formalVerdict,
          body: reviewBody,
          headSha: input.bundle.headSha,
          autoApproveDisabled: autoApproveDisabled(input.env),
          beforeMutation: async () => {
            await assertOpenHead(input.octokit, input.repository, input.prNumber, input.bundle.headSha)
            armPendingMutation(input, state, { kind: "formal_review", marker: publicationMarker })
          },
        })
        compensationJournal.push({
          description: `dismiss formal review ${publication.reviewId}`,
          run: () => compensatePublishedReview(input.octokit, input.repository, input.prNumber, {
            reviewId: publication.reviewId,
            commitId: publication.commitId,
            state: publication.state,
            commentIds: [],
          }),
        })
        await assertOpenHead(input.octokit, input.repository, input.prNumber, input.bundle.headSha)
        clearPendingMutation(input, state)
        history = await reviewHistory(input.octokit, input.repository, input.prNumber)
      }
      await assertOpenHead(input.octokit, input.repository, input.prNumber, input.bundle.headSha)
      const killSwitchVerdict = input.bundle.formalVerdict === "APPROVE" && autoApproveDisabled(input.env)
        ? "COMMENT"
        : input.bundle.formalVerdict
      const attestation = formalReviewManifest(history, publicationOwner, input.bundle.headSha, [
        ...reviewCandidates,
      ])
      state = {
        ...state,
        phase: "formal_review_published",
        effectiveVerdict: attestation.verdict ?? killSwitchVerdict,
        formalReview: attestation.manifest,
      }
      saveState(input.statePath, state)
    } catch (error) {
      return rollbackReviewMutations(
        error,
        compensationJournal,
        compensationJournal.length > 0 ? () => clearPendingMutation(input, state) : undefined,
      )
    }
  }

  const commitSummary = async (
    summary: StickyResult,
    summaryParts: ReviewSummaryPartManifest[],
    phase: PublicationPhase = state.phase,
  ): Promise<void> => {
    state = {
      ...state,
      phase,
      summaryCommentId: summary.id,
      summaryAction: summary.action,
      summaryCommentUrl: summary.htmlUrl,
      summaryParts,
    }
    saveState(input.statePath, state)
    await input.onSummaryPublished?.(summary)
  }
  let summaryMutationTail = Promise.resolve()
  const mutateSummary = (phase: PublicationPhase = state.phase): Promise<void> => {
    const mutation = async () => {
      const publication = await publishSummary(
        input.octokit,
        input.repository,
        input.prNumber,
        input.bundle.headSha,
        input.bundle.report,
        input.idempotencyKey,
        input.forbiddenValues ?? (() => []),
        publicationOwner,
        (mutation) => armPendingMutation(input, state, mutation),
        () => clearPendingMutation(input, state),
      )
      await commitSummary(publication.summary, publication.parts, phase)
    }
    summaryMutationTail = summaryMutationTail.then(mutation, mutation)
    return summaryMutationTail
  }
  const repairSummary = () => mutateSummary()
  await input.onSummaryMutationStarting?.(repairSummary)

  if (phaseAtLeast(state, "formal_review_published")) {
    await assertReviewArtifactsStillComplete(input, publicationOwner, state)
  }

  if (!phaseAtLeast(state, "complete")) {
    await mutateSummary("complete")
  } else {
    try {
      await assertSummaryStillComplete(input, publicationOwner, state)
    } catch {
      await mutateSummary("complete")
      return state
    }
    await input.onSummaryPublished?.({
      id: state.summaryCommentId!,
      action: state.summaryAction!,
      htmlUrl: state.summaryCommentUrl ?? "",
    })
  }
  return state
}
