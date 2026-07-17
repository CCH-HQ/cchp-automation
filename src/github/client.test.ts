import { expect, test } from "bun:test"
import { GITHUB_API_VERSION, makeOctokit } from "./client"

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
