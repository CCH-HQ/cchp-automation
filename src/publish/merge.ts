// PR merge — with the ADR 0004 fork gate. This is the security-critical publish
// op: a Fork PR is NEVER auto-merged. Defense-in-depth — routing already withholds
// the write token for fork LGTMs (base token = Contents:read = cannot merge); this
// refuses explicitly regardless of the token in hand.
import { splitRepo } from "../context"
import type { GitHubClient } from "../github/client"
import { isForkPr } from "../types"

export interface MergeResult {
  merged: boolean
  reason?: string
}

export async function mergePr(
  octokit: GitHubClient,
  repo: string,
  prNumber: number,
  opts: { headRepoFullName: string | null; method?: "squash" | "merge" | "rebase" },
): Promise<MergeResult> {
  if (isForkPr(opts.headRepoFullName, repo)) {
    return { merged: false, reason: "fork PRs are never auto-merged (ADR 0004); a maintainer merges manually" }
  }
  const { owner, name } = splitRepo(repo)
  await octokit.rest.pulls.merge({ owner, repo: name, pull_number: prNumber, merge_method: opts.method ?? "squash" })
  return { merged: true }
}
