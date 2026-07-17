import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FinalizeError, finalizeReview } from "./finalize"

const HEX_BASE = "a".repeat(40)
const HEX_HEAD = "b".repeat(40)
const HEX_MERGE = "c".repeat(40)
const sha = (v: string | Buffer): string => createHash("sha256").update(v).digest("hex")

const REPORT = [
  "# Code Review Result",
  "",
  "## Scope",
  "scope text",
  "## Verification summary",
  "summary",
  "## Verified findings",
  "findings",
  "## High-risk unresolved candidates",
  "none",
  "## Coverage and limitations",
  "coverage",
  "## Refutation ledger",
  "refutations",
  "",
].join("\n")

const emptySweep = () => ({ new_candidate_ids: [], coverage_gaps: [] })

interface Bundle {
  manifest: Record<string, unknown>
  coverage: Record<string, unknown>
  candidates: Record<string, unknown>
  verification: Record<string, unknown>
  report: string
}

/** Write a fully valid evidence bundle; `mut` may corrupt one artifact before it
 *  is serialized to exercise a specific gate. */
function writeValid(mut: (b: Bundle) => void = () => {}): { artifactDir: string; trustedManifest: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "cchp-finalize-"))
  const artifactDir = join(root, "artifacts")
  mkdirSync(artifactDir, { recursive: true })

  const patchFile = join(root, "pr-diff.patch")
  const patchContent = "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1 +1,2 @@\n x\n+y\n"
  writeFileSync(patchFile, patchContent)

  const trusted = {
    schema_version: 1,
    complete: true,
    repository: "r",
    pull_request: {
      number: 1,
      title: "t",
      url: "u",
      base_ref: "b",
      base_sha: HEX_BASE,
      head_ref: "h",
      head_sha: HEX_HEAD,
      merge_base_sha: HEX_MERGE,
    },
    totals: { changed_files: 1, additions: 1, deletions: 0 },
    commits: [],
    files: [
      {
        path: "a.go",
        previous_path: null,
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        patch_present: true,
        hunk_headers: ["@@ -1 +1,2 @@"],
      },
    ],
    patch: { path: patchFile, sha256: sha(patchContent) },
    generated_at: "2026-01-01T00:00:00Z",
    blockers: [],
  }
  const trustedManifest = join(root, "review-manifest.json")
  writeFileSync(trustedManifest, JSON.stringify(trusted))
  const trustedHash = sha(readFileSync(trustedManifest))

  const bundle: Bundle = {
    manifest: {
      schema_version: 1,
      trusted_manifest_sha256: trustedHash,
      base_sha: HEX_BASE,
      head_sha: HEX_HEAD,
      merge_base_sha: HEX_MERGE,
      review_shards: ["shard-1"],
      environment_blockers: [],
    },
    coverage: {
      schema_version: 1,
      entries: [
        {
          file: "a.go",
          hunk: "@@ -1 +1,2 @@",
          correctness_passes: ["p1", "p2", "p3", "p4", "p5"],
          dimensions: ["logic"],
        },
      ],
      gap_sweeps: [emptySweep(), emptySweep(), emptySweep()],
      consecutive_dry_rounds: 3,
      completeness_panel: { uncovered_dimensions: [] },
      limitations: [],
    },
    candidates: {
      schema_version: 1,
      candidates: [{ candidate_id: "c1", root_cause_key: "rc1", severity_guess: "P2" }],
    },
    verification: {
      schema_version: 1,
      verifications: [
        {
          candidate_id: "c1",
          verdict: "REFUTED",
          severity: "P2",
          confidence: 0.5,
          verifier_roles: ["r1", "r2", "r3", "r4"],
          diff_causality: "unrelated",
          reproduction: { attempted: false },
          blockers: ["not reproducible"],
        },
      ],
    },
    report: REPORT,
  }
  mut(bundle)

  writeFileSync(join(artifactDir, "manifest.json"), JSON.stringify(bundle.manifest))
  writeFileSync(join(artifactDir, "coverage.json"), JSON.stringify(bundle.coverage))
  writeFileSync(join(artifactDir, "candidate-ledger.json"), JSON.stringify(bundle.candidates))
  writeFileSync(join(artifactDir, "verification-ledger.json"), JSON.stringify(bundle.verification))
  writeFileSync(join(artifactDir, "final-report.md"), bundle.report)
  return { artifactDir, trustedManifest, root }
}

