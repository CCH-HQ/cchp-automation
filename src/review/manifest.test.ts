import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ReviewDeps } from "./diff"
import { capturePrReviewManifest } from "./manifest"

const HEX_BASE = "a".repeat(40)
const HEX_HEAD = "b".repeat(40)
const HEX_MERGE = "c".repeat(40)
const HEX_COMMIT = "d".repeat(40)

function harness(octokit: unknown) {
  const out: string[] = []
  const ctxDir = mkdtempSync(join(tmpdir(), "cchp-review-manifest-"))
  const deps: ReviewDeps = {
    octokit: octokit as ReviewDeps["octokit"],
    repo: "CCH-HQ/repo",
    ctxDir,
    appendPrompt: (t) => out.push(t),
  }
  return { out, ctxDir, deps, text: () => out.join("") }
}

interface FakeCfg {
  pr?: Record<string, unknown>
  prThrow?: boolean
  merge?: string | null
  compareThrow?: boolean
  files?: Record<string, unknown>[]
  filesThrow?: boolean
  commits?: Record<string, unknown>[]
}

function fakeOctokit(cfg: FakeCfg): unknown {
  return {
    rest: {
      pulls: {
        get: async () => {
          if (cfg.prThrow) throw new Error("boom")
          return { data: cfg.pr ?? {} }
        },
        listFiles: Object.assign(() => {}, { __tag: "files" }),
        listCommits: Object.assign(() => {}, { __tag: "commits" }),
      },
      repos: {
        compareCommits: async () => {
          if (cfg.compareThrow) throw new Error("compare failed")
          return { data: { merge_base_commit: { sha: cfg.merge } } }
        },
      },
    },
    paginate: async (fn: { __tag: string }) => {
      if (fn.__tag === "files") {
        if (cfg.filesThrow) throw new Error("files boom")
        return cfg.files ?? []
      }
      return cfg.commits ?? []
    },
  }
}

async function withEnv(name: string, value: string, fn: () => Promise<void>): Promise<void> {
  const prev = process.env[name]
  process.env[name] = value
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env[name]
    else process.env[name] = prev
  }
}

test("capturePrReviewManifest: builds the schema_version:1 manifest with hunk index + patch hash", async () => {
  const { deps, ctxDir, text } = harness(
    fakeOctokit({
      pr: {
        number: 9,
        title: "Add hedge",
        html_url: "https://x/pull/9",
        base: { ref: "dev", sha: HEX_BASE },
        head: { ref: "feat", sha: HEX_HEAD },
        changed_files: 1,
        additions: 2,
        deletions: 1,
      },
      merge: HEX_MERGE,
      files: [{ filename: "a.go", previous_filename: null, status: "modified", additions: 2, deletions: 1, changes: 3 }],
      commits: [{ sha: HEX_COMMIT, commit: { message: "feat: add hedge\n\nbody paragraph" } }],
    }),
  )
  const patch = "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1,2 +1,3 @@\n x\n+y\n+z\n"
  writeFileSync(join(ctxDir, "pr-diff.patch"), patch)

  await capturePrReviewManifest(deps, 9)

  const manifest = JSON.parse(readFileSync(join(ctxDir, "review-manifest.json"), "utf8"))
  expect(manifest.schema_version).toBe(1)
  expect(manifest.complete).toBe(true)
  expect(manifest.repository).toBe("CCH-HQ/repo")
  expect(manifest.pull_request).toEqual({
    number: 9,
    title: "Add hedge",
    url: "https://x/pull/9",
    base_ref: "dev",
    base_sha: HEX_BASE,
    head_ref: "feat",
    head_sha: HEX_HEAD,
    merge_base_sha: HEX_MERGE,
  })
  expect(manifest.totals).toEqual({ changed_files: 1, additions: 2, deletions: 1 })
  expect(manifest.commits).toEqual([{ sha: HEX_COMMIT, message: "feat: add hedge" }])
  expect(manifest.files).toEqual([
    {
      path: "a.go",
      previous_path: null,
      status: "modified",
      additions: 2,
      deletions: 1,
      changes: 3,
      patch_present: true,
      hunk_headers: ["@@ -1,2 +1,3 @@"],
    },
  ])
  expect(manifest.patch.path).toBe(join(ctxDir, "pr-diff.patch"))
  expect(manifest.patch.sha256).toBe(createHash("sha256").update(patch).digest("hex"))
  expect(manifest.blockers).toEqual([])
  // The read-only pointer is appended to the prompt.
  expect(text()).toContain("## Trusted review manifest")
  expect(text()).toContain(join(ctxDir, "review-manifest.json"))
})

