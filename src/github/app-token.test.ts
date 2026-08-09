import { expect, test } from "bun:test"
import { mintInstallationToken, scopePermissions, type MintDeps } from "./app-token"

test("scopePermissions mirrors the reusable workflow mint blocks", () => {
  expect(scopePermissions("base")).toEqual({
    contents: "read",
    metadata: "read",
    issues: "read",
    pull_requests: "read",
    discussions: "read",
    actions: "read",
    organization_projects: "read",
  })
  expect(scopePermissions("interaction")).toEqual({
    contents: "read",
    metadata: "read",
    issues: "write",
    pull_requests: "write",
    discussions: "write",
    actions: "read",
    organization_projects: "write",
  })
  expect(scopePermissions("write")).toEqual({
    contents: "write",
    metadata: "read",
    issues: "write",
    pull_requests: "write",
    discussions: "write",
    actions: "write",
    checks: "write",
    workflows: "write",
    organization_projects: "write",
  })
})

test("mintInstallationToken binds the target repository and requested scope", async () => {
  const calls: Array<{ route: string; params: Record<string, unknown> }> = []
  const deps: MintDeps = {
    appJwt: async (clientId, privateKey) => {
      expect(clientId).toBe("Iv1.client")
      expect(privateKey).toBe("fixture-key")
      return "fixture.jwt"
    },
    request: async (jwt, route, params) => {
      expect(jwt).toBe("fixture.jwt")
      calls.push({ route, params })
      return route.startsWith("GET ") ? { data: { id: 42 } } : { data: { token: "ghs_minted" } }
    },
  }

  await expect(mintInstallationToken({
    clientId: "Iv1.client",
    privateKey: "fixture-key",
    repo: "CCH-HQ/fixture",
    scope: "write",
  }, deps)).resolves.toBe("ghs_minted")
  expect(calls).toEqual([
    {
      route: "GET /repos/{owner}/{repo}/installation",
      params: { owner: "CCH-HQ", repo: "fixture" },
    },
    {
      route: "POST /app/installations/{installation_id}/access_tokens",
      params: {
        installation_id: 42,
        repositories: ["fixture"],
        permissions: scopePermissions("write"),
      },
    },
  ])
})

test("mintInstallationToken rejects malformed repositories and empty tokens", async () => {
  const deps: MintDeps = {
    appJwt: async () => "fixture.jwt",
    request: async (_jwt, route) => route.startsWith("GET ") ? { data: { id: 1 } } : { data: {} },
  }
  await expect(mintInstallationToken({
    clientId: "client",
    privateKey: "key",
    repo: "invalid",
    scope: "base",
  }, deps)).rejects.toThrow("owner/name")
  await expect(mintInstallationToken({
    clientId: "client",
    privateKey: "key",
    repo: "CCH-HQ/fixture",
    scope: "base",
  }, deps)).rejects.toThrow("no token")
})
