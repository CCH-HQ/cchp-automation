import { expect, test } from "bun:test"
import type { GitHubClient } from "../github/client"
import { mergePr } from "./merge"

function fakeOctokit(headRepoFullName: string | null) {
  const calls: any[] = []
  const octokit = { rest: { pulls: {
    get: async () => ({ data: { head: { repo: headRepoFullName ? { full_name: headRepoFullName } : null } } }),
    merge: async (p: any) => { calls.push(p); return { data: {} } },
  } } } as unknown as GitHubClient
  return { octokit, calls }
}

test("fork PR is refused, merge API never called (ADR 0004)", async () => {
  const { octokit, calls } = fakeOctokit("attacker/repo")
  const r = await mergePr(octokit, "CCH-HQ/repo", 8)
  expect(r.merged).toBe(false)
  expect(r.reason).toContain("fork")
  expect(calls).toHaveLength(0)
})

test("null head repo is treated as a fork and refused", async () => {
  const { octokit, calls } = fakeOctokit(null)
  const r = await mergePr(octokit, "CCH-HQ/repo", 8)
  expect(r.merged).toBe(false)
  expect(calls).toHaveLength(0)
})

test("same-repo PR squash-merges", async () => {
  const { octokit, calls } = fakeOctokit("CCH-HQ/repo")
  const r = await mergePr(octokit, "CCH-HQ/repo", 8)
  expect(r.merged).toBe(true)
  expect(calls[0]).toMatchObject({ owner: "CCH-HQ", repo: "repo", pull_number: 8, merge_method: "squash" })
})