test("capturePrReviewManifest: partial-reconstruction omissions become manifest blockers", async () => {
  const { deps, ctxDir } = harness(
    fakeOctokit({
      pr: { number: 1, base: { ref: "d", sha: HEX_BASE }, head: { ref: "h", sha: HEX_HEAD }, changed_files: 1, additions: 1, deletions: 0 },
      merge: HEX_MERGE,
      files: [{ filename: "a.go", status: "modified", additions: 1, deletions: 0, changes: 1 }],
      commits: [],
    }),
  )
  writeFileSync(join(ctxDir, "pr-diff.patch"), "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1 +1,2 @@\n x\n+y\n")
  writeFileSync(
    join(ctxDir, "pr-diff-omissions.json"),
    JSON.stringify({ total_files: 2, reconstructed: 1, omitted: [{ path: "image.png", status: "added", reason: "binary", additions: 0, deletions: 0 }], bytes: 10 }) + "\n",
  )
  await capturePrReviewManifest(deps, 1)
  const manifest = JSON.parse(readFileSync(join(ctxDir, "review-manifest.json"), "utf8"))
  expect(manifest.blockers).toEqual(["patch omitted for image.png: binary"])
})

test("capturePrReviewManifest: no saved patch → skips (fail-closed: no manifest)", async () => {
  const { deps, ctxDir } = harness(
    fakeOctokit({ pr: { number: 1, base: { sha: HEX_BASE }, head: { sha: HEX_HEAD }, changed_files: 0 }, merge: HEX_MERGE }),
  )
  await capturePrReviewManifest(deps, 1) // no pr-diff.patch on disk
  expect(existsSync(join(ctxDir, "review-manifest.json"))).toBe(false)
})

test("capturePrReviewManifest: BOT_HEAD_SHA drift skips the manifest", async () => {
  await withEnv("BOT_HEAD_SHA", "f".repeat(40), async () => {
    const { deps, ctxDir } = harness(
      fakeOctokit({ pr: { number: 1, base: { sha: HEX_BASE }, head: { sha: HEX_HEAD }, changed_files: 0 }, merge: HEX_MERGE, files: [], commits: [] }),
    )
    writeFileSync(join(ctxDir, "pr-diff.patch"), "x")
    await capturePrReviewManifest(deps, 1)
    expect(existsSync(join(ctxDir, "review-manifest.json"))).toBe(false)
  })
})

test("capturePrReviewManifest: non-40-hex base/head SHA skips", async () => {
  const { deps, ctxDir } = harness(
    fakeOctokit({ pr: { number: 1, base: { sha: "short" }, head: { sha: HEX_HEAD }, changed_files: 0 }, merge: HEX_MERGE }),
  )
  writeFileSync(join(ctxDir, "pr-diff.patch"), "x")
  await capturePrReviewManifest(deps, 1)
  expect(existsSync(join(ctxDir, "review-manifest.json"))).toBe(false)
})

test("capturePrReviewManifest: files/changed_files count mismatch skips", async () => {
  const { deps, ctxDir } = harness(
    fakeOctokit({
      pr: { number: 1, base: { sha: HEX_BASE }, head: { sha: HEX_HEAD }, changed_files: 5 },
      merge: HEX_MERGE,
      files: [{ filename: "a.go" }],
      commits: [],
    }),
  )
  writeFileSync(join(ctxDir, "pr-diff.patch"), "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1 +1 @@\n x\n")
  await capturePrReviewManifest(deps, 1)
  expect(existsSync(join(ctxDir, "review-manifest.json"))).toBe(false)
})

test("capturePrReviewManifest: compare failure (no merge base) skips", async () => {
  const { deps, ctxDir } = harness(
    fakeOctokit({ pr: { number: 1, base: { sha: HEX_BASE }, head: { sha: HEX_HEAD }, changed_files: 0 }, compareThrow: true }),
  )
  writeFileSync(join(ctxDir, "pr-diff.patch"), "x")
  await capturePrReviewManifest(deps, 1)
  expect(existsSync(join(ctxDir, "review-manifest.json"))).toBe(false)
})
