// Ultra-review finalizer gate, preserving the pre-cutover shell gate's evidence contract.
// Validates the review evidence bundle and, only if every gate passes, atomically
// attests that publication may proceed. This is the trust boundary between "an
// agent wrote some files" and "a complete, verified ultrareview happened": the
// gate re-binds the reviewer artifacts to the trusted review manifest (base/head/
// merge-base SHAs + patch hash), proves coverage of every trusted changed
// file/hunk, and enforces the candidate → verification terminal-verdict contract.
// Any failure throws (the bash `fail` → `exit 1`); nothing partial is attested.
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { ARTIFACTS, ARTIFACT_SCHEMA_VERSION } from "../types"
import { directoryIdentity, durableCreateFile } from "../codex/durable-file"
import { ReviewAdmissionLedger } from "../codex/review-admission"
import { openRegularFileSnapshot, type FileSnapshot } from "../codex/file-snapshot"
import { parseJsonl } from "../codex/jsonl"
import type { ProvenanceLedger } from "../codex/provenance"

const SHA40 = /^[0-9a-fA-F]{40}$/
const P_SEVERITY = new Set(["P0", "P1", "P2", "P3"])
const TERMINAL_VERDICTS = new Set([
  "CONFIRMED_REPRODUCED", "CONFIRMED_STATIC", "HIGH_RISK_UNRESOLVED",
  "PRE_EXISTING_UNCHANGED", "REFUTED", "OUT_OF_SCOPE",
])
const DIFF_CAUSALITY = new Set(["introduced", "exposed", "worsened", "failed-fix", "pre-existing", "unrelated"])
const VERIFICATION_PASS_KINDS = new Set(["verifier", "refuter", "reproducer", "adjudicator"])
const REQUIRED_VERIFICATION_PASS_KINDS = ["verifier", "refuter", "reproducer", "adjudicator"] as const
// grep -Fqx: each heading must appear as a verbatim full line.
const REPORT_HEADINGS = [
  "# Code Review Result",
  "## Scope",
  "## Verification summary",
  "## Verified findings",
  "## High-risk unresolved candidates",
  "## Coverage and limitations",
  "## Refutation ledger",
]

/** The attestation written when every gate passes (the bash marker JSON). */
export interface FinalizedMarker {
  schema_version: number
  valid: true
  repository: string
  pr_number: number
  run_id: string
  provenance_sha256: string
  head_sha: string
  trusted_manifest_sha256: string
  patch_sha256: string
  artifacts: {
    manifest: string
    coverage: string
    candidates: string
    verification: string
    report: string
    admission_ledger: string
    review_results: string
  }
  finalized_at: string
}

export interface FinalizeContext {
  repository: string
  prNumber: number
  runId: string
  provenanceSha256: string
  admissionLedgerPath?: string
}

export interface FinalizeDependencies {
  snapshotFile?: (path: string) => FileSnapshot
}

/** Thrown for any gate failure — carries the same `[review-finalize] …` phrasing
 *  the bash printed to stderr before `exit 1`. */
export class FinalizeError extends Error {}

function fail(message: string): never {
  throw new FinalizeError(`[review-finalize] ${message}`)
}

/** Keep an already-published review marker bound to its original evidence
 * provenance while proving that hash is still an ancestor of the current
 * append-only run ledger. A fresh finalization binds to the supplied fallback. */
export function selectFinalizerProvenance(
  markerFile: string,
  provenance: ProvenanceLedger,
  fallbackSha256: string,
): string {
  if (!provenance.has(fallbackSha256)) fail("preterminal provenance is not part of the current run ledger")
  if (!existsSync(markerFile)) return fallbackSha256
  let existing: Record<string, unknown>
  try {
    existing = readJson(openRegularFileSnapshot(markerFile)) as Record<string, unknown>
  } catch {
    return fail("existing finalizer marker is invalid or unsafe")
  }
  const frozen = existing.provenance_sha256
  if (typeof frozen !== "string" || !provenance.has(frozen)) {
    fail("existing finalizer marker provenance is not an ancestor of the current run")
  }
  return frozen
}

