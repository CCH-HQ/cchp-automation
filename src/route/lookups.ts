// The Octokit-backed Lookups the classifier injects — the only I/O routing does.
// canWrite is the security gate (ported from route.sh can_write): a human may
// have code executed on their behalf ONLY if they are a repo collaborator with
// push/admin OR an org member. Fail-closed on any error (returns false).
import type { GitHubClient } from "../github/client"
import type { Lookups, PendingRocket, PrInfo } from "./classify"

function splitRepo(repo: string): [string, string] {
  const i = repo.indexOf("/")
  return [repo.slice(0, i), repo.slice(i + 1)]
}

const PLAN_MARKER = "<!-- cchp-bot:plan:"
const EXECUTED_MARKER = "<!-- cchp-bot:executed"

export function makeLookups(octokit: GitHubClient, repo: string): Lookups {
  const [owner, name] = splitRepo(repo)

  const canWrite = async (actor: string): Promise<boolean> => {
    if (!actor) return false
    try {
      const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo: name, username: actor })
      if (data.user?.permissions?.push || data.user?.permissions?.admin) return true
    } catch {
      // Not a collaborator (404) or lookup failed — fall through to org check.
    }
    try {
      // 204 = member; 302/404 throw → not a verifiable member → fail-closed.
      await octokit.rest.orgs.checkMembershipForUser({ org: owner, username: actor })
      return true
    } catch {
      return false
    }
  }

  return {
    canWrite,

    async prInfo(num: number): Promise<PrInfo> {
      const { data } = await octokit.rest.pulls.get({ owner, repo: name, pull_number: num })
      return {
        base: data.base.ref,
        head: data.head.ref,
        sha: data.head.sha,
        headRepoFullName: data.head.repo?.full_name ?? null,
      }
    },

    async prForSha(sha: string): Promise<number | null> {
      const { data } = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({ owner, repo: name, commit_sha: sha })
      return data[0]?.number ?? null
    },

    // Scheduled 🚀 poll: GitHub has no reaction webhook, so every 10 min we scan
    // the bot's own plan comments for a rocket from a write-capable user.
    async findPendingRocketExecution(botUser: string): Promise<PendingRocket | null> {
      const search = await octokit.rest.search.issuesAndPullRequests({
        q: `repo:${repo} commenter:${botUser} state:open`,
        sort: "updated",
        order: "desc",
        per_page: 30,
      })
      for (const issue of search.data.items) {
        const comments = await octokit.paginate(octokit.rest.issues.listComments, {
          owner, repo: name, issue_number: issue.number, per_page: 100,
        })
        for (const c of comments) {
          const body = c.body ?? ""
          if (c.user?.login !== botUser || !body.includes(PLAN_MARKER)) continue
          if (body.includes(EXECUTED_MARKER)) continue // already executed
          const reactions = await octokit.paginate(octokit.rest.reactions.listForIssueComment, {
            owner, repo: name, comment_id: c.id, per_page: 100,
          })
          for (const r of reactions) {
            const reactor = r.user?.login
            if (r.content === "rocket" && reactor && (await canWrite(reactor))) {
              return { issueNumber: issue.number, commentId: c.id, reactor }
            }
          }
        }
      }
      return null
    },
  }
}
