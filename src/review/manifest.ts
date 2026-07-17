// Trusted review manifest for the #5 review pipeline, ported from
// `.github/cchp-bot/context.sh::capture_pr_review_manifest` (gh → Octokit,
// ADR 0003). Binds the immutable review identity + change metadata outside the
// review clone so the model can read but never edit it: base/head/merge-base
// SHAs, per-file status + hunk headers, commits, and the SHA-256 of the exact
// saved patch. The `pr_opened` finalizer (`finalize.ts`) later re-verifies every
// one of these bindings before any review is allowed to publish.
//
// The bash read a pre-written metadata file (`gh pr view --json …`); here the
// trusted base side re-fetches the same identity via `pulls.get` and derives the
// merge base with `repos.compareCommits`, then paginates `pulls.listFiles` /
// `pulls.listCommits`. Every guard that made the bash silently skip manifest
// emission is preserved (missing/oversized diff, non-40-hex SHAs, the
// BOT_HEAD_SHA drift check, a files/`changed_files` count mismatch, …).
import { createHash } from "node:crypto"
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { splitRepo } from "../context"
import type { GitHubClient } from "../github/client"
import { ARTIFACT_SCHEMA_VERSION } from "../types"
import type { ReviewDeps } from "./diff"
import { buildPatchIndex } from "./patch-index"

const SHA40 = /^[0-9a-fA-F]{40}$/

interface ManifestCommit {
  sha: string
  message: string
}

interface ManifestFile {
  path: string
  previous_path: string | null
  status: string
  additions: number
  deletions: number
  changes: number
  patch_present: boolean
  hunk_headers: string[]
}

/** The `schema_version: 1` trusted review manifest (frozen shape — the finalizer
 *  binds against these exact fields). */
export interface ReviewManifest {
  schema_version: number
  complete: true
  repository: string
  pull_request: {
    number: number
    title: string
    url: string
    base_ref: string
    base_sha: string
    head_ref: string
    head_sha: string
    merge_base_sha: string
  }
  totals: { changed_files: number; additions: number; deletions: number }
  commits: ManifestCommit[]
  files: ManifestFile[]
  patch: { path: string; sha256: string }
  generated_at: string
  blockers: string[]
}

// Structural views of the Octokit responses we consume (the real, wider objects
// flow in unchanged via structural typing).
interface PrMeta {
  number?: number
  title?: string | null
  html_url?: string
  additions?: number
  deletions?: number
  changed_files?: number
  base?: { ref?: string; sha?: string } | null
  head?: { ref?: string; sha?: string } | null
}
interface CompareData {
  merge_base_commit?: { sha?: string } | null
}
interface PullFileMeta {
  filename: string
  previous_filename?: string | null
  status?: string
  additions?: number
  deletions?: number
  changes?: number
}
interface PullCommitMeta {
  sha?: string
  commit?: { message?: string } | null
}

const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex")

/** UTC `YYYY-MM-DDTHH:MM:SSZ`, matching the bash `date -u +…`. */
function utcStamp(now = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z")
}

/** Derive the partial-reconstruction blockers from the omissions report the diff
 *  capture may have written — verbatim mapping of the bash jq. Absent/empty/broken
 *  report → no blockers. */
function readBlockers(omissionsFile: string): string[] {
  if (!existsSync(omissionsFile)) return []
  try {
    const stat = statSync(omissionsFile)
    if (!stat.isFile() || stat.size === 0) return []
    const parsed = JSON.parse(readFileSync(omissionsFile, "utf8")) as { omitted?: { path?: string; reason?: string }[] }
    const omitted = Array.isArray(parsed.omitted) ? parsed.omitted : []
    return omitted.map((o) => `patch omitted for ${o.path}: ${o.reason ?? "unavailable"}`)
  } catch {
    return []
  }
}

/** Build + persist the trusted review manifest and append its read-only pointer
 *  to the prompt. Any guard failure silently skips emission (returns without a
 *  manifest), exactly like the bash — a review with no trusted manifest simply
 *  cannot pass the finalizer, which is the intended fail-closed posture. */
