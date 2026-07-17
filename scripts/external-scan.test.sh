#!/usr/bin/env bash
# Self-contained offline tests for external-scan.sh: fake gh/git/semgrep/codeql
# shims on PATH (same technique as compact-prompt.test.sh), no network, no real
# scanners. Any non-zero exit of this script is a test failure.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCAN_SH="${SCRIPT_DIR}/external-scan.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# ── Static checks on the script source ────────────────────────────────────────
bash -n "$SCAN_SH"
grep -Fq 'e5b5a42ec061854378c11e0d01f19250b52bc2e9' "$SCAN_SH" || fail "semgrep rules commit pin missing"
grep -Eq 'BOT_CODEQL_VERSION:-v[0-9]+\.[0-9]+\.[0-9]+' "$SCAN_SH" || fail "codeql bundle version pin missing"
grep -Fq 'semgrep==${SEMGREP_VERSION}' "$SCAN_SH" || fail "pinned semgrep version fallback missing"
grep -Fq 'BOT_SEMGREP_VERSION:-1.169.0' "$SCAN_SH" || fail "semgrep version pin missing"
grep -Fq 'codeql-bundle-linux64.tar.gz' "$SCAN_SH" || fail "codeql bundle asset name missing"
grep -Fq 'refs/pull/${BOT_PR_NUMBER}/head' "$SCAN_SH" || fail "base-repo pull head ref fetch missing"
grep -Fq 'timeout 900' "$SCAN_SH" || fail "semgrep outer timeout missing"
grep -Fq 'timeout 1500' "$SCAN_SH" || fail "codeql outer timeout missing"
grep -Fq -- '--build-mode=none' "$SCAN_SH" || fail "JS extraction must not build"
grep -Fq 'javascript-code-scanning.qls' "$SCAN_SH" || fail "JS suite missing"
grep -Fq 'go-code-scanning.qls' "$SCAN_SH" || fail "Go suite missing"
grep -Fq 'GOEXPERIMENT=jsonv2' "$SCAN_SH" || fail "Go build needs GOEXPERIMENT=jsonv2"
if grep -Eq -- '--config[= ]auto' "$SCAN_SH"; then fail "forbidden: remote auto rule config"; fi
if grep -Fq -- '--allow-local-builds' "$SCAN_SH"; then fail "forbidden semgrep flag present"; fi
if grep -Fq -- '--autofix' "$SCAN_SH"; then fail "forbidden semgrep flag present"; fi

# ── Fixtures ──────────────────────────────────────────────────────────────────
TEST_SHA="0123456789abcdef0123456789abcdef01234567"
OTHER_SHA="fedcba9876543210fedcba9876543210fedcba98"
TEST_RULES_COMMIT="cccccccccccccccccccccccccccccccccccccccc"
TEST_CODEQL_VERSION="v0.0.0-test"

fixtures="${tmp}/fixtures"
mkdir -p "$fixtures"

cat > "${fixtures}/semgrep.json" <<'EOF'
{
  "results": [
    {
      "check_id": "go.lang.security.audit.dangerous-exec-command",
      "path": "pkg/a.go",
      "start": {"line": 10, "col": 2},
      "end": {"line": 12, "col": 5},
      "extra": {"severity": "ERROR", "message": "dangerous exec"}
    },
    {
      "check_id": "go.lang.correctness.unchecked-error",
      "path": "pkg/other.go",
      "start": {"line": 3},
      "end": {"line": 3},
      "extra": {"severity": "WARNING", "message": "unchecked error outside diff"}
    }
  ],
  "errors": []
}
EOF

cat > "${fixtures}/codeql-js.sarif" <<'EOF'
{
  "version": "2.1.0",
  "runs": [
    {
      "tool": {"driver": {"name": "CodeQL"}},
      "results": [
        {
          "ruleId": "js/xss",
          "level": "error",
          "message": {"text": "possible xss"},
          "locations": [{"physicalLocation": {"artifactLocation": {"uri": "web/src/b.ts"}, "region": {"startLine": 5, "endLine": 6}}}]
        },
        {
          "ruleId": "js/unused-local-variable",
          "level": "note",
          "message": {"text": "unused variable outside diff"},
          "locations": [{"physicalLocation": {"artifactLocation": {"uri": "web/src/nope.ts"}, "region": {"startLine": 1}}}]
        }
      ]
    }
  ]
}
EOF

