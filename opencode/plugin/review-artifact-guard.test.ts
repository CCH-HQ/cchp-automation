import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ReviewArtifactGuard } from "./review-artifact-guard"

const originalTask = process.env.BOT_TASK
const originalWorkdir = process.env.BOT_WORKDIR

afterEach(() => {
  if (originalTask === undefined) delete process.env.BOT_TASK
  else process.env.BOT_TASK = originalTask
  if (originalWorkdir === undefined) delete process.env.BOT_WORKDIR
  else process.env.BOT_WORKDIR = originalWorkdir
})

async function hookFor(workdir: string) {
  process.env.BOT_TASK = "pr_opened"
  process.env.BOT_WORKDIR = workdir
  const plugin = await ReviewArtifactGuard() as any
  return plugin["tool.execute.before"]
}

describe("ReviewArtifactGuard", () => {
  test("allows review artifacts and the fixed top-level reply", async () => {
    const root = mkdtempSync(join(tmpdir(), "review-guard-"))
    mkdirSync(join(root, "ctx/review"), { recursive: true })
    const hook = await hookFor(root)
    await hook({ tool: "write" }, { args: { filePath: join(root, "ctx/review/coverage.json") } })
    await hook({ tool: "write" }, { args: { filePath: join(root, "ctx/reply.md") } })
  })

  test("denies traversal and symlink escapes", async () => {
    const root = mkdtempSync(join(tmpdir(), "review-guard-"))
    mkdirSync(join(root, "ctx/review"), { recursive: true })
    symlinkSync(join(root, "ctx"), join(root, "ctx/review/link"))
    const hook = await hookFor(root)
    await expect(hook({ tool: "write" }, { args: { filePath: join(root, "ctx/review/../review-manifest.json") } })).rejects.toThrow("write denied")
    await expect(hook({ tool: "write" }, { args: { filePath: join(root, "ctx/review/link/escape.json") } })).rejects.toThrow("write denied")
  })
})
