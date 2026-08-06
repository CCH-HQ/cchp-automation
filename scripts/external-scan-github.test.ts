import { expect, test } from "bun:test"
import type { GitHubClient } from "../src/github/client"
import { listChangedFiles } from "./external-scan-github"

test("lists every changed PR file through the engine Octokit client", async () => {
  const listFiles = async () => ({ data: [] })
  const calls: Record<string, unknown>[] = []
  const octokit = {
    rest: { pulls: { listFiles } },
    paginate: async (operation: unknown, args: Record<string, unknown>) => {
      expect(operation).toBe(listFiles)
      calls.push(args)
      return [
        { filename: "web/src/b.ts" },
        { filename: "pkg/a.go" },
        { filename: "web/src/b.ts" },
        { filename: "" },
      ]
    },
  } as unknown as GitHubClient

  await expect(listChangedFiles(octokit, "example/repo", 7)).resolves.toEqual([
    "pkg/a.go",
    "web/src/b.ts",
  ])
  expect(calls).toEqual([{
    owner: "example",
    repo: "repo",
    pull_number: 7,
    per_page: 100,
  }])
})

test("rejects an invalid repository or PR number before any request", async () => {
  const octokit = {
    rest: { pulls: { listFiles: async () => ({ data: [] }) } },
    paginate: async () => { throw new Error("must not request") },
  } as unknown as GitHubClient
  await expect(listChangedFiles(octokit, "example/repo", 0)).rejects.toThrow("positive integer")
  await expect(listChangedFiles(octokit, "not-a-repository", 7)).rejects.toThrow("owner/name")
})