cat > "${fixtures}/codeql-go.sarif" <<'EOF'
{
  "version": "2.1.0",
  "runs": [
    {
      "tool": {"driver": {"name": "CodeQL"}},
      "results": [
        {
          "ruleId": "go/sql-injection",
          "level": "warning",
          "message": {"text": "possible sql injection"},
          "locations": [{"physicalLocation": {"artifactLocation": {"uri": "pkg/a.go"}, "region": {"startLine": 20}}}]
        }
      ]
    }
  ]
}
EOF

# ── Fake binaries ─────────────────────────────────────────────────────────────
shim="${tmp}/shim"
mkdir -p "$shim"

cat > "${shim}/git" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'git %s\n' "$*" >> "${FAKE_GIT_LOG:-/dev/null}"
dir=""
if [[ "${1:-}" == "-C" ]]; then dir="$2"; shift 2; fi
cmd="${1:-}"; shift || true
case "$cmd" in
  clone)
    dest="${*: -1}"
    mkdir -p "${dest}/.git"
    ;;
  checkout)
    if [[ "${FAKE_GIT_CHECKOUT_FAIL:-0}" == "1" ]]; then exit 128; fi
    if [[ -n "${FAKE_GIT_CREATE_FILES:-}" && -n "$dir" ]]; then
      IFS=':' read -r -a files <<< "${FAKE_GIT_CREATE_FILES}"
      for f in "${files[@]}"; do
        mkdir -p "${dir}/$(dirname "$f")"
        printf 'scan head content\n' > "${dir}/${f}"
      done
    fi
    ;;
  rev-parse)
    printf '%s\n' "${FAKE_GIT_HEAD_SHA:?}"
    ;;
  fetch|remote|submodule|config) : ;;
  *) : ;;
esac
MOCK
chmod +x "${shim}/git"

cat > "${shim}/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
joined="$*"
printf 'gh %s\n' "${joined}" >> "${FAKE_GH_LOG:-/dev/null}"
case "${joined}" in
  "api --paginate repos/example/repo/pulls/7/files?per_page=100 --jq .[].filename")
    printf 'pkg/a.go\nweb/src/b.ts\n' ;;
  "release download"*)
    exit 1 ;;
  *)
    printf 'unexpected mock gh invocation: %s\n' "${joined}" >&2
    exit 9 ;;
esac
MOCK
chmod +x "${shim}/gh"

cat > "${shim}/semgrep" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'semgrep %s\n' "$*" >> "${FAKE_SEMGREP_LOG:-/dev/null}"
if [[ "${FAKE_SEMGREP_MODE:-ok}" == "crash" ]]; then
  echo "semgrep: mock crash" >&2
  exit 2
fi
out_json=""
out_sarif=""
prev=""
for a in "$@"; do
  case "$prev" in
    --json-output) out_json="$a" ;;
    --sarif-output) out_sarif="$a" ;;
  esac
  prev="$a"
done
if [[ -n "$out_json" ]]; then cat "${FAKE_SEMGREP_JSON:?}" > "$out_json"; fi
if [[ -n "$out_sarif" ]]; then printf '{"version":"2.1.0","runs":[]}\n' > "$out_sarif"; fi
exit 0
MOCK
chmod +x "${shim}/semgrep"

# `go` only needs to exist for the toolchain probe; codeql is faked and never
# actually runs the build command.
cat > "${shim}/go" <<'MOCK'
#!/usr/bin/env bash
printf 'go version go0.0-test linux/amd64\n'
MOCK
chmod +x "${shim}/go"

