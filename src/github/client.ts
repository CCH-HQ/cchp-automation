// The single Octokit client factory. Every engine GitHub call goes through this —
// never `gh`/`curl`/hand GraphQL (ADR 0003). It carries throttling + retry
// (primary + secondary/abuse rate-limit backoff) and pins the REST API version on
// every request (ADR 0006).
import { Octokit } from "octokit"
import { retry } from "@octokit/plugin-retry"
import { throttling } from "@octokit/plugin-throttling"

// GitHub's current versioned REST API remains 2022-11-28. Pin it explicitly so
// requests never drift with the SDK; the contract test makes any bump deliberate.
export const GITHUB_API_VERSION = "2022-11-28"

const EngineOctokit = Octokit.plugin(throttling, retry)
export type GitHubClient = InstanceType<typeof EngineOctokit>

/** A token source: a static installation token, or the in-memory rotation
 * handle read on every request. Installation tokens hard-expire after 1h, so
 * long sessions must resolve the current token per request, never cache one. */
export type TokenSource = string | (() => string)

// 与 @octokit/auth-token 的 hook 同构,但每个请求现取 token。轮换后的新 token
// 立刻生效,绝不因 1h 过期变 stale。安装 token 无 "." 段,恒用 `token ` 前缀。
function createRotatingTokenAuth(options: { getToken: () => string }) {
  const auth = async () => ({ type: "token" as const, token: options.getToken(), tokenType: "installation" as const })
  auth.hook = (request: any, route: any, parameters?: any) => {
    const endpoint = request.endpoint.merge(route, parameters)
    endpoint.headers.authorization = `token ${options.getToken()}`
    return request(endpoint)
  }
  return auth
}

/** Build the throttled, retrying, version-pinned client for an installation token
 *  (static string) or a rotating token getter (re-read per request). */
export function makeOctokit(token: TokenSource): GitHubClient {
  const authOptions =
    typeof token === "function"
      ? { authStrategy: createRotatingTokenAuth, auth: { getToken: token } }
      : { auth: token }
  const octokit = new EngineOctokit({
    ...authOptions,
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
