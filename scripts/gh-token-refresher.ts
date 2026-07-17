#!/usr/bin/env bun
// cchp-automation engine — GitHub App installation-token sidecar refresher.
//
// Installation tokens hard-expire after 1h (GitHub limit; cannot be extended).
// Long agent runs (3h+ observed) outlive them, after which every gh/Octokit/
// git-push call fails with 401. This sidecar is started by run.sh BEFORE
// opencode launches: it holds the App credentials in ITS process env only,
// re-mints a fresh installation token on a fixed cadence, and atomically writes
// it to the token file that the gh wrapper / git credential helper / MCP server
// read per call.
//
// 安全边界(run.sh 的硬不变量):App 私钥只存在于本进程 env —— run.sh 启动本
// sidecar 后立刻 unset 自己 env 里的凭据,opencode/模型永远拿不到私钥;它们能
// 看到的只有短命 token 文件(与今天静态 GH_TOKEN 同等敏感度)。
//
// Env inputs (all read once at startup):
//   CCHP_APP_CLIENT_ID          GitHub App client id (same input run.yml gives
//                               actions/create-github-app-token@v3)
//   CCHP_APP_PRIVATE_KEY        GitHub App private key (PEM)
//   BOT_REPO                    owner/name the run targets (token is repo-scoped)
//   CCHP_GH_TOKEN_FILE          token file path (outside the clone)
//   CCHP_TOKEN_SCOPE            "write" | "base" (default base) — mirrors
//                               run.yml's steps.write/steps.base mint choice
//   CCHP_TOKEN_REFRESH_SECONDS  refresh cadence (default 2700 = 45min)
//
// Logs to stderr only; never prints the token or the key.
import { chmodSync, renameSync, writeFileSync } from "node:fs"
import { App, Octokit } from "octokit"

// run.yml 两档 mint(base ~L66 / write ~L142)的 1:1 镜像 —— 绝不放宽:
// base = read + issues/PR/discussions/roadmap(无 contents:write,物理上推不了代码);
// write = base + contents/workflows write。fork/review 任务只会拿到 base。
const PERMISSIONS = {
  base: {
    contents: "read",
    metadata: "read",
    issues: "write",
    pull_requests: "write",
    discussions: "write",
    actions: "read",
    organization_projects: "write",
  },
  write: {
    contents: "write",
    metadata: "read",
    issues: "write",
    pull_requests: "write",
    discussions: "write",
    actions: "read",
    workflows: "write",
    organization_projects: "write",
  },
} as const

export type TokenScope = keyof typeof PERMISSIONS

/** The exact permission set run.yml's matching mint step grants today. */
export function scopePermissions(scope: TokenScope): (typeof PERMISSIONS)[TokenScope] {
  return PERMISSIONS[scope]
}

/** Atomic token-file write: tmp + rename so readers never see a partial token;
 *  0600 throughout (owner-only, same posture as the runner's env secrets). */
export function writeTokenFile(path: string, token: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, token, { mode: 0o600 })
  chmodSync(tmp, 0o600) // writeFileSync 的 mode 只在新建时生效;覆盖旧 tmp 也要归 0600
  renameSync(tmp, path) // 同目录 rename 原子替换
}

export interface MintConfig {
  clientId: string
  privateKey: string
  /** owner/name (BOT_REPO) — the minted token is scoped to this repo only. */
  repo: string
  scope: TokenScope
}

/** Injection seam:测试给假 JWT + 假 request;生产走 octokit 的 App + Octokit。 */
export interface MintDeps {
  appJwt: (clientId: string, privateKey: string) => Promise<string>
  request: (jwt: string, route: string, params: Record<string, unknown>) => Promise<{ data: any }>
}

const realMintDeps: MintDeps = {
  // App({appId: <client-id>, privateKey}) — auth-app 8.x 的 appId 接受 client id
  // 字符串(JWT 的 iss 直接用它,与 actions/create-github-app-token 的 client-id
  // 输入同构)。auth({type:"app"}) 直接返回签好的 JWT,不发任何请求。
  appJwt: async (clientId, privateKey) => {
    const app = new App({ appId: clientId, privateKey })
    const auth = (await app.octokit.auth({ type: "app" })) as { token: string }
    return auth.token
  },
  // JWT 走 createTokenAuth(三段式 token 自动用 bearer 前缀),避免 auth-app 的
  // hook 对非 /app 路由强行做 installation 认证。
  request: async (jwt, route, params) => new Octokit({ auth: jwt }).request(route as never, params as never),
}

/** Resolve the installation for the target repo, then mint a repo-scoped
 *  installation token with exactly the run's permission set. */
