// The frozen protocol contract (DESIGN §8): tasks, BOT_* env, comment markers,
// verdict, review artifacts. The only logic here is pure helpers; everything else
// is types. This file is a port target for the whole engine — keep it stable.
import { createHash } from "node:crypto"

// ── Tasks (frozen enum) ──────────────────────────────────────────────────────
export const TASKS = [
  "engage",
  "pr_opened",
  "lgtm_merge",
  "ci_fix",
  "release_notes",
  "roadmap_item",
  "roadmap_sync",
  "reaction_execute",
  "manual",
  "dispatch",
] as const
export type Task = (typeof TASKS)[number]

// ── Review verdict (GitHub review states; agent chooses autonomously, ADR 0004) ─
export type Verdict = "COMMENT" | "REQUEST_CHANGES" | "APPROVE"

// ── BOT_* env contract emitted by `route` → consumed by `run` (frozen) ───────
export interface BotEnv {
  BOT_TASK: Task
  BOT_CAN_WRITE: "0" | "1"
  BOT_REPO: string
  BOT_DEFAULT_BRANCH: string
  BOT_TARGET_BRANCH?: string
  BOT_PR_BASE?: string
  BOT_PR_NUMBER?: string
  BOT_ISSUE_NUMBER?: string
  BOT_DISCUSSION_NUMBER?: string
  BOT_HEAD_SHA?: string
  BOT_RUN_ID?: string
  BOT_RELEASE_TAG?: string
  BOT_PLAN_COMMENT_ID?: string
  BOT_SKIP_PR_INSPECT?: "1"
  BOT_PR_IS_FORK?: "0" | "1"
}

/** What the agent is being asked to do: the task plus the values to interpolate
 *  into its prompt. The prompt *text* is rendered downstream (assembly slice) so
 *  the routing decision stays pure + testable. */
export interface PromptIntent {
  task: Task
  vars: Record<string, string | number | boolean>
}

/** The outcome of routing one event: whether to act, whether write access is
 *  needed, the BOT_* env to export, the prompt intent, and the reaction ack. */
export interface RouteResult {
  act: boolean
  needsWrite: boolean
  env: Partial<BotEnv>
  intent?: PromptIntent
  /** Reaction to add so a human sees the bot picked the event up. */
  ack?: { kind: "rest" | "node"; target: string }
  /** Human-readable reason when act === false. */
  reason?: string
}

// ── Comment markers (frozen namespace, DESIGN §8) ────────────────────────────
export const MARKER = {
  sticky: (key: string) => `cchp-bot:${key}`,
  progress: (task: string) => `cchp-bot:progress:${task}`,
  plan: (id: string) => `cchp-bot:plan:${id}`,
  executed: (id: string) => `cchp-bot:executed:${id}`,
  action: (id: string) => `cchp-action:${id}`,
  fingerprint: (sha256: string) => `cchp-review-fingerprint:${sha256}`,
} as const

/** Wrap a marker key in an invisible HTML comment for embedding in a body. */
export const hidden = (markerKey: string): string => `<!-- ${markerKey} -->`

/** Find the first comment carrying a hidden marker key — the sticky upsert probe.
 *  Matches the marker prefix so `cchp-bot:progress:pr_opened` is found by the
 *  `cchp-bot:progress` key. */
export function findByMarker<T extends { body?: string | null }>(
  comments: readonly T[],
  markerKey: string,
): T | undefined {
  const needle = `<!-- ${markerKey}`
  return comments.find((c) => (c.body ?? "").includes(needle))
}

/** SHA-256 fingerprint of review content, for cross-run dedup of Findings. */
export function fingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

/** A PR is a Fork iff its head repo differs from the base repo. Fork = untrusted
 *  input; reviewed and possibly APPROVEd, but never auto-merged (ADR 0004). */
export function isForkPr(
  headRepoFullName: string | null | undefined,
  baseRepoFullName: string,
): boolean {
  return !headRepoFullName || headRepoFullName !== baseRepoFullName
}

// ── Action menu (security-relevant, ported from route.sh checked_ids) ─────────
const ACTION_CHECKED_RE = /\[[xX]\][^<]*<!--\s*cchp-action:([A-Za-z0-9._-]+)\s*-->/g

/** Action ids whose checkbox is currently checked in a menu body:
 *  `[x] ... <!-- cchp-action:ID -->`. Sorted + deduped. */
export function checkedActionIds(body: string): string[] {
  const ids = new Set<string>()
  for (const m of body.matchAll(ACTION_CHECKED_RE)) ids.add(m[1]!)
  return [...ids].sort()
}

/** Action ids newly checked in `next` vs `prev` — the menu-edit execution
 *  trigger. Only ids that flipped unchecked→checked count. */
export function newlyCheckedActionIds(prev: string, next: string): string[] {
  const before = new Set(checkedActionIds(prev))
  return checkedActionIds(next).filter((id) => !before.has(id))
}

// ── Review artifacts (schema_version: 1, frozen) ─────────────────────────────
export const ARTIFACT_SCHEMA_VERSION = 1
export const ARTIFACTS = {
  manifest: "manifest.json",
  coverage: "coverage.json",
  candidateLedger: "candidate-ledger.json",
  verificationLedger: "verification-ledger.json",
  finalReport: "final-report.md",
  finalized: "review-finalized.json",
} as const
