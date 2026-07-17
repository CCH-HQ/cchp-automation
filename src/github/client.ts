// The single Octokit client factory. Every engine GitHub call goes through this —
// never `gh`/`curl`/hand GraphQL (ADR 0003). It carries throttling + retry
// (primary + secondary/abuse rate-limit backoff) and pins the REST API version on
// every request (ADR 0006).
import { readFileSync } from "node:fs"
import { Octokit } from "octokit"
import { retry } from "@octokit/plugin-retry"
import { throttling } from "@octokit/plugin-throttling"

// TODO(cchp: verify current version online, then bump via the migration-PR path —
// DESIGN §13.1 / decision point 57): pin the last-known-safe supported version so
// the engine works today. This must NOT drift automatically with the SDK.
export const GITHUB_API_VERSION = "2022-11-28"

const EngineOctokit = Octokit.plugin(throttling, retry)
export type GitHubClient = InstanceType<typeof EngineOctokit>

/** A token source: a static installation token, or a getter re-read on every
 *  request. The getter form backs the token-rotation sidecar (run.sh /
 *  gh-token-refresher.ts): installation tokens hard-expire after 1h, so >1h
 *  sessions must resolve the CURRENT token per request, never cache one. */
export type TokenSource = string | (() => string)

/** Per-request token getter backed by the sidecar-rotated token file; falls back
 *  to the static env token when the file is missing/empty (best-effort posture). */
export function fileTokenGetter(file: string, fallback?: string): () => string {
  return () => {
    try {
      const t = readFileSync(file, "utf8").trim()
      if (t) return t
    } catch {
      /* 文件缺失/不可读 → 走静态回退 */
    }
    if (fallback) return fallback
    throw new Error(`token file unreadable and no GH_TOKEN fallback: ${file}`)
  }
}

// 与 @octokit/auth-token 的 hook 同构,但每个请求现取 token —— 轮换后的新 token
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