export async function mintInstallationToken(cfg: MintConfig, deps: MintDeps = realMintDeps): Promise<string> {
  const [owner, name, ...rest] = cfg.repo.split("/")
  if (!owner || !name || rest.length > 0) throw new Error(`BOT_REPO must be owner/name (got "${cfg.repo}")`)
  const jwt = await deps.appJwt(cfg.clientId, cfg.privateKey)
  const inst = await deps.request(jwt, "GET /repos/{owner}/{repo}/installation", { owner, repo: name })
  const created = await deps.request(jwt, "POST /app/installations/{installation_id}/access_tokens", {
    installation_id: inst.data.id,
    repositories: [name],
    permissions: scopePermissions(cfg.scope),
  })
  if (typeof created.data?.token !== "string" || created.data.token.length === 0) {
    throw new Error("access_tokens response carried no token")
  }
  return created.data.token
}

export interface LoopOpts {
  mint: () => Promise<string>
  file: string
  intervalMs: number
  /** shorter retry cadence after a failed mint (default 60s) */
  retryMs?: number
  sleep?: (ms: number) => Promise<void>
  /** test seam; production runs unbounded */
  maxCycles?: number
  log?: (msg: string) => void
}

/** The rotation loop: sleep, re-mint, atomically re-write. Mint failures only
 *  shorten the next sleep — the previous token stays valid until its own 1h
 *  expiry, so a transient API error must never crash the sidecar. */
export async function refreshLoop(o: LoopOpts): Promise<void> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const log = o.log ?? (() => {})
  let ok = true
  for (let cycle = 0; cycle < (o.maxCycles ?? Number.POSITIVE_INFINITY); cycle++) {
    await sleep(ok ? o.intervalMs : (o.retryMs ?? 60_000))
    try {
      writeTokenFile(o.file, await o.mint())
      ok = true
      log("token refreshed")
    } catch (e) {
      ok = false
      log(`warn: refresh failed (${(e as Error).message}); previous token stays valid until its 1h expiry — retrying`)
    }
  }
}

// /proc/<pid>/environ 对同 UID 进程可读 —— 置 PR_SET_DUMPABLE=0 后内核要求
// ptrace 权限,同 UID 非特权进程即读不到本进程的 environ/mem(私钥所在)。
// ponytail: same-UID isolation ceiling — 无特权分离时这是唯一可加的内核级屏障,
// FFI 不可用(如 musl)就退回"key 只在本进程 env"这一层,只警告不失败。
function hideProcEnviron(log: (msg: string) => void): void {
  try {
    // eslint-style dynamic require keeps bun:ffi out of the test import graph
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi")
    const libc = dlopen("libc.so.6", {
      prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    })
    libc.symbols.prctl(4 /* PR_SET_DUMPABLE */, 0, 0, 0, 0)
  } catch {
    log("warn: PR_SET_DUMPABLE hardening unavailable (continuing)")
  }
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const log = (msg: string) => process.stderr.write(`[gh-token-refresher] ${msg}\n`)
  const clientId = env.CCHP_APP_CLIENT_ID
  const privateKey = env.CCHP_APP_PRIVATE_KEY
  const repo = env.BOT_REPO
  const file = env.CCHP_GH_TOKEN_FILE
  if (!clientId || !privateKey || !repo || !file) {
    throw new Error("CCHP_APP_CLIENT_ID, CCHP_APP_PRIVATE_KEY, BOT_REPO and CCHP_GH_TOKEN_FILE are required")
  }
  const scope: TokenScope = env.CCHP_TOKEN_SCOPE === "write" ? "write" : "base"
  const intervalMs = Math.max(60, Number(env.CCHP_TOKEN_REFRESH_SECONDS ?? "") || 2700) * 1000
  // 凭据已捕获:从自身 process.env 摘除(防意外进入任何子进程;/proc 视图见下)。
  delete env.CCHP_APP_PRIVATE_KEY
  delete env.CCHP_APP_CLIENT_ID
  hideProcEnviron(log)
  const mint = () => mintInstallationToken({ clientId, privateKey, repo, scope })
  // 首个 token 必须在进循环前写出(run.sh 有界等待它出现才继续;等不到就回退
  // 静态 GH_TOKEN)。短重试后仍失败则退出 1 —— 失败要快,别吃掉 run.sh 的等待窗。
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  let minted = false
  for (let attempt = 1; attempt <= 3 && !minted; attempt++) {
    try {
      writeTokenFile(file, await mint())
      minted = true
    } catch (e) {
      log(`warn: initial mint attempt ${attempt}/3 failed: ${(e as Error).message}`)
      if (attempt < 3) await sleep(2000)
    }
  }
  if (!minted) throw new Error("could not mint the initial installation token")
  log(`initial token written (scope=${scope}, repo=${repo}); refreshing every ${intervalMs / 1000}s`)
  await refreshLoop({ mint, file, intervalMs, log })
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    process.stderr.write(`[gh-token-refresher] fatal: ${(err as Error)?.message ?? String(err)}\n`)
    process.exit(1)
  })
}
