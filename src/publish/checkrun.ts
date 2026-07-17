// Check Run — the machine-readable review-run status (DESIGN §7): queued →
// in_progress → completed, external_id = the internal run id, with action buttons
// and a conclusion that a branch-protection required check can read.
import { splitRepo } from "../context"
import type { GitHubClient } from "../github/client"

export type CheckStatus = "queued" | "in_progress" | "completed"
export type CheckConclusion = "success" | "neutral" | "failure" | "action_required" | "cancelled"
export interface CheckAction {
  label: string
  description: string
  identifier: string
}

/** The three review-run action buttons (max 3 per Check Run). */
export const CHECK_ACTIONS: Record<string, CheckAction> = {
  applyFixes: { label: "Apply fixes", description: "Apply the suggested fixes to the PR", identifier: "apply-fixes" },
  deepReReview: { label: "Deep re-review", description: "Run a fresh, deeper review", identifier: "deep-re-review" },
  dismiss: { label: "Dismiss findings", description: "Dismiss the current findings", identifier: "dismiss" },
}

export async function createCheckRun(
  octokit: GitHubClient,
  repo: string,
  opts: { name: string; headSha: string; externalId: string },
): Promise<number> {
  const { owner, name } = splitRepo(repo)
  const { data } = await octokit.rest.checks.create({
    owner, repo: name, name: opts.name, head_sha: opts.headSha, status: "queued", external_id: opts.externalId,
  })
  return data.id
}

export async function updateCheckRun(
  octokit: GitHubClient,
  repo: string,
  checkRunId: number,
  opts: { status: CheckStatus; conclusion?: CheckConclusion; title: string; summary: string; actions?: CheckAction[] },
): Promise<void> {
  const { owner, name } = splitRepo(repo)
  await octokit.rest.checks.update({
    owner, repo: name, check_run_id: checkRunId,
    status: opts.status,
    ...(opts.conclusion ? { conclusion: opts.conclusion } : {}),
    output: { title: opts.title, summary: opts.summary },
    ...(opts.actions ? { actions: opts.actions.slice(0, 3) } : {}), // GitHub caps at 3
  })
}

export type ReviewOutcome = "clean" | "non_blocking" | "blocking" | "needs_human" | "cancelled"

/** Map a review outcome → Check Run conclusion (DESIGN §7 mapping). */
export function conclusionFor(outcome: ReviewOutcome): CheckConclusion {
  switch (outcome) {
    case "clean": return "success"
    case "non_blocking": return "neutral"
    case "blocking": return "failure"
    case "needs_human": return "action_required"
    case "cancelled": return "cancelled"
  }
}
