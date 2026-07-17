// Formal Pull Request Review verdict (ADR 0004). The agent chooses the verdict
// autonomously — COMMENT / REQUEST_CHANGES / APPROVE — including on fork PRs (fork
// protection is the merge gate, not the review). The one guard is an org-var
// kill-switch that downgrades an APPROVE to a COMMENT.
import { splitRepo } from "../context"
import type { GitHubClient } from "../github/client"
import type { Verdict } from "../types"

export interface ReviewComment {
  path: string
  line: number
  side?: "LEFT" | "RIGHT"
  start_line?: number
  start_side?: "LEFT" | "RIGHT"
  body: string
}

export interface SubmitReviewInput {
  event: Verdict
  body: string
  comments?: ReviewComment[]
  /** Org-var kill-switch: when true, an APPROVE is downgraded to COMMENT. */
  autoApproveDisabled?: boolean
}

export async function submitReview(
  octokit: GitHubClient,
  repo: string,
  prNumber: number,
  input: SubmitReviewInput,
): Promise<{ event: Verdict }> {
  let event = input.event
  let body = input.body
  if (event === "APPROVE" && input.autoApproveDisabled) {
    event = "COMMENT"
    body = `${body}\n\n_Auto-approve is disabled; posting as a comment instead of an approval._`
  }
  const { owner, name } = splitRepo(repo)
  await octokit.rest.pulls.createReview({
    owner, repo: name, pull_number: prNumber, event, body,
    ...(input.comments ? { comments: input.comments } : {}),
  })
  return { event }
}

/** The kill-switch, read from the org/repo variable `CCHP_DISABLE_AUTO_APPROVE`. */
export function autoApproveDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.CCHP_DISABLE_AUTO_APPROVE
  return v === "1" || v === "true"
}