// ── small predicate helpers (mirror the jq type/length checks) ───────────────

const isArr = Array.isArray as (v: unknown) => v is unknown[]
const nonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.length > 0
const isNum = (v: unknown): v is number => typeof v === "number" && !Number.isNaN(v)
const isNonNegativeInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const uniqueLen = (a: readonly unknown[]): number => new Set(a).size
const asRec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {})

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex")

function readJson(snapshot: FileSnapshot): unknown {
  try {
    return JSON.parse(snapshot.bytes.toString("utf8"))
  } catch {
    return fail(`cannot parse JSON (${snapshot.path})`)
  }
}

function readJsonOutput(value: string, taskId: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    fail(`review result output for ${taskId} is not valid JSON`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`review result output for ${taskId} is not a JSON object`)
  }
  return parsed as Record<string, unknown>
}

/** All elements are non-empty strings (jq `[…| select(type != "string" or length == 0)] | length == 0`). */
const allNonEmptyStrings = (a: readonly unknown[]): boolean => a.every(nonEmptyStr)

function candidateLine(candidate: Record<string, unknown>, verification: Record<string, unknown>): string {
  return [
    `candidate_id=${JSON.stringify(String(candidate.candidate_id))}`,
    `severity=${JSON.stringify(String(verification.severity))}`,
    `verdict=${JSON.stringify(String(verification.verdict))}`,
    `confidence=${JSON.stringify(verification.confidence)}`,
    `diff_causality=${JSON.stringify(String(verification.diff_causality))}`,
    `root_cause_key=${JSON.stringify(String(candidate.root_cause_key))}`,
  ].join("; ")
}

function candidateDetails(verification: Record<string, unknown>): string[] {
  const lines: string[] = []
  if (verification.verdict === "CONFIRMED_REPRODUCED" || verification.verdict === "CONFIRMED_STATIC") {
    const location = asRec(verification.location)
    const canonicalLocation: Record<string, unknown> = {
      file: location.file,
      line: location.line,
      side: location.side ?? "RIGHT",
    }
    if (location.start_line != null) canonicalLocation.start_line = location.start_line
    if (location.start_side != null) canonicalLocation.start_side = location.start_side
    lines.push(`  - Location: ${JSON.stringify(canonicalLocation)}`)
    lines.push(`  - Trigger: ${JSON.stringify(verification.trigger)}`)
    lines.push(`  - Observable failure: ${JSON.stringify(verification.observable_failure)}`)
    lines.push(`  - Execution trace: ${JSON.stringify(verification.execution_trace)}`)
  }
  if (isArr(verification.blockers) && verification.blockers.length > 0) {
    lines.push(`  - Blockers: ${JSON.stringify(verification.blockers)}`)
  }
  return lines
}

function renderCandidateSection(
  candidatesById: ReadonlyMap<string, Record<string, unknown>>,
  verifications: readonly Record<string, unknown>[],
): string[] {
  if (verifications.length === 0) return ["- None."]
  const lines: string[] = []
  for (const verification of [...verifications].sort((left, right) => String(left.candidate_id).localeCompare(String(right.candidate_id)))) {
    const candidate = candidatesById.get(String(verification.candidate_id))!
    lines.push(`- ${candidateLine(candidate, verification)}`, ...candidateDetails(verification))
  }
  return lines
}

