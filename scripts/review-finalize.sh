#!/usr/bin/env bash
# Validate Ultra review evidence and atomically attest that publication gates passed.
set -euo pipefail

ARTIFACT_DIR="${1:?usage: review-finalize.sh ARTIFACT_DIR TRUSTED_MANIFEST MARKER_FILE}"
TRUSTED_MANIFEST="${2:?usage: review-finalize.sh ARTIFACT_DIR TRUSTED_MANIFEST MARKER_FILE}"
MARKER_FILE="${3:?usage: review-finalize.sh ARTIFACT_DIR TRUSTED_MANIFEST MARKER_FILE}"

fail() { printf '[review-finalize] %s\n' "$*" >&2; exit 1; }
regular_file() {
  [[ -f "$1" && ! -L "$1" ]] || fail "missing or unsafe regular file: $1"
}

regular_file "$TRUSTED_MANIFEST"
for name in manifest.json coverage.json candidate-ledger.json verification-ledger.json final-report.md; do
  regular_file "${ARTIFACT_DIR}/${name}"
done

trusted_head=$(jq -er 'select(.complete == true) | .pull_request.head_sha | select(test("^[0-9a-fA-F]{40}$"))' "$TRUSTED_MANIFEST") \
  || fail "trusted manifest is incomplete or has no valid head SHA"
trusted_base=$(jq -er '.pull_request.base_sha | select(test("^[0-9a-fA-F]{40}$"))' "$TRUSTED_MANIFEST") \
  || fail "trusted manifest has no valid base SHA"
trusted_merge_base=$(jq -er '.pull_request.merge_base_sha | select(test("^[0-9a-fA-F]{40}$"))' "$TRUSTED_MANIFEST") \
  || fail "trusted manifest has no valid merge-base SHA"
trusted_hash=$(sha256sum "$TRUSTED_MANIFEST" | awk '{print $1}')
patch_path=$(jq -er '.patch.path | strings | select(length > 0)' "$TRUSTED_MANIFEST") || fail "trusted manifest has no patch path"
regular_file "$patch_path"
patch_hash=$(sha256sum "$patch_path" | awk '{print $1}')
jq -e --arg hash "$patch_hash" '.patch.sha256 == $hash' "$TRUSTED_MANIFEST" >/dev/null \
  || fail "trusted patch hash no longer matches the manifest"

jq -e \
  --arg hash "$trusted_hash" --arg base "$trusted_base" --arg head "$trusted_head" --arg merge "$trusted_merge_base" '
  .schema_version == 1 and
  .trusted_manifest_sha256 == $hash and
  .base_sha == $base and .head_sha == $head and .merge_base_sha == $merge and
  (.review_shards | type == "array" and length > 0) and
  (.environment_blockers | type == "array")
' "${ARTIFACT_DIR}/manifest.json" >/dev/null || fail "manifest.json does not bind the trusted revisions and review plan"

jq -e '
  .schema_version == 1 and
  (.entries | type == "array") and
  (.gap_sweeps | type == "array" and length >= 3) and
  (.gap_sweeps[-3:] | all(
    (.new_candidate_ids | type == "array" and length == 0) and
    (.coverage_gaps | type == "array" and length == 0))) and
  (.consecutive_dry_rounds | type == "number" and . >= 3) and
  (.completeness_panel.uncovered_dimensions | type == "array" and length == 0) and
  (.limitations | type == "array") and
  (.entries | all(
    (.file | type == "string" and length > 0) and
    (.hunk | type == "string" and length > 0) and
    (.correctness_passes | type == "array" and (unique | length) >= 5) and
    (([.correctness_passes[] | select(type != "string" or length == 0)] | length) == 0) and
    (.dimensions | type == "array" and length > 0)))
' "${ARTIFACT_DIR}/coverage.json" >/dev/null || fail "coverage.json does not satisfy pass, gap-sweep, or completeness gates"

expected=$(mktemp)
actual=$(mktemp)
trap 'rm -f "$expected" "$actual" "${MARKER_FILE}.tmp"' EXIT
jq -r '.files[] | .path as $p | if (.hunk_headers | length) == 0 then [$p, "(non-textual-change)"] | @tsv else .hunk_headers[] | [$p, .] | @tsv end' "$TRUSTED_MANIFEST" | sort -u > "$expected"
jq -r '.entries[] | [.file, .hunk] | @tsv' "${ARTIFACT_DIR}/coverage.json" | sort -u > "$actual"
comm -23 "$expected" "$actual" | grep -q . && fail "coverage.json omits one or more trusted changed file/hunk entries"

