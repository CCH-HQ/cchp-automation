#!/usr/bin/env bun
import { splitRepo } from "../src/context"
import { makeOctokit, type GitHubClient } from "../src/github/client"

export async function listChangedFiles(
  octokit: GitHubClient,
  repository: string,
  prNumber: number,
): Promise<string[]> {
  if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error("BOT_PR_NUMBER must be a positive integer")
  const { owner, name } = splitRepo(repository)
  if (!owner || !name || name.includes("/")) throw new Error("BOT_REPO must be owner/name")
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo: name,
    pull_number: prNumber,
    per_page: 100,
  })
  return [...new Set(files
    .map((file) => file.filename)
    .filter((filename): filename is string => typeof filename === "string" && filename.length > 0))]
    .sort((left, right) => left.localeCompare(right))
}

async function main(): Promise<void> {
  if (process.argv[2] !== "changed-files") throw new Error("usage: external-scan-github.ts changed-files")
  const token = process.env.GH_TOKEN
  const repository = process.env.BOT_REPO
  const prNumber = Number(process.env.BOT_PR_NUMBER)
  if (!token || !repository) throw new Error("GH_TOKEN and BOT_REPO are required")
  const files = await listChangedFiles(makeOctokit(token), repository, prNumber)
  if (files.length) process.stdout.write(`${files.join("\n")}\n`)
}

if (import.meta.main) main().catch((error) => {
  process.stderr.write(`[external-scan-github] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