export async function capturePrReviewManifest(deps: ReviewDeps, num: number): Promise<void> {
  const { octokit, repo, ctxDir, appendPrompt } = deps
  const { owner, name } = splitRepo(repo)
  const manifestFile = join(ctxDir, "review-manifest.json")
  const patchFile = join(ctxDir, "pr-diff.patch")
  const omissionsFile = join(ctxDir, "pr-diff-omissions.json")

  // Requires a successfully captured, non-empty diff (the manifest hashes it).
  if (process.env.BOT_SKIP_PR_INSPECT === "1") return
  if (!existsSync(patchFile) || !statSync(patchFile).isFile() || statSync(patchFile).size === 0) return

  let pr: PrMeta
  try {
    const res = await octokit.rest.pulls.get({ owner, repo: name, pull_number: num })
    pr = res.data as PrMeta
  } catch {
    return
  }

  const baseSha = pr.base?.sha ?? ""
  const headSha = pr.head?.sha ?? ""
  if (!SHA40.test(baseSha) || !SHA40.test(headSha)) return

  // The head must not have moved since routing pinned it (BOT_HEAD_SHA).
  const boundHead = process.env.BOT_HEAD_SHA
  if (boundHead && boundHead !== headSha) return

  let mergeBaseSha = ""
  try {
    const cmp = await octokit.rest.repos.compareCommits({ owner, repo: name, base: baseSha, head: headSha })
    mergeBaseSha = (cmp.data as CompareData).merge_base_commit?.sha ?? ""
  } catch {
    return
  }
  if (!SHA40.test(mergeBaseSha)) return

  let files: PullFileMeta[]
  let commits: PullCommitMeta[]
  try {
    files = (await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner,
      repo: name,
      pull_number: num,
      per_page: 100,
    })) as PullFileMeta[]
  } catch {
    return
  }
  try {
    commits = (await octokit.paginate(octokit.rest.pulls.listCommits, {
      owner,
      repo: name,
      pull_number: num,
      per_page: 100,
    })) as PullCommitMeta[]
  } catch {
    return
  }

  const changedFiles = Number(pr.changed_files ?? 0)
  if (files.length !== changedFiles) return

  let patchIndex: Record<string, string[]>
  try {
    patchIndex = buildPatchIndex(readFileSync(patchFile, "utf8"))
  } catch {
    return
  }

  const manifest: ReviewManifest = {
    schema_version: ARTIFACT_SCHEMA_VERSION,
    complete: true,
    repository: repo,
    pull_request: {
      number: Number(pr.number ?? 0),
      title: pr.title ?? "",
      url: pr.html_url ?? "",
      base_ref: pr.base?.ref ?? "",
      base_sha: baseSha,
      head_ref: pr.head?.ref ?? "",
      head_sha: headSha,
      merge_base_sha: mergeBaseSha,
    },
    totals: {
      changed_files: changedFiles,
      additions: Number(pr.additions ?? 0),
      deletions: Number(pr.deletions ?? 0),
    },
    commits: commits.map((c) => ({ sha: c.sha ?? "", message: (c.commit?.message ?? "").split("\n")[0] ?? "" })),
    files: files.map((f) => ({
      path: f.filename,
      previous_path: f.previous_filename ?? null,
      status: f.status ?? "",
      additions: Number(f.additions ?? 0),
      deletions: Number(f.deletions ?? 0),
      changes: Number(f.changes ?? 0),
      patch_present: patchIndex[f.filename] != null,
      hunk_headers: patchIndex[f.filename] ?? [],
    })),
    patch: { path: patchFile, sha256: sha256File(patchFile) },
    generated_at: utcStamp(),
    blockers: readBlockers(omissionsFile),
  }

  const tmp = `${manifestFile}.tmp`
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n")
  renameSync(tmp, manifestFile)

  appendPrompt(
    "\n" +
      [
        "## Trusted review manifest",
        "A trusted base-side process bound the PR identity, revisions, merge base, files, commits, hunks, and patch hash at:",
        `    ${manifestFile}`,
        "Treat this file as read-only authoritative review input.",
      ].join("\n"),
  )
}