jq -e '
  .schema_version == 1 and (.candidates | type == "array") and
  (([.candidates[].candidate_id] | length) == ([.candidates[].candidate_id] | unique | length)) and
  (([.candidates[].root_cause_key] | length) == ([.candidates[].root_cause_key] | unique | length)) and
  (.candidates | all(
    (.candidate_id | type == "string" and length > 0) and
    (.root_cause_key | type == "string" and length > 0) and
    (.severity_guess | IN("P0", "P1", "P2", "P3"))))
' "${ARTIFACT_DIR}/candidate-ledger.json" >/dev/null || fail "candidate-ledger.json has duplicate or invalid candidate identities"

jq -e --slurpfile candidates "${ARTIFACT_DIR}/candidate-ledger.json" '
  def terminal: IN("CONFIRMED_REPRODUCED", "CONFIRMED_STATIC", "HIGH_RISK_UNRESOLVED", "PRE_EXISTING_UNCHANGED", "REFUTED", "OUT_OF_SCOPE");
  .schema_version == 1 and (.verifications | type == "array") and
  (([.verifications[].candidate_id] | length) == ([.verifications[].candidate_id] | unique | length)) and
  ([.verifications[].candidate_id] | sort) == ([$candidates[0].candidates[].candidate_id] | sort) and
  (.verifications | all(
    (.verdict | terminal) and
    (.severity | IN("P0", "P1", "P2", "P3")) and
    (.confidence | type == "number" and . >= 0 and . <= 1) and
    (.verifier_roles | type == "array" and (unique | length) >= 4) and
    (([.verifier_roles[] | select(type != "string" or length == 0)] | length) == 0) and
    (if (.severity == "P0" or .severity == "P1") then (.verifier_roles | unique | length) >= 7 else true end) and
    (.diff_causality | IN("introduced", "exposed", "worsened", "failed-fix", "pre-existing", "unrelated")) and
    (.reproduction.attempted | type == "boolean") and
    (if .reproduction.attempted then
       (.reproduction.head_result | type == "string" and length > 0) and
       (.reproduction.base_result | type == "string" and length > 0)
     else (.blockers | type == "array" and length > 0) end) and
    (if (.verdict == "CONFIRMED_REPRODUCED" or .verdict == "CONFIRMED_STATIC") then
       (.location.file | type == "string" and length > 0) and
       (.location.line | type == "number" and . > 0) and
       (.trigger | type == "string" and length > 0) and
       (.execution_trace | type == "array" and length > 0) and
       (.observable_failure | type == "string" and length > 0)
     else true end) and
    (if .verdict == "HIGH_RISK_UNRESOLVED" then (.blockers | type == "array" and length > 0) else true end)))
' "${ARTIFACT_DIR}/verification-ledger.json" >/dev/null || fail "verification-ledger.json does not give every candidate one valid terminal verdict"

for heading in '# Code Review Result' '## Scope' '## Verification summary' '## Verified findings' '## High-risk unresolved candidates' '## Coverage and limitations' '## Refutation ledger'; do
  grep -Fqx "$heading" "${ARTIFACT_DIR}/final-report.md" || fail "final-report.md is missing heading: $heading"
done

mkdir -p "$(dirname "$MARKER_FILE")"
jq -n \
  --arg head_sha "$trusted_head" \
  --arg trusted_manifest_sha256 "$trusted_hash" \
  --arg manifest_sha256 "$(sha256sum "${ARTIFACT_DIR}/manifest.json" | awk '{print $1}')" \
  --arg coverage_sha256 "$(sha256sum "${ARTIFACT_DIR}/coverage.json" | awk '{print $1}')" \
  --arg candidates_sha256 "$(sha256sum "${ARTIFACT_DIR}/candidate-ledger.json" | awk '{print $1}')" \
  --arg verification_sha256 "$(sha256sum "${ARTIFACT_DIR}/verification-ledger.json" | awk '{print $1}')" \
  --arg report_sha256 "$(sha256sum "${ARTIFACT_DIR}/final-report.md" | awk '{print $1}')" \
  --arg finalized_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  {schema_version: 1, valid: true, head_sha: $head_sha,
   trusted_manifest_sha256: $trusted_manifest_sha256,
   artifacts: {manifest: $manifest_sha256, coverage: $coverage_sha256,
     candidates: $candidates_sha256, verification: $verification_sha256,
     report: $report_sha256}, finalized_at: $finalized_at}
' > "${MARKER_FILE}.tmp"
mv "${MARKER_FILE}.tmp" "$MARKER_FILE"
printf '[review-finalize] validated head=%s\n' "$trusted_head"
