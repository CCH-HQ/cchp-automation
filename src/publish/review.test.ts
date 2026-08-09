import { expect, test } from "bun:test"
import type { GitHubClient } from "../github/client"
import { autoApproveDisabled, submitReview } from "./review"

function fakeOctokit() {
  const calls: any[] = []
  const octokit = { rest: { pulls: { createReview: async (p: any) => {
    calls.push(p)
    return { data: { id: 80, commit_id: p.commit_id, state: p.event === "APPROVE" ? "APPROVED" : p.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED", html_url: "https://gh/review/80" } }
  } } } } as unknown as GitHubClient
  return { octokit, calls }
}

const HEAD_SHA = "a".repeat(40)

test("COMMENT verdict is submitted as-is", async () => {
  const { octokit, calls } = fakeOctokit()
  const r = await submitReview(octokit, "CCH-HQ/repo", 8, { event: "COMMENT", body: "notes", headSha: HEAD_SHA })
  expect(r.event).toBe("COMMENT")
  expect(calls[0]).toMatchObject({ owner: "CCH-HQ", repo: "repo", pull_number: 8, event: "COMMENT", commit_id: HEAD_SHA })
})

test("REQUEST_CHANGES verdict is submitted as-is", async () => {
  const { octokit, calls } = fakeOctokit()
  const r = await submitReview(octokit, "CCH-HQ/repo", 8, { event: "REQUEST_CHANGES", body: "blocking", headSha: HEAD_SHA })
  expect(r.event).toBe("REQUEST_CHANGES")
  expect(calls[0].event).toBe("REQUEST_CHANGES")
})

test("APPROVE goes through when the kill-switch is off", async () => {
  const { octokit, calls } = fakeOctokit()
  const r = await submitReview(octokit, "CCH-HQ/repo", 8, { event: "APPROVE", body: "lgtm", headSha: HEAD_SHA })
  expect(r.event).toBe("APPROVE")
  expect(calls[0].event).toBe("APPROVE")
})

test("APPROVE is downgraded to COMMENT when the kill-switch is on", async () => {
  const { octokit, calls } = fakeOctokit()
  const r = await submitReview(octokit, "CCH-HQ/repo", 8, { event: "APPROVE", body: "lgtm", headSha: HEAD_SHA, autoApproveDisabled: true })
  expect(r.event).toBe("COMMENT")
  expect(calls[0].event).toBe("COMMENT")
  expect(calls[0].body).toContain("Auto-approve is disabled")
})

test("kill-switch env parsing", () => {
  expect(autoApproveDisabled({ CCHP_DISABLE_AUTO_APPROVE: "1" })).toBe(true)
  expect(autoApproveDisabled({ CCHP_DISABLE_AUTO_APPROVE: "true" })).toBe(true)
  expect(autoApproveDisabled({})).toBe(false)
  expect(autoApproveDisabled({ CCHP_DISABLE_AUTO_APPROVE: "0" })).toBe(false)
})
