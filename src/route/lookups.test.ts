import { expect, test } from "bun:test"
import type { GitHubClient } from "../github/client"
import { makeLookups } from "./lookups"

// Minimal fake exercising only what canWrite touches — the security gate.
function fakeOctokit(opts: { perm?: { push?: boolean; admin?: boolean } | "throw"; member?: boolean }): GitHubClient {
  return {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => {
          if (opts.perm === "throw") throw new Error("404 not a collaborator")
          return { data: { user: { permissions: opts.perm ?? {} } } }
        },
      },
      orgs: {
        checkMembershipForUser: async () => {
          if (opts.member) return { status: 204 }
          throw new Error("404 not a member")
        },
      },
    },
  } as unknown as GitHubClient
}

const cw = (o: GitHubClient) => makeLookups(o, "CCH-HQ/repo").canWrite("alice")

test("collaborator with push → write", async () => {
  expect(await cw(fakeOctokit({ perm: { push: true } }))).toBe(true)
})

test("collaborator with admin → write", async () => {
  expect(await cw(fakeOctokit({ perm: { admin: true } }))).toBe(true)
})

test("read-only collaborator but org member → write", async () => {
  expect(await cw(fakeOctokit({ perm: { push: false }, member: true }))).toBe(true)
})

test("read-only collaborator, not a member → no write", async () => {
  expect(await cw(fakeOctokit({ perm: { push: false }, member: false }))).toBe(false)
})

test("not a collaborator (404) but org member → write", async () => {
  expect(await cw(fakeOctokit({ perm: "throw", member: true }))).toBe(true)
})

test("not a collaborator and not a member → fail-closed to no write", async () => {
  expect(await cw(fakeOctokit({ perm: "throw", member: false }))).toBe(false)
})

test("empty actor → no write, no calls", async () => {
  const octokit = { rest: {} } as unknown as GitHubClient
  expect(await makeLookups(octokit, "CCH-HQ/repo").canWrite("")).toBe(false)
})