# The codeql fake is installed at the pinned cache path per test case (the
# script resolves it by absolute path, not PATH).
cat > "${shim}/codeql-impl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'codeql %s\n' "$*" >> "${FAKE_CODEQL_LOG:-/dev/null}"
sub="${1:-} ${2:-}"
case "$sub" in
  "database create")
    if [[ "${FAKE_CODEQL_CREATE_FAIL:-0}" == "1" ]]; then exit 32; fi
    mkdir -p "$3"
    ;;
  "database analyze")
    out=""
    lang=""
    prev=""
    for a in "$@"; do
      if [[ "$prev" == "--output" ]]; then out="$a"; fi
      case "$a" in
        *javascript*) lang=js ;;
        *go-queries*) lang=go ;;
      esac
      prev="$a"
    done
    if [[ "$lang" == "js" ]]; then
      cat "${FAKE_CODEQL_SARIF_JS:?}" > "$out"
    else
      cat "${FAKE_CODEQL_SARIF_GO:?}" > "$out"
    fi
    ;;
  *) : ;;
esac
MOCK
chmod +x "${shim}/codeql-impl"

# ── Case scaffolding ──────────────────────────────────────────────────────────
CASE=""; WORK=""; HOME_DIR=""

new_case() { # $1=name
  CASE="${tmp}/case-$1"
  WORK="${CASE}/work"
  HOME_DIR="${CASE}/home"
  mkdir -p "${WORK}/ctx" "${HOME_DIR}"
  printf 'TASK: pr_opened test prompt\n' > "${WORK}/prompt.md"
}

seed_caches() {
  local rules="${HOME_DIR}/.cache/cchp-semgrep-rules/${TEST_RULES_COMMIT}"
  mkdir -p "${rules}/config/go" "${rules}/config/typescript"
  printf 'rules: []\n' > "${rules}/config/go/rule.yaml"
  printf 'rules: []\n' > "${rules}/config/typescript/rule.yaml"
  touch "${rules}/.complete"
  local cq="${HOME_DIR}/.cache/cchp-codeql/${TEST_CODEQL_VERSION}/codeql"
  mkdir -p "${cq}"
  install -m 0755 "${shim}/codeql-impl" "${cq}/codeql"
}

write_patch() {
  cat > "${WORK}/ctx/pr-diff.patch" <<'EOF'
diff --git a/pkg/a.go b/pkg/a.go
--- a/pkg/a.go
+++ b/pkg/a.go
@@ -1 +1 @@
-old
+new
diff --git a/web/src/b.ts b/web/src/b.ts
--- a/web/src/b.ts
+++ b/web/src/b.ts
@@ -1 +1 @@
-old
+new
EOF
}

run_scan() { # extra VAR=value overrides win over the defaults
  env HOME="${HOME_DIR}" PATH="${shim}:${PATH}" \
    BOT_WORKDIR="${WORK}" BOT_TASK=pr_opened BOT_SKIP_PR_INSPECT=0 \
    BOT_PR_NUMBER=7 BOT_PR_IS_FORK=0 BOT_REPO=example/repo \
    BOT_HEAD_SHA="${TEST_SHA}" GH_TOKEN=test-token \
    BOT_SEMGREP_RULES_COMMIT="${TEST_RULES_COMMIT}" \
    BOT_CODEQL_VERSION="${TEST_CODEQL_VERSION}" \
    FAKE_GIT_LOG="${CASE}/git.log" FAKE_GH_LOG="${CASE}/gh.log" \
    FAKE_SEMGREP_LOG="${CASE}/semgrep.log" FAKE_CODEQL_LOG="${CASE}/codeql.log" \
    FAKE_GIT_HEAD_SHA="${TEST_SHA}" \
    FAKE_GIT_CREATE_FILES="pkg/a.go:web/src/b.ts" \
    FAKE_SEMGREP_JSON="${fixtures}/semgrep.json" \
    FAKE_CODEQL_SARIF_JS="${fixtures}/codeql-js.sarif" \
    FAKE_CODEQL_SARIF_GO="${fixtures}/codeql-go.sarif" \
    "$@" \
    bash "$SCAN_SH"
}

assert_untouched() { # gating cases: no outputs, no prompt append, no checkout
  [[ ! -e "${WORK}/ctx/external" ]] || fail "$1: ctx/external must not be created"
  [[ ! -e "${WORK}/scan-head" ]] || fail "$1: scan-head must not be created"
  grep -Fq 'External static-analysis evidence' "${WORK}/prompt.md" \
    && fail "$1: prompt must not be appended"
  [[ "$(cat "${WORK}/prompt.md")" == "TASK: pr_opened test prompt" ]] \
    || fail "$1: prompt content changed"
}

