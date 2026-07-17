import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type MintDeps,
  mintInstallationToken,
  refreshLoop,
  scopePermissions,
  writeTokenFile,
} from "./gh-token-refresher"

test("scopePermissions mirrors run.yml's two mint steps exactly (never broadened)", () => {
  expect(scopePermissions("base")).toEqual({
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
    actions: "read",
    workflows: "write",
    organization_projects: "write",
  })
  // read/review(base)任务物理上推不了代码:无 contents:write、无 workflows
  expect(scopePermissions("base").contents).toBe("read")
  expect(scopePermissions("base")).not.toHaveProperty("workflows")
})

test("writeTokenFile writes atomically with 0600 perms and replaces cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "ghtok-"))
  const file = join(dir, ".gh-token")
  writeTokenFile(file, "ghs_first")
  expect(readFileSync(file, "utf8")).toBe("ghs_first")
  expect(statSync(file).mode & 0o777).toBe(0o600)
  writeTokenFile(file, "ghs_second")
  expect(readFileSync(file, "utf8")).toBe("ghs_second")
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(existsSync(`${file}.tmp`)).toBe(false) // tmp 必须 rename 走,不留半成品
})

test("mintInstallationToken resolves the installation then mints a repo-scoped token", async () => {
  const calls: Array<{ route: string; params: Record<string, unknown> }> = []
  const deps: MintDeps = {
    appJwt: async (clientId, privateKey) => {
      expect(clientId).toBe("Iv1.fakeclient")
      expect(privateKey).toBe("fake-pem")
      return "fake.jwt.value"
    },
    request: async (jwt, route, params) => {
      expect(jwt).toBe("fake.jwt.value")
      calls.push({ route, params })
      if (route.startsWith("GET ")) return { data: { id: 42 } }
      return { data: { token: "ghs_minted" } }
    },
  }
  const token = await mintInstallationToken(
    { clientId: "Iv1.fakeclient", privateKey: "fake-pem", repo: "own/name", scope: "write" },
    deps,
  )
  expect(token).toBe("ghs_minted")
  expect(calls[0]).toEqual({
    route: "GET /repos/{owner}/{repo}/installation",
    params: { owner: "own", repo: "name" },
  })
  expect(calls[1]).toEqual({
    route: "POST /app/installations/{installation_id}/access_tokens",
    params: { installation_id: 42, repositories: ["name"], permissions: scopePermissions("write") },
  })
})

test("mintInstallationToken rejects malformed BOT_REPO and empty token responses", async () => {
  const deps: MintDeps = {
    appJwt: async () => "j.w.t",
    request: async (_jwt, route) => (route.startsWith("GET ") ? { data: { id: 1 } } : { data: {} }),
  }
  await expect(
    mintInstallationToken({ clientId: "c", privateKey: "k", repo: "not-a-repo", scope: "base" }, deps),
  ).rejects.toThrow("owner/name")
  await expect(
    mintInstallationToken({ clientId: "c", privateKey: "k", repo: "a/b/c", scope: "base" }, deps),
  ).rejects.toThrow("owner/name")
  await expect(
    mintInstallationToken({ clientId: "c", privateKey: "k", repo: "own/name", scope: "base" }, deps),
  ).rejects.toThrow("no token")
})

test("refreshLoop survives mint failures (short retry) and keeps rotating", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ghtok-loop-"))
  const file = join(dir, ".gh-token")
  let n = 0
  const mint = async () => {
    n++
    if (n === 2) throw new Error("transient API error")
    return `tok${n}`
  }
  const slept: number[] = []
  await refreshLoop({
    mint,
    file,
    intervalMs: 1000,
    retryMs: 10,
    maxCycles: 3,
    sleep: async (ms) => {
      slept.push(ms)
    },
  })
  // 失败的那轮不写文件、不抛出;下一轮改用短重试间隔并成功续写
  expect(readFileSync(file, "utf8")).toBe("tok3")
  expect(slept).toEqual([1000, 1000, 10])
})
