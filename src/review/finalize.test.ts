import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ReviewAdmissionLedger, type ReviewPassKind } from "../codex/review-admission"
import { openRegularFileSnapshot } from "../codex/file-snapshot"
import { ProvenanceLedger } from "../codex/provenance"
import { FinalizeError, finalizeReview, selectFinalizerProvenance, type FinalizeDependencies } from "./finalize"

const HEX_BASE = "a".repeat(40)
const HEX_HEAD = "b".repeat(40)
const HEX_MERGE = "c".repeat(40)
const sha = (v: string | Buffer): string => createHash("sha256").update(v).digest("hex")
const FINALIZE_CONTEXT = {
  repository: "CCH-HQ/fixture",
  prNumber: 42,
  runId: "run-1",
  provenanceSha256: "d".repeat(64),
}
const finalize = (artifactDir: string, trustedManifest: string, dependencies?: FinalizeDependencies) =>
  finalizeReview(artifactDir, trustedManifest, join(artifactDir, "review-finalized.json"), {
    ...FINALIZE_CONTEXT,
    admissionLedgerPath: join(artifactDir, "..", "review-admission.jsonl"),
  }, dependencies)

const REPORT = [
  "# Code Review Result",
  "",
  "## Scope",
  '- Repository: "CCH-HQ/fixture"',
  "- Pull request: #42",
  `- Base SHA: ${HEX_BASE}`,
  `- Head SHA: ${HEX_HEAD}`,
  `- Merge-base SHA: ${HEX_MERGE}`,
  "- Changed files: 1",
  "- Trusted file/hunk pairs: 1",
  "",
  "## Verification summary",
  "- Candidates: 1",
  "- Admitted completed tasks: 9",
  '- Verdict counts: {"REFUTED":1}',
  "",
  "## Verified findings",
  "- None.",
  "",
  "## High-risk unresolved candidates",
  "- None.",
  "",
  "## Coverage and limitations",
  "- Covered file/hunk pairs: 1/1",
  "- Correctness task references: 5",
  '- Coverage dimensions: ["logic"]',
  "- Limitations: []",
  "",
  "## Refutation ledger",
  '- candidate_id="c1"; severity="P2"; verdict="REFUTED"; confidence=0.5; diff_causality="unrelated"; root_cause_key="rc1"',
  '  - Blockers: ["not reproducible"]',
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
function writeValid(
  mut: (b: Bundle) => void = () => {},
  mutateResult: (result: Record<string, unknown>, taskId: string) => void = () => {},
  mutateTrusted: (trusted: Record<string, unknown>) => void = () => {},
  mutateTaskSpec: (spec: { role: string; passKind: ReviewPassKind }, taskId: string) => void = () => {},
): { artifactDir: string; trustedManifest: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "cchp-finalize-"))
  const artifactDir = join(root, "artifacts")
  mkdirSync(artifactDir, { recursive: true })

  const patchFile = join(root, "pr-diff.patch")
  const patchContent = "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1 +1,2 @@\n x\n+y\n"
  writeFileSync(patchFile, patchContent)

  const trusted = {
    schema_version: 1,
    complete: true,
    repository: FINALIZE_CONTEXT.repository,
    pull_request: {
      number: FINALIZE_CONTEXT.prNumber,
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
  mutateTrusted(trusted)
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
      review_shards: ["a.go:@@ -1 +1,2 @@"],
      admitted_task_ids: ["p1", "p2", "p3", "p4", "p5", "r1", "r2", "r3", "r4"],
      environment_blockers: [],
    },
    coverage: {
      schema_version: 1,
      entries: [
        {
          file: "a.go",
          hunk: "@@ -1 +1,2 @@",
          correctness_passes: ["boundary", "negative-space", "contracts", "errors", "concurrency"],
          correctness_task_ids: ["p1", "p2", "p3", "p4", "p5"],
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
          verifier_roles: ["causal confirmer", "adversarial refuter", "reproduction engineer", "impact judge"],
          verifier_task_ids: ["r1", "r2", "r3", "r4"],
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
  const admissions = new ReviewAdmissionLedger(join(root, "review-admission.jsonl"), FINALIZE_CONTEXT.runId)
  const verifierSpecs: Array<{ role: string; passKind: ReviewPassKind }> = [
    { role: "causal confirmer", passKind: "verifier" },
    { role: "adversarial refuter", passKind: "refuter" },
    { role: "reproduction engineer", passKind: "reproducer" },
    { role: "impact judge", passKind: "adjudicator" },
    { role: "security verifier", passKind: "verifier" },
    { role: "additional refuter", passKind: "refuter" },
    { role: "domain adjudicator", passKind: "adjudicator" },
  ]
  for (const taskId of bundle.manifest.admitted_task_ids as string[]) {
    const baseSpec = taskId.startsWith("p")
      ? { role: "independent reviewer", passKind: "correctness" as const }
      : verifierSpecs[Number(taskId.slice(1)) - 1]!
    const spec = { ...baseSpec }
    mutateTaskSpec(spec, taskId)
    const { role, passKind } = spec
    const childThreadId = `session-${taskId}`
    const output = JSON.stringify({ claims: taskId.startsWith("p")
      ? { coverage: [{ file: "a.go", hunk: "@@ -1 +1,2 @@" }] }
      : { candidate_ids: ["c1"] } })
    const resultPath = join(root, `${taskId}.json`)
    const result: Record<string, unknown> = {
      schemaVersion: 3,
      mode: "explicit_child",
      runId: FINALIZE_CONTEXT.runId,
      parentRunId: FINALIZE_CONTEXT.runId,
      childId: taskId,
      parentId: "root",
      role,
      passKind,
      state: "completed",
      sessionId: childThreadId,
      deadlineAt: "2099-01-01T00:00:00.000Z",
      sandbox: "read-only",
      tokenScope: "child",
      output,
      attempts: [{ attempt: 1, sessionId: childThreadId, state: "completed", terminal: "completed", startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z", output }],
      updatedAt: "2026-01-01T00:00:01.000Z",
    }
    mutateResult(result, taskId)
    const serialized = `${JSON.stringify(result, null, 2)}\n`
    writeFileSync(resultPath, serialized)
    admissions.admit({ taskId, role, passKind, mode: "explicit_child", prompt: `review ${taskId}` })
    admissions.bind(taskId, `explicit:${taskId}`, childThreadId, childThreadId)
    admissions.markTerminal(taskId, "completed", undefined, {
      schemaVersion: 1,
      artifactPath: resultPath,
      artifactSha256: sha(serialized),
      outputSha256: sha(output),
      outputBytes: Buffer.byteLength(output),
    })
  }
  return { artifactDir, trustedManifest, root }
}

test("finalizeReview: a complete valid bundle passes and writes the attestation", () => {
  const { artifactDir, trustedManifest } = writeValid()
  const marker = finalize(artifactDir, trustedManifest)
  expect(marker.schema_version).toBe(1)
  expect(marker.valid).toBe(true)
  expect(marker).toMatchObject({ repository: "CCH-HQ/fixture", pr_number: 42, run_id: "run-1", provenance_sha256: "d".repeat(64) })
  expect(marker.head_sha).toBe(HEX_HEAD)
  expect(marker.trusted_manifest_sha256).toBe(sha(readFileSync(trustedManifest)))
  expect(marker.artifacts.coverage).toBe(sha(readFileSync(join(artifactDir, "coverage.json"))))
  // Default marker path is <artifactDir>/review-finalized.json.
  const written = JSON.parse(readFileSync(join(artifactDir, "review-finalized.json"), "utf8"))
  expect(written).toEqual(marker as unknown as Record<string, unknown>)
})

test("finalizeReview: accepts legacy explicit v2 artifacts during durable resume", () => {
  const { artifactDir, trustedManifest } = writeValid(
    () => undefined,
    (result) => { result.schemaVersion = 2 },
  )
  expect(finalize(artifactDir, trustedManifest)).toMatchObject({ valid: true, run_id: FINALIZE_CONTEXT.runId })
})

test("finalizeReview: trusted manifest identity and schema must match the finalizer context", () => {
  for (const mutateTrusted of [
    (trusted: Record<string, unknown>) => { trusted.repository = "other/repository" },
    (trusted: Record<string, unknown>) => { (trusted.pull_request as Record<string, unknown>).number = 41 },
    (trusted: Record<string, unknown>) => { trusted.schema_version = 999 },
  ]) {
    const { artifactDir, trustedManifest } = writeValid(() => undefined, () => undefined, mutateTrusted)
    expect(() => finalize(artifactDir, trustedManifest)).toThrow(/trusted manifest/)
  }
})

test("finalizeReview: trusted manifest files and totals cannot be omitted or drift", () => {
  const missingFiles = writeValid(
    () => undefined,
    () => undefined,
    (trusted) => { delete trusted.files },
  )
  expect(() => finalize(missingFiles.artifactDir, missingFiles.trustedManifest)).toThrow(/trusted manifest/)

  const changedFileDrift = writeValid(
    () => undefined,
    () => undefined,
    (trusted) => { (trusted.totals as Record<string, unknown>).changed_files = 2 },
  )
  expect(() => finalize(changedFileDrift.artifactDir, changedFileDrift.trustedManifest)).toThrow(/trusted manifest/)
})

test("finalizeReview: coverage that omits a trusted hunk fails closed", () => {
  const { artifactDir, trustedManifest } = writeValid((b) => {
    ;(b.coverage.entries as { hunk: string }[])[0]!.hunk = "@@ -99 +99 @@" // no longer covers the trusted hunk
  })
  expect(() => finalize(artifactDir, trustedManifest)).toThrow(/omits one or more trusted changed file\/hunk/)
})

test("finalizeReview: a verification whose candidate set drifts fails closed", () => {
  const { artifactDir, trustedManifest } = writeValid((b) => {
    ;(b.verification.verifications as { candidate_id: string }[])[0]!.candidate_id = "different"
  })
  expect(() => finalize(artifactDir, trustedManifest)).toThrow(/one valid terminal verdict/)
})

test("finalizeReview: a P0 finding needs ≥7 verifier roles", () => {
  const { artifactDir, trustedManifest } = writeValid((b) => {
    const v = (b.verification.verifications as Record<string, unknown>[])[0]!
    v.severity = "P0"
    b.candidates = { schema_version: 1, candidates: [{ candidate_id: "c1", root_cause_key: "rc1", severity_guess: "P0" }] }
  })
  expect(() => finalize(artifactDir, trustedManifest)).toThrow(/one valid terminal verdict/)
})

test("finalizeReview: a stale patch hash (patch edited after binding) fails closed", () => {
  const { artifactDir, trustedManifest, root } = writeValid()
  writeFileSync(join(root, "pr-diff.patch"), "tampered content\n")
  expect(() => finalize(artifactDir, trustedManifest)).toThrow(/trusted patch hash no longer matches/)
})

test("finalizeReview: a symlinked artifact is rejected (no symlink smuggling)", () => {
  const { artifactDir, trustedManifest, root } = writeValid()
  const real = join(root, "real-manifest.json")
  writeFileSync(real, readFileSync(join(artifactDir, "manifest.json")))
  rmSync(join(artifactDir, "manifest.json"))
  symlinkSync(real, join(artifactDir, "manifest.json"))
  expect(() => finalize(artifactDir, trustedManifest)).toThrow(/missing or unsafe regular file/)
})

test("finalizeReview: missing final-report heading fails closed", () => {
  const { artifactDir, trustedManifest } = writeValid((b) => {
    b.report = b.report.replace("## Refutation ledger", "## Refutations")
  })
  expect(() => finalize(artifactDir, trustedManifest)).toThrow(/missing heading: ## Refutation ledger/)
})

test("finalizeReview: final report verdict text must exactly match the verification ledger", () => {
  const { artifactDir, trustedManifest } = writeValid((bundle) => {
    bundle.report = bundle.report.replace('verdict="REFUTED"', 'verdict="CONFIRMED_STATIC"')
  })
  expect(() => finalize(artifactDir, trustedManifest)).toThrow(/canonical review evidence/)
})

test("finalizeReview: final report cannot invent an extra verified finding", () => {
  const { artifactDir, trustedManifest } = writeValid((bundle) => {
    bundle.report = bundle.report.replace("## Verified findings\n- None.", "## Verified findings\n- Invented P0 finding.")
  })
  expect(() => finalize(artifactDir, trustedManifest)).toThrow(/canonical review evidence/)
})

test("finalizeReview: fewer than 3 gap sweeps fails closed", () => {
  const { artifactDir, trustedManifest } = writeValid((b) => {
    b.coverage.gap_sweeps = [emptySweep(), emptySweep()]
  })
  expect(() => finalize(artifactDir, trustedManifest)).toThrow(FinalizeError)
})

test("finalizeReview: admitted task ids must exactly match completed admissions", () => {
  const { artifactDir, trustedManifest } = writeValid()
  const manifestPath = join(artifactDir, "manifest.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
  manifest.admitted_task_ids = [...manifest.admitted_task_ids as string[], "ghost-task"]
  writeFileSync(manifestPath, JSON.stringify(manifest))
  expect(() => finalize(artifactDir, trustedManifest)).toThrow(/admitted_task_ids.*admitted task set/)
})

test("finalizeReview: tampered child result bytes fail closed", () => {
  const { artifactDir, trustedManifest, root } = writeValid()
  writeFileSync(join(root, "p1.json"), '{"tampered":true}\n')
  expect(() => finalize(artifactDir, trustedManifest)).toThrow(/result artifact hash mismatch/)
})

test("finalizeReview: malformed evidence errors do not echo secret content", () => {
  const { artifactDir, trustedManifest } = writeValid()
  const secret = "CCHP_SECRET_SENTINEL_7d3f"
  writeFileSync(join(artifactDir, "manifest.json"), `{"token":"${secret}",BROKEN}`)
  let message = ""
  try {
    finalize(artifactDir, trustedManifest)
  } catch (error) {
    message = String(error)
  }
  expect(message).toContain("cannot parse JSON")
  expect(message).not.toContain(secret)
})

test("finalizeReview: confirmed locations require a valid anchored range", () => {
  const invalid = writeValid((bundle) => {
    const verification = (bundle.verification.verifications as Array<Record<string, unknown>>)[0]!
    verification.verdict = "CONFIRMED_STATIC"
    verification.location = { file: "a.go", line: 1, side: "MIDDLE" }
    verification.trigger = "trigger"
    verification.observable_failure = "failure"
    verification.execution_trace = ["trace"]
    bundle.report = [
      "# Code Review Result", "", "## Scope",
      '- Repository: "CCH-HQ/fixture"', "- Pull request: #42", `- Base SHA: ${HEX_BASE}`, `- Head SHA: ${HEX_HEAD}`, `- Merge-base SHA: ${HEX_MERGE}`,
      "- Changed files: 1", "- Trusted file/hunk pairs: 1", "", "## Verification summary", "- Candidates: 1", "- Admitted completed tasks: 9", '- Verdict counts: {"CONFIRMED_STATIC":1}', "", "## Verified findings",
      '- candidate_id="c1"; severity="P2"; verdict="CONFIRMED_STATIC"; confidence=0.5; diff_causality="unrelated"; root_cause_key="rc1"',
      '  - Location: {"file":"a.go","line":1,"side":"MIDDLE"}', '  - Trigger: "trigger"', '  - Observable failure: "failure"', '  - Execution trace: ["trace"]', "", "## High-risk unresolved candidates", "- None.", "", "## Coverage and limitations", "- Covered file/hunk pairs: 1/1", "- Correctness task references: 5", '- Coverage dimensions: ["logic"]', "- Limitations: []", "", "## Refutation ledger", "- None.", "",
    ].join("\n")
  })
  expect(() => finalize(invalid.artifactDir, invalid.trustedManifest)).toThrow(/one valid terminal verdict/)
})

test("finalizeReview: evidence replacement while snapshotting fails closed before attestation", () => {
  const { artifactDir, trustedManifest, root } = writeValid()
  const coveragePath = join(artifactDir, "coverage.json")
  const originalCoverage = readFileSync(coveragePath)
  let replaced = false
  const dependencies: FinalizeDependencies = {
    snapshotFile: (path) => openRegularFileSnapshot(path, {
      afterOpen: () => {
        if (path !== coveragePath || replaced) return
        replaced = true
        renameSync(coveragePath, join(root, "coverage.original.json"))
        writeFileSync(coveragePath, '{"schema_version":1,"entries":[]}')
      },
    }),
  }
  expect(() => finalize(artifactDir, trustedManifest, dependencies)).toThrow(/missing or unsafe regular file/)
  expect(replaced).toBe(true)
  expect(readFileSync(join(root, "coverage.original.json"))).toEqual(originalCoverage)
  expect(existsSync(join(artifactDir, "review-finalized.json"))).toBe(false)
})

test("finalizeReview: result mode must exactly match the admission mode", () => {
  const { artifactDir, trustedManifest } = writeValid(
    () => undefined,
    (result, taskId) => {
      if (taskId === "p1") result.mode = "native_v2"
    },
  )
  expect(() => finalize(artifactDir, trustedManifest)).toThrow(/result artifact mode drift for p1/)
})

test("finalizeReview: correctness and verifier references require role-compatible result claims", () => {
  const invalidCorrectness = writeValid((bundle) => {
    ;(bundle.coverage.entries as Array<Record<string, unknown>>)[0]!.correctness_task_ids = ["r1", "p2", "p3", "p4", "p5"]
  })
  expect(() => finalize(invalidCorrectness.artifactDir, invalidCorrectness.trustedManifest)).toThrow(/correctness task/)

  const invalidVerifier = writeValid((bundle) => {
    ;(bundle.verification.verifications as Array<Record<string, unknown>>)[0]!.verifier_task_ids = ["p1", "r2", "r3", "r4"]
  })
  expect(() => finalize(invalidVerifier.artifactDir, invalidVerifier.trustedManifest)).toThrow(/verifier task/)
})

test("finalizeReview: verifier provenance must cover every trusted verification pass kind", () => {
  const invalid = writeValid(
    () => undefined,
    () => undefined,
    () => undefined,
    (spec, taskId) => {
      if (taskId.startsWith("r")) spec.passKind = "verifier"
    },
  )
  expect(() => finalize(invalid.artifactDir, invalid.trustedManifest)).toThrow(/verification pass-kind coverage/)
})

test("finalizeReview: P0 and P1 provenance requires seven tasks and an additional refuter", () => {
  const invalid = writeValid(
    (bundle) => {
      bundle.manifest.admitted_task_ids = ["p1", "p2", "p3", "p4", "p5", "r1", "r2", "r3", "r4", "r5", "r6", "r7"]
      bundle.candidates = { schema_version: 1, candidates: [{ candidate_id: "c1", root_cause_key: "rc1", severity_guess: "P1" }] }
      const verification = (bundle.verification.verifications as Array<Record<string, unknown>>)[0]!
      verification.severity = "P1"
      verification.verifier_task_ids = ["r1", "r2", "r3", "r4", "r5", "r6", "r7"]
      verification.verifier_roles = ["causal confirmer", "adversarial refuter", "reproduction engineer", "impact judge", "security verifier", "additional refuter", "domain adjudicator"]
    },
    () => undefined,
    () => undefined,
    (spec, taskId) => {
      if (taskId === "r6") spec.passKind = "verifier"
    },
  )
  expect(() => finalize(invalid.artifactDir, invalid.trustedManifest)).toThrow(/additional refuter/)
})

test("finalizeReview: admission ledger is mandatory", () => {
  const { artifactDir, trustedManifest, root } = writeValid()
  rmSync(join(root, "review-admission.jsonl"))
  expect(() => finalize(artifactDir, trustedManifest)).toThrow(/admission ledger/)
})

test("selectFinalizerProvenance: an existing marker keeps its immutable ancestor hash", () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-finalize-provenance-"))
  const ledgerPath = join(root, "provenance.jsonl")
  const ledger = new ProvenanceLedger(ledgerPath, "run-1")
  const evidence = ledger.record("review_evidence_ready", { ready: true })
  const preterminal = ledger.record("root_completed", { completed: true })
  const marker = join(root, "review-finalized.json")
  writeFileSync(marker, JSON.stringify({ provenance_sha256: evidence.sha256 }))
  expect(selectFinalizerProvenance(marker, new ProvenanceLedger(ledgerPath, "run-1"), preterminal.sha256)).toBe(evidence.sha256)

  writeFileSync(marker, JSON.stringify({ provenance_sha256: "f".repeat(64) }))
  expect(() => selectFinalizerProvenance(marker, new ProvenanceLedger(ledgerPath, "run-1"), preterminal.sha256)).toThrow(/not an ancestor/)
})
