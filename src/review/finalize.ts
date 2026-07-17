// Ultra-review finalizer gate, ported from `.github/cchp-bot/review-finalize.sh`.
// Validates the review evidence bundle and, only if every gate passes, atomically
// attests that publication may proceed. This is the trust boundary between "an
// agent wrote some files" and "a complete, verified ultrareview happened": the
// gate re-binds the reviewer artifacts to the trusted review manifest (base/head/
// merge-base SHAs + patch hash), proves coverage of every trusted changed
// file/hunk, and enforces the candidate → verification terminal-verdict contract.
// Any failure throws (the bash `fail` → `exit 1`); nothing partial is attested.
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ARTIFACTS, ARTIFACT_SCHEMA_VERSION } from "../types"

const SHA40 = /^[0-9a-fA-F]{40}$/
const P_SEVERITY = new Set(["P0", "P1", "P2", "P3"])
const TERMINAL_VERDICTS = new Set([
  "CONFIRMED_REPRODUCED", "CONFIRMED_STATIC", "HIGH_RISK_UNRESOLVED",
  "PRE_EXISTING_UNCHANGED", "REFUTED", "OUT_OF_SCOPE",
])
const DIFF_CAUSALITY = new Set(["introduced", "exposed", "worsened", "failed-fix", "pre-existing", "unrelated"])
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
  head_sha: string
  trusted_manifest_sha256: string
  artifacts: {
    manifest: string
    coverage: string
    candidates: string
    verification: string
    report: string
  }
  finalized_at: string
}

/** Thrown for any gate failure — carries the same `[review-finalize] …` phrasing
 *  the bash printed to stderr before `exit 1`. */
export class FinalizeError extends Error {}

function fail(message: string): never {
  throw new FinalizeError(`[review-finalize] ${message}`)
}

// ── small predicate helpers (mirror the jq type/length checks) ───────────────

const isArr = Array.isArray as (v: unknown) => v is unknown[]
const nonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.length > 0
const isNum = (v: unknown): v is number => typeof v === "number" && !Number.isNaN(v)
const uniqueLen = (a: readonly unknown[]): number => new Set(a).size
const asRec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {})

/** `-f "$1" && ! -L "$1"` — a plain regular file, never a symlink. */
function regularFile(path: string): void {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    fail(`missing or unsafe regular file: ${path}`)
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`missing or unsafe regular file: ${path}`)
}

const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex")

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (e) {
    return fail(`cannot parse JSON (${path}): ${(e as Error).message}`)
  }
}

/** All elements are non-empty strings (jq `[…| select(type != "string" or length == 0)] | length == 0`). */
const allNonEmptyStrings = (a: readonly unknown[]): boolean => a.every(nonEmptyStr)

// ── the gate ─────────────────────────────────────────────────────────────────

/** Run the full finalizer gate over the artifact bundle and, on success, write +
 *  return the attestation marker. `markerFile` defaults to
 *  `<artifactDir>/review-finalized.json` (`ARTIFACTS.finalized`). Throws
 *  `FinalizeError` on the first failed gate — fail-closed, nothing attested. */
