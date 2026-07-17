// The single Octokit client factory. Every engine GitHub call goes through this —
// never `gh`/`curl`/hand GraphQL (ADR 0003). It carries throttling + retry
// (primary + secondary/abuse rate-limit backoff) and pins the REST API version on
// every request (ADR 0006).
import { Octokit } from "octokit"
import { retry } from "@octokit/plugin-retry"
import { throttling } from "@octokit/plugin-throttling"

// TODO(cchp: verify current version online, then bump via the migration-PR path —
// DESIGN §13.1 / decision point 57): pin the last-known-safe supported version so
// the engine works today. This must NOT drift automatically with the SDK.
export const GITHUB_API_VERSION = "2022-11-28"

const EngineOctokit = Octokit.plugin(throttling, retry)
export type GitHubClient = InstanceType<typeof EngineOctokit>

/** Build the throttled, retrying, version-pinned client for an installation token. */
export function makeOctokit(token: string): GitHubClient {
  const octokit = new EngineOctokit({
    auth: token,
    throttle: {
      // Primary rate limit: back off and retry a bounded number of times.
      onRateLimit: (_retryAfter: number, _options: unknown, _octokit: unknown, retryCount: number) =>
        retryCount < 3,
      // Secondary/abuse limit (e.g. rapid review-comment creation): retry once.
      onSecondaryRateLimit: (_retryAfter: number, _options: unknown, _octokit: unknown, retryCount: number) =>
        retryCount < 1,
    },
  })
  octokit.hook.before("request", (options) => {
    options.headers["x-github-api-version"] = GITHUB_API_VERSION
  })
  return octokit
}