function renderCanonicalReviewReport(input: {
  context: FinalizeContext
  trustedBase: string
  trustedHead: string
  trustedMergeBase: string
  trustedFiles: readonly unknown[]
  trustedPairs: number
  coverageEntries: readonly unknown[]
  limitations: readonly unknown[]
  candidates: readonly unknown[]
  verifications: readonly unknown[]
  admittedTasks: number
}): string {
  const candidateRecords = input.candidates.map(asRec)
  const verificationRecords = input.verifications.map(asRec)
  const candidatesById = new Map(candidateRecords.map((candidate) => [String(candidate.candidate_id), candidate]))
  const confirmed = verificationRecords.filter((verification) => verification.verdict === "CONFIRMED_REPRODUCED" || verification.verdict === "CONFIRMED_STATIC")
  const unresolved = verificationRecords.filter((verification) => verification.verdict === "HIGH_RISK_UNRESOLVED")
  const refuted = verificationRecords.filter((verification) => !confirmed.includes(verification) && !unresolved.includes(verification))
  const verdictCounts = Object.fromEntries([...new Set(verificationRecords.map((verification) => String(verification.verdict)))]
    .sort()
    .map((verdict) => [verdict, verificationRecords.filter((verification) => verification.verdict === verdict).length]))
  const coverageDimensions = [...new Set(input.coverageEntries.flatMap((entry) => {
    const dimensions = asRec(entry).dimensions
    return isArr(dimensions) ? dimensions.map(String) : []
  }))].sort()
  const correctnessTasks = new Set(input.coverageEntries.flatMap((entry) => {
    const taskIds = asRec(entry).correctness_task_ids
    return isArr(taskIds) ? taskIds.map(String) : []
  }))
  return [
    "# Code Review Result",
    "",
    "## Scope",
    `- Repository: ${JSON.stringify(input.context.repository)}`,
    `- Pull request: #${input.context.prNumber}`,
    `- Base SHA: ${input.trustedBase}`,
    `- Head SHA: ${input.trustedHead}`,
    `- Merge-base SHA: ${input.trustedMergeBase}`,
    `- Changed files: ${input.trustedFiles.length}`,
    `- Trusted file/hunk pairs: ${input.trustedPairs}`,
    "",
    "## Verification summary",
    `- Candidates: ${candidateRecords.length}`,
    `- Admitted completed tasks: ${input.admittedTasks}`,
    `- Verdict counts: ${JSON.stringify(verdictCounts)}`,
    "",
    "## Verified findings",
    ...renderCandidateSection(candidatesById, confirmed),
    "",
    "## High-risk unresolved candidates",
    ...renderCandidateSection(candidatesById, unresolved),
    "",
    "## Coverage and limitations",
    `- Covered file/hunk pairs: ${input.coverageEntries.length}/${input.trustedPairs}`,
    `- Correctness task references: ${correctnessTasks.size}`,
    `- Coverage dimensions: ${JSON.stringify(coverageDimensions)}`,
    `- Limitations: ${JSON.stringify(input.limitations)}`,
    "",
    "## Refutation ledger",
    ...renderCandidateSection(candidatesById, refuted),
    "",
  ].join("\n")
}

// ── the gate ─────────────────────────────────────────────────────────────────

/** Run the full finalizer gate over the artifact bundle and, on success, write +
 *  return the attestation marker. `markerFile` defaults to
 *  `<artifactDir>/review-finalized.json` (`ARTIFACTS.finalized`). Throws
 *  `FinalizeError` on the first failed gate — fail-closed, nothing attested. */