export function finalizeReview(
  artifactDir: string,
  trustedManifest: string,
  markerFile: string = join(artifactDir, ARTIFACTS.finalized),
): FinalizedMarker {
  const artifact = (name: string): string => join(artifactDir, name)

  // Every required file must be a real regular file (no symlink smuggling).
  regularFile(trustedManifest)
  for (const name of [
    ARTIFACTS.manifest,
    ARTIFACTS.coverage,
    ARTIFACTS.candidateLedger,
    ARTIFACTS.verificationLedger,
    ARTIFACTS.finalReport,
  ]) {
    regularFile(artifact(name))
  }

  // ── trusted manifest bindings ──────────────────────────────────────────────
  const tm = asRec(readJson(trustedManifest))
  const tmPr = asRec(tm.pull_request)
  const trustedHead = String(tmPr.head_sha ?? "")
  if (tm.complete !== true || !SHA40.test(trustedHead)) fail("trusted manifest is incomplete or has no valid head SHA")
  const trustedBase = String(tmPr.base_sha ?? "")
  if (!SHA40.test(trustedBase)) fail("trusted manifest has no valid base SHA")
  const trustedMergeBase = String(tmPr.merge_base_sha ?? "")
  if (!SHA40.test(trustedMergeBase)) fail("trusted manifest has no valid merge-base SHA")
  const trustedHash = sha256File(trustedManifest)

  const tmPatch = asRec(tm.patch)
  const patchPath = tmPatch.path
  if (!nonEmptyStr(patchPath)) fail("trusted manifest has no patch path")
  regularFile(patchPath)
  if (tmPatch.sha256 !== sha256File(patchPath)) fail("trusted patch hash no longer matches the manifest")

  // ── manifest.json binds the trusted revisions + a non-empty review plan ────
  const mf = asRec(readJson(artifact(ARTIFACTS.manifest)))
  if (
    !(
      mf.schema_version === ARTIFACT_SCHEMA_VERSION &&
      mf.trusted_manifest_sha256 === trustedHash &&
      mf.base_sha === trustedBase &&
      mf.head_sha === trustedHead &&
      mf.merge_base_sha === trustedMergeBase &&
      isArr(mf.review_shards) &&
      mf.review_shards.length > 0 &&
      isArr(mf.environment_blockers)
    )
  ) {
    fail("manifest.json does not bind the trusted revisions and review plan")
  }

  // ── coverage.json: passes, gap sweeps, completeness ────────────────────────
  const cov = asRec(readJson(artifact(ARTIFACTS.coverage)))
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
        isArr(r.dimensions) &&
        r.dimensions.length > 0
      )
    })
  if (!covOk) fail("coverage.json does not satisfy pass, gap-sweep, or completeness gates")

  // ── coverage covers every trusted changed file/hunk ────────────────────────
  const expected = new Set<string>()
  for (const f of isArr(tm.files) ? tm.files : []) {
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

  // ── candidate-ledger.json: unique identities ───────────────────────────────
  const cand = asRec(readJson(artifact(ARTIFACTS.candidateLedger)))
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
  const ver = asRec(readJson(artifact(ARTIFACTS.verificationLedger)))
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
      if (!(isArr(r.verifier_roles) && uniqueLen(r.verifier_roles) >= 4 && allNonEmptyStrings(r.verifier_roles))) return false
      if ((r.severity === "P0" || r.severity === "P1") && uniqueLen(r.verifier_roles as unknown[]) < 7) return false
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
        if (!(isNum(loc.line) && loc.line > 0)) return false
        if (!nonEmptyStr(r.trigger)) return false
        if (!(isArr(r.execution_trace) && r.execution_trace.length > 0)) return false
        if (!nonEmptyStr(r.observable_failure)) return false
      }
      if (r.verdict === "HIGH_RISK_UNRESOLVED" && !(isArr(r.blockers) && r.blockers.length > 0)) return false
      return true
    })
  if (!verOk) fail("verification-ledger.json does not give every candidate one valid terminal verdict")

  // ── final-report.md carries every required heading ─────────────────────────
  const reportLines = new Set(readFileSync(artifact(ARTIFACTS.finalReport), "utf8").split("\n"))
  for (const heading of REPORT_HEADINGS) {
    if (!reportLines.has(heading)) fail(`final-report.md is missing heading: ${heading}`)
  }

  // ── attest ─────────────────────────────────────────────────────────────────
  const marker: FinalizedMarker = {
    schema_version: ARTIFACT_SCHEMA_VERSION,
    valid: true,
    head_sha: trustedHead,
    trusted_manifest_sha256: trustedHash,
    artifacts: {
      manifest: sha256File(artifact(ARTIFACTS.manifest)),
      coverage: sha256File(artifact(ARTIFACTS.coverage)),
      candidates: sha256File(artifact(ARTIFACTS.candidateLedger)),
      verification: sha256File(artifact(ARTIFACTS.verificationLedger)),
      report: sha256File(artifact(ARTIFACTS.finalReport)),
    },
    finalized_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  }
  const tmp = `${markerFile}.tmp`
  writeFileSync(tmp, JSON.stringify(marker))
  renameSync(tmp, markerFile)
  return marker
}
