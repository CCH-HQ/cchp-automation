import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileTokenGetter, GITHUB_API_VERSION, makeOctokit } from "./client"

test("api version is pinned (not drifting with the SDK)", () => {
  expect(GITHUB_API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/)
})

test("client constructs with an installation token and exposes REST + graphql", () => {
  const octokit = makeOctokit("ghs_faketoken_for_construction_only")
  expect(typeof octokit.rest.pulls.get).toBe("function")
  expect(typeof octokit.rest.issues.createComment).toBe("function")
  expect(typeof octokit.graphql).toBe("function")
  expect(typeof octokit.paginate).toBe("function")
})

test("every request carries the pinned api version header", async () => {
  let captured: Headers | undefined
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    captured = new Headers(init?.headers as HeadersInit)
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  }
  const octokit = makeOctokit("ghs_faketoken")
  await octokit.rest.meta.get({ request: { fetch: fakeFetch } })
  expect(captured?.get("x-github-api-version")).toBe(GITHUB_API_VERSION)
})

test("a token getter is re-read on every request (rotation-safe) and keeps the pinned version", async () => {
  let current = "ghs_first"
  const auth: string[] = []
  const versions: string[] = []
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers as HeadersInit)
    auth.push(h.get("authorization") ?? "")
    versions.push(h.get("x-github-api-version") ?? "")
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  }
  const octokit = makeOctokit(() => current)
  await octokit.rest.meta.get({ request: { fetch: fakeFetch } })
  current = "ghs_second" // sidecar 轮换后:同一个 client 的下一个请求必须带新 token
  await octokit.rest.meta.get({ request: { fetch: fakeFetch } })
  expect(auth).toEqual(["token ghs_first", "token ghs_second"])
  expect(versions).toEqual([GITHUB_API_VERSION, GITHUB_API_VERSION])
})

test("a static token still authenticates every request (fallback path unchanged)", async () => {
  const auth: string[] = []
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    auth.push(new Headers(init?.headers as HeadersInit).get("authorization") ?? "")
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  }
  const octokit = makeOctokit("ghs_statictoken")
  await octokit.rest.meta.get({ request: { fetch: fakeFetch } })
  expect(auth).toEqual(["token ghs_statictoken"])
})

test("fileTokenGetter prefers the token file and falls back to the static token", () => {
  const dir = mkdtempSync(join(tmpdir(), "cchp-tokfile-"))
  const file = join(dir, ".gh-token")
  const get = fileTokenGetter(file, "ghs_env_fallback")
  expect(get()).toBe("ghs_env_fallback") // 文件还没出现 → 静态回退
  writeFileSync(file, "ghs_from_file\n")
  expect(get()).toBe("ghs_from_file") // 现读 + trim
  writeFileSync(file, "")
  expect(get()).toBe("ghs_env_fallback") // 空文件 → 静态回退
  const strict = fileTokenGetter(join(dir, "missing"))
  expect(() => strict()).toThrow("token file unreadable")
})
