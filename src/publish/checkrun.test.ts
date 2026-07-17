import { expect, test } from "bun:test"
import type { GitHubClient } from "../github/client"
import { CHECK_ACTIONS, conclusionFor, createCheckRun, updateCheckRun } from "./checkrun"

function fakeOctokit(createId = 555) {
  const calls: any = { create: [], update: [] }
  const octokit = {
    rest: {
      checks: {
        create: async (p: any) => { calls.create.push(p); return { data: { id: createId } } },
        update: async (p: any) => { calls.update.push(p); return { data: {} } },
      },
    },
  } as unknown as GitHubClient
  return { octokit, calls }
}

test("createCheckRun opens a queued run with external_id and returns its id", async () => {
  const { octokit, calls } = fakeOctokit(777)
  const id = await createCheckRun(octokit, "CCH-HQ/repo", { name: "cchp review", headSha: "sha", externalId: "run-1" })
  expect(id).toBe(777)
  expect(calls.create[0]).toMatchObject({ owner: "CCH-HQ", repo: "repo", head_sha: "sha", status: "queued", external_id: "run-1" })
})

test("updateCheckRun completes with a conclusion + output", async () => {
  const { octokit, calls } = fakeOctokit()
  await updateCheckRun(octokit, "CCH-HQ/repo", 777, { status: "completed", conclusion: "failure", title: "Blocked", summary: "1 finding" })
  expect(calls.update[0]).toMatchObject({ check_run_id: 777, status: "completed", conclusion: "failure" })
  expect(calls.update[0].output).toEqual({ title: "Blocked", summary: "1 finding" })
})

test("actions are capped at GitHub's max of 3", async () => {
  const { octokit, calls } = fakeOctokit()
  const four = [CHECK_ACTIONS.applyFixes, CHECK_ACTIONS.deepReReview, CHECK_ACTIONS.dismiss, { label: "x", description: "x", identifier: "x" }]
  await updateCheckRun(octokit, "CCH-HQ/repo", 1, { status: "completed", conclusion: "neutral", title: "t", summary: "s", actions: four })
  expect(calls.update[0].actions).toHaveLength(3)
})

test("conclusion mapping (DESIGN §7)", () => {
  expect(conclusionFor("clean")).toBe("success")
  expect(conclusionFor("non_blocking")).toBe("neutral")
  expect(conclusionFor("blocking")).toBe("failure")
  expect(conclusionFor("needs_human")).toBe("action_required")
  expect(conclusionFor("cancelled")).toBe("cancelled")
})