# ── 1. Gating pass-through ────────────────────────────────────────────────────
new_case gate-task
run_scan BOT_TASK=engage
assert_untouched gate-task

new_case gate-skip-inspect
run_scan BOT_SKIP_PR_INSPECT=1
assert_untouched gate-skip-inspect

new_case gate-no-pr
run_scan BOT_PR_NUMBER=
assert_untouched gate-no-pr

# ── 2. Happy path: all three scanners run, normalize, filter to the diff ─────
new_case happy
seed_caches
write_patch
run_scan
st="${WORK}/ctx/external/status.json"
fd="${WORK}/ctx/external/findings.json"
[[ -s "$st" && -s "$fd" ]] || fail "happy: status/findings missing"
jq -e --arg sha "$TEST_SHA" '
  .head_sha == $sha and (.generated_at | length) > 0 and
  (.scanners | keys) == ["codeql_go", "codeql_javascript", "semgrep"] and
  ([.scanners[] | (keys | sort) == ["duration_seconds","findings_in_diff","findings_total","reason","status"]] | all) and
  ([.scanners[] | .duration_seconds | type == "number"] | all) and
  .scanners.semgrep.status == "ran" and .scanners.semgrep.reason == null and
  .scanners.semgrep.findings_total == 2 and .scanners.semgrep.findings_in_diff == 1 and
  .scanners.codeql_javascript.status == "ran" and
  .scanners.codeql_javascript.findings_total == 2 and .scanners.codeql_javascript.findings_in_diff == 1 and
  .scanners.codeql_go.status == "ran" and
  .scanners.codeql_go.findings_total == 1 and .scanners.codeql_go.findings_in_diff == 1
' "$st" >/dev/null || fail "happy: status.json shape/content"
jq -e --arg sha "$TEST_SHA" '
  .head_sha == $sha and
  (.findings | length) == 3 and
  ([.findings[].tool] | sort) == ["codeql", "codeql", "semgrep"] and
  ([.findings[].path] | sort) == ["pkg/a.go", "pkg/a.go", "web/src/b.ts"] and
  ([.findings[] | select(.path == "pkg/other.go" or .path == "web/src/nope.ts")] | length) == 0
' "$fd" >/dev/null || fail "happy: findings.json content / diff filter"
jq -e '
  (.findings | map(select(.tool == "semgrep")) | .[0]) as $s |
  $s.rule_id == "go.lang.security.audit.dangerous-exec-command" and
  $s.severity == "ERROR" and $s.line == 10 and $s.end_line == 12 and
  $s.message == "dangerous exec"
' "$fd" >/dev/null || fail "happy: semgrep normalization fields"
jq -e '
  (.findings | map(select(.tool == "codeql" and .path == "web/src/b.ts")) | .[0]) as $c |
  $c.rule_id == "js/xss" and $c.severity == "error" and $c.line == 5 and $c.end_line == 6 and
  $c.message == "possible xss"
' "$fd" >/dev/null || fail "happy: codeql SARIF normalization fields"
jq -e '
  (.findings | map(select(.tool == "codeql" and .path == "pkg/a.go")) | .[0]) as $g |
  $g.rule_id == "go/sql-injection" and $g.line == 20 and $g.end_line == 20
' "$fd" >/dev/null || fail "happy: codeql go end_line fallback"
[[ -s "${WORK}/ctx/external/raw/semgrep.json" ]] || fail "happy: raw semgrep output missing"
[[ -s "${WORK}/ctx/external/raw/codeql-javascript.sarif" ]] || fail "happy: raw JS SARIF missing"
[[ -s "${WORK}/ctx/external/raw/codeql-go.sarif" ]] || fail "happy: raw Go SARIF missing"
grep -Fq '## External static-analysis evidence (advisory, UNVERIFIED)' "${WORK}/prompt.md" \
  || fail "happy: prompt section header missing"
grep -Fq "Status: ${WORK}/ctx/external/status.json; normalized findings: ${WORK}/ctx/external/findings.json." "${WORK}/prompt.md" \
  || fail "happy: prompt absolute paths missing"
grep -Fq 'Every entry is an UNVERIFIED candidate' "${WORK}/prompt.md" \
  || fail "happy: prompt verification-pipeline sentence missing"