test("finalizeReview: a complete valid bundle passes and writes the attestation", () => {
  const { artifactDir, trustedManifest } = writeValid()
  const marker = finalizeReview(artifactDir, trustedManifest)
  expect(marker.schema_version).toBe(1)
  expect(marker.valid).toBe(true)
  expect(marker.head_sha).toBe(HEX_HEAD)
  expect(marker.trusted_manifest_sha256).toBe(sha(readFileSync(trustedManifest)))
  expect(marker.artifacts.coverage).toBe(sha(readFileSync(join(artifactDir, "coverage.json"))))
  // Default marker path is <artifactDir>/review-finalized.json.
  const written = JSON.parse(readFileSync(join(artifactDir, "review-finalized.json"), "utf8"))
  expect(written).toEqual(marker as unknown as Record<string, unknown>)
})

test("finalizeReview: coverage that omits a trusted hunk fails closed", () => {
  const { artifactDir, trustedManifest } = writeValid((b) => {
    ;(b.coverage.entries as { hunk: string }[])[0]!.hunk = "@@ -99 +99 @@" // no longer covers the trusted hunk
  })
  expect(() => finalizeReview(artifactDir, trustedManifest)).toThrow(/omits one or more trusted changed file\/hunk/)
})

test("finalizeReview: a verification whose candidate set drifts fails closed", () => {
  const { artifactDir, trustedManifest } = writeValid((b) => {
    ;(b.verification.verifications as { candidate_id: string }[])[0]!.candidate_id = "different"
  })
  expect(() => finalizeReview(artifactDir, trustedManifest)).toThrow(/one valid terminal verdict/)
})

test("finalizeReview: a P0 finding needs ≥7 verifier roles", () => {
  const { artifactDir, trustedManifest } = writeValid((b) => {
    const v = (b.verification.verifications as Record<string, unknown>[])[0]!
    v.severity = "P0"
    b.candidates = { schema_version: 1, candidates: [{ candidate_id: "c1", root_cause_key: "rc1", severity_guess: "P0" }] }
  })
  expect(() => finalizeReview(artifactDir, trustedManifest)).toThrow(/one valid terminal verdict/)
})

test("finalizeReview: a stale patch hash (patch edited after binding) fails closed", () => {
  const { artifactDir, trustedManifest, root } = writeValid()
  writeFileSync(join(root, "pr-diff.patch"), "tampered content\n")
  expect(() => finalizeReview(artifactDir, trustedManifest)).toThrow(/trusted patch hash no longer matches/)
})

test("finalizeReview: a symlinked artifact is rejected (no symlink smuggling)", () => {
  const { artifactDir, trustedManifest, root } = writeValid()
  const real = join(root, "real-manifest.json")
  writeFileSync(real, readFileSync(join(artifactDir, "manifest.json")))
  rmSync(join(artifactDir, "manifest.json"))
  symlinkSync(real, join(artifactDir, "manifest.json"))
  expect(() => finalizeReview(artifactDir, trustedManifest)).toThrow(/missing or unsafe regular file/)
})

test("finalizeReview: missing final-report heading fails closed", () => {
  const { artifactDir, trustedManifest } = writeValid((b) => {
    b.report = b.report.replace("## Refutation ledger", "## Refutations")
  })
  expect(() => finalizeReview(artifactDir, trustedManifest)).toThrow(/missing heading: ## Refutation ledger/)
})

test("finalizeReview: fewer than 3 gap sweeps fails closed", () => {
  const { artifactDir, trustedManifest } = writeValid((b) => {
    b.coverage.gap_sweeps = [emptySweep(), emptySweep()]
  })
  expect(() => finalizeReview(artifactDir, trustedManifest)).toThrow(FinalizeError)
})