export function finalizeReview(
  artifactDir: string,
  trustedManifest: string,
  markerFile: string,
  context: FinalizeContext,
  dependencies: FinalizeDependencies = {},
): FinalizedMarker {
  if (!/^[^/\s]+\/[^/\s]+$/.test(context.repository)) fail("finalizer context has no valid repository")
  if (!Number.isSafeInteger(context.prNumber) || context.prNumber < 1) fail("finalizer context has no valid PR number")
  if (!context.runId) fail("finalizer context has no run id")
  if (!/^[0-9a-f]{64}$/.test(context.provenanceSha256)) fail("finalizer context has no valid provenance hash")
  let markerParent: ReturnType<typeof directoryIdentity>
  try {
    markerParent = directoryIdentity(dirname(markerFile))
  } catch {
    fail("finalizer marker parent is missing or unsafe")
  }
  const artifact = (name: string): string => join(artifactDir, name)
  const snapshot = (path: string): FileSnapshot => {
    try {
      return dependencies.snapshotFile?.(path) ?? openRegularFileSnapshot(path)
    } catch {
      return fail(`missing or unsafe regular file: ${path}`)
    }
  }

  if (!context.admissionLedgerPath) fail("review admission ledger is required")
  if (!existsSync(context.admissionLedgerPath)) fail(`review admission ledger is missing: ${context.admissionLedgerPath}`)
  const admissionLedgerSnapshot = snapshot(context.admissionLedgerPath)
  let admissionRows: unknown[]
  try {
    admissionRows = parseJsonl(admissionLedgerSnapshot.bytes, context.admissionLedgerPath)
  } catch {
    fail("review admission ledger is not valid JSONL")
  }
  const admissions = ReviewAdmissionLedger.fromSnapshot(admissionRows!, context.runId)
  try {
    admissions.assertFinalizable(true)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  const admissionEntries = admissions.entries()
  const admissionByTask = new Map(admissionEntries.map((entry) => [entry.taskId, entry]))
  const childIds = new Set<string>()
  const claimsByTask = new Map<string, Record<string, unknown>>()
  for (const entry of admissionEntries) {
    if (!entry.spawnItemId || !entry.childThreadId || !entry.terminalAt || !entry.result) {
      fail(`review admission ${entry.taskId} has no immutable spawn, child, terminal, or result binding`)
    }
    if (childIds.has(entry.childThreadId)) fail(`review admissions reuse child thread ${entry.childThreadId}`)
    childIds.add(entry.childThreadId)
    const resultSnapshot = snapshot(entry.result.artifactPath)
    if (resultSnapshot.sha256 !== entry.result.artifactSha256) fail(`review result artifact hash mismatch for ${entry.taskId}`)
    const result = asRec(readJson(resultSnapshot))
    if (result.runId !== context.runId || result.state !== "completed" || typeof result.output !== "string") {
      fail(`review result artifact identity/state mismatch for ${entry.taskId}`)
    }
    if (result.mode !== entry.mode) fail(`review result artifact mode drift for ${entry.taskId}`)
    if (entry.mode === "native_v2") {
      if (result.schemaVersion !== 2) fail(`review result artifact schema mismatch for ${entry.taskId}`)
      if (result.taskId !== entry.taskId || result.spawnItemId !== entry.spawnItemId || result.childThreadId !== entry.childThreadId || result.role !== entry.role || result.passKind !== entry.passKind) {
        fail(`review result artifact identity drift for ${entry.taskId}`)
      }
    } else if (entry.mode === "explicit_child") {
      if (result.schemaVersion !== 2 && result.schemaVersion !== 3) fail(`review result artifact schema mismatch for ${entry.taskId}`)
      if (result.childId !== entry.taskId || result.role !== entry.role || result.passKind !== entry.passKind || result.sessionId !== entry.childThreadId) {
        fail(`review result artifact identity drift for ${entry.taskId}`)
      }
    } else {
      fail(`review admission mode is unsupported for ${entry.taskId}`)
    }
    const output = result.output as string
    if (sha256(output) !== entry.result.outputSha256 || Buffer.byteLength(output) !== entry.result.outputBytes) fail(`review result output hash mismatch for ${entry.taskId}`)
    const parsedOutput = readJsonOutput(output, entry.taskId)
    claimsByTask.set(entry.taskId, asRec(parsedOutput.claims))
  }
  const admissionLedgerSha256 = admissionLedgerSnapshot.sha256
  const reviewResultsSha256 = sha256(JSON.stringify(admissionEntries.map((entry) => [entry.taskId, entry.result!.artifactSha256]).sort()))

  // Snapshot every required file once. All validation and attestation below use
  // these exact bytes, so pathname replacement cannot cross the trust boundary.
  const trustedManifestSnapshot = snapshot(trustedManifest)
  const artifactSnapshots = new Map<string, FileSnapshot>()
  for (const name of [
    ARTIFACTS.manifest,
    ARTIFACTS.coverage,
    ARTIFACTS.candidateLedger,
    ARTIFACTS.verificationLedger,
    ARTIFACTS.finalReport,
  ]) {
    artifactSnapshots.set(name, snapshot(artifact(name)))
  }
  const artifactSnapshot = (name: string): FileSnapshot => artifactSnapshots.get(name)!

  // ── trusted manifest bindings ──────────────────────────────────────────────
  const tm = asRec(readJson(trustedManifestSnapshot))
  const tmPr = asRec(tm.pull_request)
  const trustedHead = String(tmPr.head_sha ?? "")
  const trustedBase = String(tmPr.base_sha ?? "")
  const trustedMergeBase = String(tmPr.merge_base_sha ?? "")
  const tmTotals = asRec(tm.totals)
  const tmFiles = isArr(tm.files) ? tm.files : null
  const tmCommits = isArr(tm.commits) ? tm.commits : null
  const tmBlockers = isArr(tm.blockers) ? tm.blockers : null
  const filesValid = tmFiles !== null && tmFiles.length > 0 && tmFiles.every((file) => {
    const record = asRec(file)
    return nonEmptyStr(record.path) &&
      (record.previous_path === null || typeof record.previous_path === "string") &&
      nonEmptyStr(record.status) &&
      isNonNegativeInt(record.additions) &&
      isNonNegativeInt(record.deletions) &&
      isNonNegativeInt(record.changes) &&
      typeof record.patch_present === "boolean" &&
      isArr(record.hunk_headers) &&
      allNonEmptyStrings(record.hunk_headers) &&
      uniqueLen(record.hunk_headers) === record.hunk_headers.length
  })
  const commitsValid = tmCommits !== null && tmCommits.every((commit) => {
    const record = asRec(commit)
    return SHA40.test(String(record.sha ?? "")) && typeof record.message === "string"
  })
  const totalsValid = tmFiles !== null &&
    isNonNegativeInt(tmTotals.changed_files) && tmTotals.changed_files === tmFiles.length &&
    isNonNegativeInt(tmTotals.additions) && tmTotals.additions === tmFiles.reduce<number>((sum, file) => sum + Number(asRec(file).additions ?? 0), 0) &&
    isNonNegativeInt(tmTotals.deletions) && tmTotals.deletions === tmFiles.reduce<number>((sum, file) => sum + Number(asRec(file).deletions ?? 0), 0)
  if (!(tm.schema_version === ARTIFACT_SCHEMA_VERSION &&
    tm.complete === true &&
    tm.repository === context.repository &&
    tmPr.number === context.prNumber &&
    typeof tmPr.title === "string" &&
    typeof tmPr.url === "string" &&
    typeof tmPr.base_ref === "string" &&
    SHA40.test(trustedBase) &&
    typeof tmPr.head_ref === "string" &&
    SHA40.test(trustedHead) &&
    SHA40.test(trustedMergeBase) &&
    filesValid &&
    totalsValid &&
    commitsValid &&
    tmBlockers !== null && allNonEmptyStrings(tmBlockers) &&
    nonEmptyStr(tm.generated_at))) {
    fail("trusted manifest schema, identity, revisions, files, or totals do not match the finalizer context")
  }
  const trustedHash = trustedManifestSnapshot.sha256

  const tmPatch = asRec(tm.patch)
  const patchPath = tmPatch.path
  if (!nonEmptyStr(patchPath)) fail("trusted manifest has no patch path")
  const patchSnapshot = snapshot(patchPath)
  if (tmPatch.sha256 !== patchSnapshot.sha256) fail("trusted patch hash no longer matches the manifest")

  // ── manifest.json binds the trusted revisions + a non-empty review plan ────
  const mf = asRec(readJson(artifactSnapshot(ARTIFACTS.manifest)))
  const reviewShards = mf.review_shards
  const manifestTaskIds = mf.admitted_task_ids
  const admittedTaskIds = admissionEntries.map((entry) => entry.taskId).sort()
  if (!isArr(manifestTaskIds) || !allNonEmptyStrings(manifestTaskIds) || uniqueLen(manifestTaskIds) !== manifestTaskIds.length || JSON.stringify([...manifestTaskIds].sort()) !== JSON.stringify(admittedTaskIds)) {
    fail("manifest.json admitted_task_ids does not exactly match the admitted task set")
  }
  if (
    !(
      mf.schema_version === ARTIFACT_SCHEMA_VERSION &&
      mf.trusted_manifest_sha256 === trustedHash &&
      mf.base_sha === trustedBase &&
      mf.head_sha === trustedHead &&
      mf.merge_base_sha === trustedMergeBase &&
      isArr(mf.review_shards) &&
      mf.review_shards.length > 0 && allNonEmptyStrings(mf.review_shards) && uniqueLen(mf.review_shards) === mf.review_shards.length &&
      isArr(mf.environment_blockers)
    )
  ) {
    fail("manifest.json does not bind the trusted revisions and review plan")
  }

  // ── coverage.json: passes, gap sweeps, completeness ────────────────────────
  const cov = asRec(readJson(artifactSnapshot(ARTIFACTS.coverage)))
  const gapSweeps = cov.gap_sweeps
  const covEntries = cov.entries
  const covOk =
    cov.schema_version === ARTIFACT_SCHEMA_VERSION &&
    isArr(covEntries) &&
    isArr(gapSweeps) &&
    gapSweeps.length >= 3 &&
    gapSweeps.slice(-3).every((s) => {
      const r = asRec(s)
      return isArr(r.new_candidate_ids) && r.new_candidate_ids.length === 0 && isArr(r.coverage_gaps) && r.coverage_gaps.length === 0
    }) &&
    isNum(cov.consecutive_dry_rounds) &&
    cov.consecutive_dry_rounds >= 3 &&
    isArr(asRec(cov.completeness_panel).uncovered_dimensions) &&
    (asRec(cov.completeness_panel).uncovered_dimensions as unknown[]).length === 0 &&
    isArr(cov.limitations) &&
    covEntries.every((e) => {
      const r = asRec(e)
      return (
        nonEmptyStr(r.file) &&
        nonEmptyStr(r.hunk) &&
        isArr(r.correctness_passes) &&
        uniqueLen(r.correctness_passes) >= 5 &&
        allNonEmptyStrings(r.correctness_passes) &&
        isArr(r.correctness_task_ids) &&
        uniqueLen(r.correctness_task_ids) >= 5 &&
        allNonEmptyStrings(r.correctness_task_ids) &&
        (r.correctness_task_ids as string[]).every((taskId) => {
          const admission = admissionByTask.get(taskId)
          const claims = claimsByTask.get(taskId)
          const coverage = isArr(claims?.coverage) ? claims.coverage : []
          if (!admission || admission.passKind !== "correctness") fail(`coverage entry ${String(r.file)} ${String(r.hunk)} references non-correctness task ${taskId}`)
          if (!coverage.some((claim) => {
            const c = asRec(claim)
            return c.file === r.file && c.hunk === r.hunk
          })) fail("coverage.json omits one or more trusted changed file/hunk entries")
          return true
        }) &&
        isArr(r.dimensions) &&
        r.dimensions.length > 0
      )
    })
  if (!covOk) fail("coverage.json does not satisfy pass, gap-sweep, or completeness gates")

  // ── coverage covers every trusted changed file/hunk ────────────────────────
  const expected = new Set<string>()
  for (const f of tmFiles!) {
    const r = asRec(f)
    const path = String(r.path ?? "")
    const hunks = isArr(r.hunk_headers) ? r.hunk_headers : []
    if (hunks.length === 0) expected.add(`${path}\t(non-textual-change)`)
    else for (const h of hunks) expected.add(`${path}\t${String(h)}`)
  }
  const actual = new Set<string>()
  for (const e of covEntries as unknown[]) {
    const r = asRec(e)
    actual.add(`${String(r.file ?? "")}\t${String(r.hunk ?? "")}`)
  }
  for (const pair of expected) {
    if (!actual.has(pair)) fail("coverage.json omits one or more trusted changed file/hunk entries")
  }
  for (const pair of actual) {
    if (!expected.has(pair)) fail("coverage.json contains file/hunk entries outside the trusted manifest")
  }

  // ── candidate-ledger.json: unique identities ───────────────────────────────
  const cand = asRec(readJson(artifactSnapshot(ARTIFACTS.candidateLedger)))
  const candidates = isArr(cand.candidates) ? cand.candidates : null
  if (
    !(
      cand.schema_version === ARTIFACT_SCHEMA_VERSION &&
      candidates !== null &&
      uniqueLen(candidates.map((c) => asRec(c).candidate_id)) === candidates.length &&
      uniqueLen(candidates.map((c) => asRec(c).root_cause_key)) === candidates.length &&
      candidates.every((c) => {
        const r = asRec(c)
        return nonEmptyStr(r.candidate_id) && nonEmptyStr(r.root_cause_key) && P_SEVERITY.has(r.severity_guess as string)
      })
    )
  ) {
    fail("candidate-ledger.json has duplicate or invalid candidate identities")
  }

  // ── verification-ledger.json: one valid terminal verdict per candidate ─────
  const ver = asRec(readJson(artifactSnapshot(ARTIFACTS.verificationLedger)))
  const verifications = isArr(ver.verifications) ? ver.verifications : null
  const candidateIds = candidates!.map((c) => String(asRec(c).candidate_id)).sort()
  const verOk =
    ver.schema_version === ARTIFACT_SCHEMA_VERSION &&
    verifications !== null &&
    uniqueLen(verifications.map((v) => asRec(v).candidate_id)) === verifications.length &&
    JSON.stringify(verifications.map((v) => String(asRec(v).candidate_id)).sort()) === JSON.stringify(candidateIds) &&
    verifications.every((v) => {
      const r = asRec(v)
      if (!TERMINAL_VERDICTS.has(r.verdict as string)) return false
      if (!P_SEVERITY.has(r.severity as string)) return false
      if (!(isNum(r.confidence) && r.confidence >= 0 && r.confidence <= 1)) return false
      if (!(isArr(r.verifier_task_ids) && allNonEmptyStrings(r.verifier_task_ids) &&
        uniqueLen(r.verifier_task_ids) === r.verifier_task_ids.length && r.verifier_task_ids.length >= 4)) return false
      if ((r.severity === "P0" || r.severity === "P1") && r.verifier_task_ids.length < 7) return false
      const verifierAdmissions = (r.verifier_task_ids as string[]).map((taskId) => {
        const admission = admissionByTask.get(taskId)
        const claims = claimsByTask.get(taskId)
        const candidateIds = isArr(claims?.candidate_ids) ? claims.candidate_ids : []
        if (!admission || !VERIFICATION_PASS_KINDS.has(admission.passKind)) fail(`verification ${String(r.candidate_id)} references non-verifier task ${taskId}`)
        if (!candidateIds.includes(r.candidate_id)) fail(`verifier task ${taskId} does not claim candidate ${String(r.candidate_id)}`)
        return admission
      })
      const passKinds = new Set(verifierAdmissions.map((admission) => admission.passKind))
      if (!REQUIRED_VERIFICATION_PASS_KINDS.every((passKind) => passKinds.has(passKind))) {
        fail(`verification ${String(r.candidate_id)} is missing required verification pass-kind coverage`)
      }
      if ((r.severity === "P0" || r.severity === "P1") && verifierAdmissions.filter((admission) => admission.passKind === "refuter").length < 2) {
        fail(`verification ${String(r.candidate_id)} requires an additional refuter for P0/P1`)
      }
      const admittedRoles = verifierAdmissions.map((admission) => admission.role).sort()
      if (!(isArr(r.verifier_roles) && allNonEmptyStrings(r.verifier_roles) &&
        uniqueLen(r.verifier_roles) === r.verifier_roles.length &&
        JSON.stringify([...r.verifier_roles].sort()) === JSON.stringify(admittedRoles))) {
        fail(`verification ${String(r.candidate_id)} verifier_roles do not match admitted verifier roles`)
      }
      if (!DIFF_CAUSALITY.has(r.diff_causality as string)) return false
      const repro = asRec(r.reproduction)
      if (typeof repro.attempted !== "boolean") return false
      if (repro.attempted) {
        if (!(nonEmptyStr(repro.head_result) && nonEmptyStr(repro.base_result))) return false
      } else {
        if (!(isArr(r.blockers) && r.blockers.length > 0)) return false
      }
      if (r.verdict === "CONFIRMED_REPRODUCED" || r.verdict === "CONFIRMED_STATIC") {
        const loc = asRec(r.location)
        if (!nonEmptyStr(loc.file)) return false
        if (!(Number.isSafeInteger(loc.line) && (loc.line as number) > 0)) return false
        if (loc.side != null && loc.side !== "LEFT" && loc.side !== "RIGHT") return false
        if (loc.start_line != null && !(Number.isSafeInteger(loc.start_line) && (loc.start_line as number) > 0 && (loc.start_line as number) <= (loc.line as number))) return false
        if (loc.start_side != null && (loc.start_side !== "LEFT" && loc.start_side !== "RIGHT" || loc.start_line == null || loc.side == null || loc.start_side !== loc.side)) return false
        if (!nonEmptyStr(r.trigger)) return false
        if (!(isArr(r.execution_trace) && r.execution_trace.length > 0 && allNonEmptyStrings(r.execution_trace))) return false
        if (!nonEmptyStr(r.observable_failure)) return false
      }
      if (r.verdict === "HIGH_RISK_UNRESOLVED" && !(isArr(r.blockers) && r.blockers.length > 0)) return false
      return true
    })
  if (!verOk) fail("verification-ledger.json does not give every candidate one valid terminal verdict")

  // ── final-report.md carries every required heading ─────────────────────────
  const report = artifactSnapshot(ARTIFACTS.finalReport).bytes.toString("utf8")
  const reportLines = new Set(report.split("\n"))
  for (const heading of REPORT_HEADINGS) {
    if (!reportLines.has(heading)) fail(`final-report.md is missing heading: ${heading}`)
  }
  const canonicalReport = renderCanonicalReviewReport({
    context,
    trustedBase,
    trustedHead,
    trustedMergeBase,
    trustedFiles: tmFiles!,
    trustedPairs: expected.size,
    coverageEntries: covEntries as unknown[],
    limitations: cov.limitations as unknown[],
    candidates: candidates!,
    verifications: verifications!,
    admittedTasks: admissionEntries.length,
  })
  if (report !== canonicalReport) fail("final-report.md does not match canonical review evidence")

  // ── attest ─────────────────────────────────────────────────────────────────
  const marker: FinalizedMarker = {
    schema_version: ARTIFACT_SCHEMA_VERSION,
    valid: true,
    repository: context.repository,
    pr_number: context.prNumber,
    run_id: context.runId,
    provenance_sha256: context.provenanceSha256,
    head_sha: trustedHead,
    trusted_manifest_sha256: trustedHash,
    patch_sha256: patchSnapshot.sha256,
    artifacts: {
      manifest: artifactSnapshot(ARTIFACTS.manifest).sha256,
      coverage: artifactSnapshot(ARTIFACTS.coverage).sha256,
      candidates: artifactSnapshot(ARTIFACTS.candidateLedger).sha256,
      verification: artifactSnapshot(ARTIFACTS.verificationLedger).sha256,
      report: artifactSnapshot(ARTIFACTS.finalReport).sha256,
      admission_ledger: admissionLedgerSha256,
      review_results: reviewResultsSha256,
    },
    finalized_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  }
  if (existsSync(markerFile)) {
    const existing = asRec(readJson(snapshot(markerFile))) as unknown as FinalizedMarker
    const stable = ({ finalized_at: _ignored, ...value }: FinalizedMarker) => value
    if (JSON.stringify(stable(existing)) !== JSON.stringify(stable(marker))) {
      fail("existing finalizer marker does not match the current run and artifacts")
    }
    return existing
  }
  try {
    durableCreateFile(markerFile, `${JSON.stringify(marker)}\n`, 0o600, markerParent!)
  } catch {
    fail("finalizer marker path changed or already exists during attestation")
  }
  return marker
}