grep -Fq 'your independent review must go far beyond them' "${WORK}/prompt.md" \
  || fail "happy: prompt coverage sentence missing"
grep -Fq 'Some scanners were skipped or failed' "${WORK}/prompt.md" \
  && fail "happy: all-ran run must not carry the skip note"
grep -Fq 'refs/pull/7/head' "${CASE}/git.log" || fail "happy: must fetch base-repo pull head ref"
[[ ! -s "${CASE}/gh.log" ]] || fail "happy: gh must not be called when patch + caches exist"

# ── 3. Head SHA mismatch → everything skipped, fail-open ─────────────────────
new_case mismatch
seed_caches
write_patch
run_scan FAKE_GIT_HEAD_SHA="${OTHER_SHA}"
st="${WORK}/ctx/external/status.json"
jq -e '
  ([.scanners[] | .status == "skipped"] | all) and
  ([.scanners[] | .reason | test("head did not match")] | all)
' "$st" >/dev/null || fail "mismatch: scanners must be skipped with mismatch reason"
jq -e '(.findings | length) == 0' "${WORK}/ctx/external/findings.json" >/dev/null \
  || fail "mismatch: findings must be empty"
grep -Fq '## External static-analysis evidence (advisory, UNVERIFIED)' "${WORK}/prompt.md" \
  || fail "mismatch: prompt section must still be appended"
grep -Fq 'Some scanners were skipped or failed' "${WORK}/prompt.md" \
  || fail "mismatch: prompt must point at the status reasons"
[[ ! -s "${CASE}/semgrep.log" ]] || fail "mismatch: semgrep must not run"
[[ ! -s "${CASE}/codeql.log" ]] || fail "mismatch: codeql must not run"

# ── 4. Fork PR → Go analysis skipped, static scanners still run ──────────────
new_case fork
seed_caches
write_patch
run_scan BOT_PR_IS_FORK=1
st="${WORK}/ctx/external/status.json"
jq -e '
  .scanners.semgrep.status == "ran" and
  .scanners.codeql_javascript.status == "ran" and
  .scanners.codeql_go.status == "skipped" and
  (.scanners.codeql_go.reason | test("fork PR: Go analysis requires executing the build"))
' "$st" >/dev/null || fail "fork: Go must be skipped with the fork reason"
jq -e '(.findings | length) == 2' "${WORK}/ctx/external/findings.json" >/dev/null \
  || fail "fork: findings must only carry semgrep + JS entries"
grep -Fq 'Some scanners were skipped or failed' "${WORK}/prompt.md" \
  || fail "fork: prompt must point at the status reasons"

# ── 5. Scanner crash → failed in status, script still exits 0 ────────────────
new_case crash
seed_caches
write_patch
run_scan FAKE_SEMGREP_MODE=crash
st="${WORK}/ctx/external/status.json"
jq -e '
  .scanners.semgrep.status == "failed" and
  (.scanners.semgrep.reason | test("semgrep exited rc=2")) and
  .scanners.codeql_javascript.status == "ran" and
  .scanners.codeql_go.status == "ran"
' "$st" >/dev/null || fail "crash: semgrep failed must not affect codeql"
jq -e '(.findings | length) == 2' "${WORK}/ctx/external/findings.json" >/dev/null \
  || fail "crash: findings must carry the codeql entries only"

# ── 6. Missing trusted diff → gh api fallback for the changed-file list ──────
new_case gh-fallback
seed_caches
run_scan   # no write_patch
st="${WORK}/ctx/external/status.json"
grep -Fq 'pulls/7/files?per_page=100' "${CASE}/gh.log" \
  || fail "gh-fallback: must query pulls/files when the trusted diff is missing"
jq -e '
  .scanners.semgrep.status == "ran" and
  .scanners.semgrep.findings_in_diff == 1 and
  .scanners.codeql_javascript.findings_in_diff == 1 and
  .scanners.codeql_go.findings_in_diff == 1
' "$st" >/dev/null || fail "gh-fallback: scanners must run on gh-derived file list"
jq -e '(.findings | length) == 3' "${WORK}/ctx/external/findings.json" >/dev/null \
  || fail "gh-fallback: findings must match the happy path"

echo "external-scan tests passed"
