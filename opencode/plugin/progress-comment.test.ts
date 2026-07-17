import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ProgressComment } from "./progress-comment"

function fakeGh(root: string, existing: Array<{ id: number; body: string }> = []) {
  const bin = join(root, "bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(root, "comments.json"), JSON.stringify(existing))
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${join(root, "gh.log")}"
if [[ " $* " == *" --slurp "* && " $* " == *" --jq "* ]]; then
  printf 'the --slurp option is not supported with --jq\\n' >&2; exit 1
fi
if [[ " $* " == *" --method PATCH "* ]]; then printf '42\\n';
elif [[ " $* " == *" --method POST "* ]]; then printf '42\\n';
else printf '['; cat "${join(root, "comments.json")}"; printf ']'; fi
`,
  )
  chmodSync(join(bin, "gh"), 0o755)
  process.env.PATH = `${bin}:${process.env.PATH}`
  return () => readFileSync(join(root, "gh.log"), "utf8")
}

async function hooksWith(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await ProgressComment()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe("progress-comment plugin", () => {
  test("inactive without a numeric progress target", async () => {
    expect(await hooksWith({ BOT_REPO: "o/r", BOT_PROGRESS_TARGET: undefined })).toEqual({})
    expect(await hooksWith({ BOT_REPO: "o/r", BOT_PROGRESS_TARGET: "abc" })).toEqual({})
    expect(await hooksWith({ BOT_REPO: undefined, BOT_PROGRESS_TARGET: "7" })).toEqual({})
  })

  test("mirrors only the root session, sanitizes markers, and sticky-updates", async () => {
    const root = mkdtempSync(join(tmpdir(), "progress-"))
    const log = fakeGh(root, [{ id: 42, body: "old\n<!-- cchp-bot:progress:engage -->" }])
    const hooks: any = await hooksWith({ BOT_REPO: "o/r", BOT_PROGRESS_TARGET: "7", BOT_TASK: "engage" })
    const after = hooks["tool.execute.after"]
    expect(typeof after).toBe("function")

    await after({ tool: "todowrite", sessionID: "root", args: { todos: [
      { content: "step one <!-- cchp-bot:evil -->", status: "completed" },
      { content: "step two", status: "in_progress" },
      { content: "step three", status: "pending" },
    ] } })
    // child sessions never overwrite the coordinator checklist
    await after({ tool: "todowrite", sessionID: "child", args: { todos: [{ content: "child noise", status: "pending" }] } })
    await after({ tool: "read", sessionID: "root", args: {} })

    const text = log()
    expect(text).toContain("--method PATCH")
    expect(text).toContain("issues/comments/42")
    expect(text).toContain("- [x] step one")
    expect(text).toContain("**step two** ⏳")
    expect(text).not.toContain("cchp-bot:evil")
    expect(text).not.toContain("child noise")
    expect((text.match(/--method (PATCH|POST)/g) || []).length).toBe(1)
  })
})
