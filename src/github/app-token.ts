import { App, Octokit } from "octokit"

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
    actions: "write",
    checks: "write",
    workflows: "write",
    organization_projects: "write",
  },
} as const

export type TokenScope = keyof typeof PERMISSIONS

export function scopePermissions(scope: TokenScope): (typeof PERMISSIONS)[TokenScope] {
  return PERMISSIONS[scope]
}

export interface MintConfig {
  clientId: string
  privateKey: string
  repo: string
  scope: TokenScope
}

export interface MintDeps {
  appJwt: (clientId: string, privateKey: string) => Promise<string>
  request: (jwt: string, route: string, params: Record<string, unknown>) => Promise<{ data: any }>
}

const realMintDeps: MintDeps = {
  appJwt: async (clientId, privateKey) => {
    const app = new App({ appId: clientId, privateKey })
    const auth = (await app.octokit.auth({ type: "app" })) as { token: string }
    return auth.token
  },
  request: async (jwt, route, params) => new Octokit({ auth: jwt }).request(route as never, params as never),
}

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
