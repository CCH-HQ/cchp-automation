#!/usr/bin/env bash
# cchp-automation bot — trusted pre-review external static analysis (CodeQL + Semgrep).
#
# Runs as its own TRUSTED workflow step after "Prepare isolated environment" and
# before "Run opencode". It fetches the PR head from the BASE repository's
# refs/pull/<n>/head into a scan-only checkout under ${BOT_WORKDIR}/scan-head
# (NEVER the execution clone at ${BOT_WORKDIR}/repo), runs static analyzers,
# normalizes their output into ${BOT_WORKDIR}/ctx/external/ and appends an
# advisory pointer to the review prompt. The model can read ctx/external/* but
# can only write ctx/review/*, so the scan evidence is model-immutable. Every
# finding is an UNVERIFIED candidate for the normal review verification
# pipeline — never a verdict.
#
# Execution-safety matrix (the workflow rule "never execute untrusted fork
# code" is enforced here, not just documented):
#   * Semgrep          pure static parsing                → fork + same-repo
#   * CodeQL JS/TS     extraction only (build mode none)  → fork + same-repo
#   * CodeQL Go        must run `go build ./...`          → same-repo ONLY
#
# Fail-open: an unavailable / failed / timed-out scanner is recorded in
# ctx/external/status.json and never fails this step. Only broken
# preconditions of the script itself (mkdir on the workdir etc.) exit non-zero.
#
# Required env (route.sh via GITHUB_ENV + step env):
#   BOT_WORKDIR BOT_TASK BOT_PR_NUMBER BOT_REPO BOT_HEAD_SHA BOT_PR_IS_FORK
#   BOT_SKIP_PR_INSPECT GH_TOKEN
# Optional env (pins live in the constants below; overrides are for the
# self-test and for emergency ops only):
#   BOT_CODEQL_VERSION BOT_SEMGREP_VERSION BOT_SEMGREP_RULES_COMMIT
set -euo pipefail
# See prepare-env.sh: bot tools live in ~/.local/bin, never added to
# GITHUB_PATH (zizmor github-env); every step re-adds it locally.
export PATH="${HOME}/.local/bin:${PATH}"

log()  { printf '\033[1;34m[external-scan]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[external-scan][warn]\033[0m %s\n' "$*"; }

# ── Pinned tool versions (bump deliberately, together with a test run) ───────
CODEQL_BUNDLE_VERSION="${BOT_CODEQL_VERSION:-v2.26.1}"   # github/codeql-action release codeql-bundle-<ver>
SEMGREP_VERSION="${BOT_SEMGREP_VERSION:-1.169.0}"        # used for the uvx/pipx fallbacks
SEMGREP_RULES_COMMIT="${BOT_SEMGREP_RULES_COMMIT:-e5b5a42ec061854378c11e0d01f19250b52bc2e9}"
SEMGREP_RULES_REPO="https://github.com/semgrep/semgrep-rules"
SEMGREP_RULE_DIRS=(go typescript yaml/github-actions generic/ci)

# ── Gate: only fresh full PR reviews get an external scan ────────────────────
if [[ "${BOT_TASK:-}" != "pr_opened" ]]; then
  log "skip: task '${BOT_TASK:-none}' is not pr_opened"
  exit 0
fi
if [[ "${BOT_SKIP_PR_INSPECT:-0}" == "1" ]]; then
  log "skip: metadata-only PR edit (BOT_SKIP_PR_INSPECT=1)"
  exit 0
fi
if [[ ! "${BOT_PR_NUMBER:-}" =~ ^[0-9]+$ ]]; then
  log "skip: no usable PR number ('${BOT_PR_NUMBER:-}')"
  exit 0
fi

: "${BOT_WORKDIR:?}" "${BOT_REPO:?}"

CTX_DIR="${BOT_WORKDIR}/ctx"
EXT_DIR="${CTX_DIR}/external"
RAW_DIR="${EXT_DIR}/raw"
TMP_DIR="${BOT_WORKDIR}/scan-tmp"
SCAN_DIR="${BOT_WORKDIR}/scan-head"
PROMPT_FILE="${BOT_PROMPT_FILE:-${BOT_WORKDIR}/prompt.md}"
CHANGED_LIST="${TMP_DIR}/changed-files.txt"
CHANGED_JSON="${TMP_DIR}/changed-files.json"
CODEQL_CACHE_ROOT="${HOME}/.cache/cchp-codeql"
SEMGREP_RULES_CACHE_ROOT="${HOME}/.cache/cchp-semgrep-rules"
CODEQL_BIN="${CODEQL_CACHE_ROOT}/${CODEQL_BUNDLE_VERSION}/codeql/codeql"
CODEQL_STATE=""   # "" (unresolved) | ok | fail — memo shared by both languages

# Script preconditions — the only non-fail-open part of this file.
mkdir -p "$RAW_DIR" "$TMP_DIR" "$CODEQL_CACHE_ROOT" "$SEMGREP_RULES_CACHE_ROOT"
: > "$CHANGED_LIST"
printf '[]\n' > "$CHANGED_JSON"

SCANNERS=(semgrep codeql_javascript codeql_go)
declare -A SC_STATUS SC_REASON SC_DURATION SC_TOTAL SC_INDIFF
for key in "${SCANNERS[@]}"; do
  SC_STATUS[$key]=skipped
  SC_REASON[$key]="not attempted"
  SC_DURATION[$key]=0
  SC_TOTAL[$key]=0
  SC_INDIFF[$key]=0
  printf '[]\n' > "${TMP_DIR}/filtered-${key}.json"
done

mark() { # $1=scanner  $2=status  $3=reason ("" for ran)
  SC_STATUS[$1]="$2"
  SC_REASON[$1]="${3:-}"
}

mark_all_skipped() { # $1=reason
  local key
  for key in "${SCANNERS[@]}"; do mark "$key" skipped "$1"; done
}

scanner_status_json() { # $1=scanner
  local d="${SC_DURATION[$1]}" t="${SC_TOTAL[$1]}" i="${SC_INDIFF[$1]}"
  [[ "$d" =~ ^[0-9]+$ ]] || d=0
  [[ "$t" =~ ^[0-9]+$ ]] || t=0
  [[ "$i" =~ ^[0-9]+$ ]] || i=0
  jq -n \
    --arg status "${SC_STATUS[$1]}" \
    --arg reason "${SC_REASON[$1]}" \
    --argjson duration "$d" --argjson total "$t" --argjson in_diff "$i" \
    '{status: $status,
      reason: (if $reason == "" then null else $reason end),
      duration_seconds: $duration,
      findings_total: $total,
      findings_in_diff: $in_diff}'
}

append_prompt_section() {
  local all_ran=1 key
  for key in "${SCANNERS[@]}"; do
    [[ "${SC_STATUS[$key]}" == "ran" ]] || all_ran=0
  done
  {
    echo
    echo "## External static-analysis evidence (advisory, UNVERIFIED)"
    echo "Trusted pre-review scanners (CodeQL, Semgrep) ran against the PR head. Status: ${EXT_DIR}/status.json; normalized findings: ${EXT_DIR}/findings.json."
    echo "Read both files. Every entry is an UNVERIFIED candidate: it must enter the normal verification pipeline (confirm/refute/reproduce) like any other candidate, and be deduplicated against your own findings. External coverage is a small subset of the review — never stop at these references; your independent review must go far beyond them."
    if (( all_ran == 0 )); then
      echo "Some scanners were skipped or failed; the per-scanner reason is recorded in the status file."
    fi
  } >> "$PROMPT_FILE"
}

finalize_outputs() {
  local generated_at key
  generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  jq -s --arg generated_at "$generated_at" --arg head_sha "${BOT_HEAD_SHA:-}" \
    '{generated_at: $generated_at, head_sha: $head_sha, findings: (add // [])}' \
    "${TMP_DIR}/filtered-semgrep.json" \
    "${TMP_DIR}/filtered-codeql_javascript.json" \
    "${TMP_DIR}/filtered-codeql_go.json" \
    > "${EXT_DIR}/findings.json"
  jq -n --arg generated_at "$generated_at" --arg head_sha "${BOT_HEAD_SHA:-}" \
    --argjson semgrep "$(scanner_status_json semgrep)" \
    --argjson codeql_javascript "$(scanner_status_json codeql_javascript)" \
    --argjson codeql_go "$(scanner_status_json codeql_go)" \
    '{generated_at: $generated_at, head_sha: $head_sha,
      scanners: {semgrep: $semgrep, codeql_javascript: $codeql_javascript, codeql_go: $codeql_go}}' \
    > "${EXT_DIR}/status.json"
  append_prompt_section
  for key in "${SCANNERS[@]}"; do
    log "scanner ${key}: ${SC_STATUS[$key]}${SC_REASON[$key]:+ (${SC_REASON[$key]})} total=${SC_TOTAL[$key]} in_diff=${SC_INDIFF[$key]} duration=${SC_DURATION[$key]}s"
  done
  log "wrote ${EXT_DIR}/status.json + ${EXT_DIR}/findings.json and appended the prompt section"
}

# ── Scan-only checkout of the PR head (no untrusted code is executed here) ───
# The head of a fork PR also exists in the BASE repository under
# refs/pull/<n>/head, so we never touch the fork remote. --no-checkout +
# blob:none keeps the transfer small; --reference-if-able reuses objects from
# the trusted execution clone when present.
scan_checkout() {
  local remote="https://github.com/${BOT_REPO}.git" got
  [[ -n "${GH_TOKEN:-}" ]] && remote="https://x-access-token:${GH_TOKEN}@github.com/${BOT_REPO}.git"
  local -a ref_opt=()
  [[ -d "${BOT_WORKDIR}/repo/.git" ]] && ref_opt=(--reference-if-able "${BOT_WORKDIR}/repo")
  rm -rf "$SCAN_DIR"
  log "scan checkout: cloning ${BOT_REPO} (no-checkout, blob:none) -> ${SCAN_DIR}"
  if ! timeout 600 git clone --quiet --no-checkout --filter=blob:none \
       "${ref_opt[@]}" "$remote" "$SCAN_DIR"; then
    warn "scan clone failed"
    return 1
  fi
  if ! timeout 600 git -C "$SCAN_DIR" fetch --quiet origin "refs/pull/${BOT_PR_NUMBER}/head"; then
    warn "fetch of refs/pull/${BOT_PR_NUMBER}/head failed"
    return 1
  fi
  if ! timeout 600 git -C "$SCAN_DIR" checkout --quiet --force "$BOT_HEAD_SHA"; then
    warn "checkout of ${BOT_HEAD_SHA} failed (head may have moved since routing)"
    return 1
  fi
  got="$(git -C "$SCAN_DIR" rev-parse HEAD 2>/dev/null || echo '')"
  if [[ "${got,,}" != "${BOT_HEAD_SHA,,}" ]]; then
    warn "scan head is '${got}' but the routed head SHA is ${BOT_HEAD_SHA}"
    return 1
  fi
  # Blobs are materialized; drop the credentialed remote URL immediately.
  git -C "$SCAN_DIR" remote set-url origin "https://github.com/${BOT_REPO}.git" || true
  log "scan checkout pinned at ${BOT_HEAD_SHA}"
}

# ── Changed-file list: trusted diff first, gh API fallback ───────────────────
resolve_changed_files() {
  local patch="${CTX_DIR}/pr-diff.patch"
  if [[ -s "$patch" ]]; then
    grep -E '^\+\+\+ b/' "$patch" 2>/dev/null \
      | sed -e 's|^+++ b/||' -e 's/[[:space:]]*$//' \
      | LC_ALL=C sort -u > "$CHANGED_LIST" || true
  fi
  if [[ ! -s "$CHANGED_LIST" ]]; then
    log "trusted ctx/pr-diff.patch missing or empty; falling back to gh api pulls/${BOT_PR_NUMBER}/files"
    # TODO(cchp: route via engine CLI — DESIGN §6): PR changed-files listing via
    # the GitHub REST API (repos/{repo}/pulls/{n}/files, paginated).
    gh api --paginate "repos/${BOT_REPO}/pulls/${BOT_PR_NUMBER}/files?per_page=100" \
      --jq '.[].filename' 2>/dev/null | LC_ALL=C sort -u > "$CHANGED_LIST" || true
  fi
}

count_and_filter() { # $1=scanner  $2=normalized-findings-array file
  local key="$1" norm="$2" filtered="${TMP_DIR}/filtered-$1.json"
  SC_TOTAL[$key]="$(jq 'length' "$norm" 2>/dev/null || echo 0)"
  if ! jq --slurpfile changed "$CHANGED_JSON" \
       'map(select(.path as $p | ($changed[0] | index($p)) != null))' \
       "$norm" > "$filtered" 2>/dev/null; then
    printf '[]\n' > "$filtered"
  fi
  SC_INDIFF[$key]="$(jq 'length' "$filtered" 2>/dev/null || echo 0)"
}

collect_sarif() { # $1=scanner  $2=sarif file  — normalize + count + mark ran
  local key="$1" sarif="$2" norm="${TMP_DIR}/normalized-$1.json"
  if ! jq '[.runs[]? | .results[]? | {
        tool: "codeql",
        rule_id: (.ruleId // ""),
        severity: (.level // "warning"),
        path: ((.locations // [])[0].physicalLocation.artifactLocation.uri // "" | ltrimstr("./")),
        line: ((.locations // [])[0].physicalLocation.region.startLine // 0),
        end_line: ((.locations // [])[0].physicalLocation.region.endLine
                   // (.locations // [])[0].physicalLocation.region.startLine // 0),
        message: (.message.text // "")
      }]' "$sarif" > "$norm" 2>/dev/null; then
    mark "$key" failed "could not parse SARIF output"
    return 0
  fi
  count_and_filter "$key" "$norm"
  mark "$key" ran ""
}

# ── Semgrep: pinned semgrep-rules commit, four rule dirs, changed files only ─
prepare_semgrep_rules() { # $1=cache dir for this commit
  local cache="$1" src="$1/src" config="$1/config" d copied=0
  rm -rf "$cache"
  mkdir -p "$cache"
  if ! timeout 600 git clone --quiet --filter=blob:none "$SEMGREP_RULES_REPO" "$src"; then
    return 1
  fi
  if ! git -C "$src" checkout --quiet "$SEMGREP_RULES_COMMIT"; then
    return 1
  fi
  mkdir -p "$config"
  for d in "${SEMGREP_RULE_DIRS[@]}"; do
    [[ -d "${src}/${d}" ]] || continue
    # Keep only rule yamls: *.test.yml / *.test.yaml are test FIXTURES that
    # semgrep would otherwise misparse as rule files.
    if ( cd "$src" && find "$d" -type f \( -name '*.yaml' -o -name '*.yml' \) \
         ! -name '*.test.yaml' ! -name '*.test.yml' -exec cp --parents -t "$config" {} + ); then
      copied=1
    fi
  done
  rm -rf "$src"
  (( copied == 1 )) || return 1
  touch "${cache}/.complete"
}

run_semgrep_impl() {
  local rules_cache="${SEMGREP_RULES_CACHE_ROOT}/${SEMGREP_RULES_COMMIT}"
  local config_root="${rules_cache}/config"
  if [[ ! -f "${rules_cache}/.complete" ]]; then
    log "semgrep: building pinned rules cache @ ${SEMGREP_RULES_COMMIT}"
    if ! prepare_semgrep_rules "$rules_cache"; then
      mark semgrep skipped "pinned semgrep-rules checkout (${SEMGREP_RULES_COMMIT}) unavailable"
      return 0
    fi
  fi
  local -a config_args=()
  local d
  for d in "${SEMGREP_RULE_DIRS[@]}"; do
    [[ -d "${config_root}/${d}" ]] && config_args+=(--config "${config_root}/${d}")
  done
  if (( ${#config_args[@]} == 0 )); then
    mark semgrep skipped "no pinned rule directories available in the cache"
    return 0
  fi
  local -a cmd=()
  if command -v semgrep >/dev/null 2>&1; then
    cmd=(semgrep)
  elif command -v uvx >/dev/null 2>&1; then
    cmd=(uvx --from "semgrep==${SEMGREP_VERSION}" semgrep)
  elif command -v pipx >/dev/null 2>&1; then
    cmd=(pipx run "semgrep==${SEMGREP_VERSION}")
  else
    mark semgrep skipped "no semgrep / uvx / pipx on PATH"
    return 0
  fi
  local -a targets=()
  local f
  while IFS= read -r f; do
    [[ -n "$f" && -f "${SCAN_DIR}/${f}" ]] && targets+=("$f")
  done < "$CHANGED_LIST"
  if (( ${#targets[@]} == 0 )); then
    mark semgrep skipped "no changed files present in the scan checkout"
    return 0
  fi
  local raw_json="${RAW_DIR}/semgrep.json" raw_sarif="${RAW_DIR}/semgrep.sarif"
  local slog="${RAW_DIR}/semgrep.log" rc=0
  log "semgrep: scanning ${#targets[@]} changed file(s) against pinned rules"
  ( cd "$SCAN_DIR" && timeout 900 "${cmd[@]}" scan \
      --metrics off --disable-version-check --no-secrets-validation \
      "${config_args[@]}" \
      --json-output "$raw_json" --sarif-output "$raw_sarif" \
      "${targets[@]}" ) >>"$slog" 2>&1 || rc=$?
  if (( rc != 0 )) || [[ ! -s "$raw_json" ]]; then
    mark semgrep failed "semgrep exited rc=${rc} or produced no JSON (see raw/semgrep.log)"
    return 0
  fi
  local norm="${TMP_DIR}/normalized-semgrep.json"
  if ! jq '[.results[]? | {
        tool: "semgrep",
        rule_id: (.check_id // ""),
        severity: (.extra.severity // "INFO"),
        path: ((.path // "") | ltrimstr("./")),
        line: (.start.line // 0),
        end_line: (.end.line // .start.line // 0),
        message: (.extra.message // "")
      }]' "$raw_json" > "$norm" 2>/dev/null; then
    mark semgrep failed "could not parse semgrep JSON output"
    return 0
  fi
  count_and_filter semgrep "$norm"
  mark semgrep ran ""
}

# ── CodeQL: pinned bundle from github/codeql-action releases ─────────────────
ensure_codeql() {
  [[ "$CODEQL_STATE" == "ok" ]] && return 0
  [[ "$CODEQL_STATE" == "fail" ]] && return 1
  if [[ -x "$CODEQL_BIN" ]]; then
    log "codeql: bundle ${CODEQL_BUNDLE_VERSION} found in cache"
    CODEQL_STATE=ok
    return 0
  fi
  log "codeql: downloading bundle ${CODEQL_BUNDLE_VERSION}"
  local dl="${TMP_DIR}/codeql-dl" staging
  mkdir -p "$dl"
  # TODO(cchp: route via engine CLI — DESIGN §6): CodeQL bundle release asset
  # download (github/codeql-action) via the GitHub Releases API.
  if ! timeout 900 gh release download -R github/codeql-action \
       "codeql-bundle-${CODEQL_BUNDLE_VERSION}" \
       -p 'codeql-bundle-linux64.tar.gz' --dir "$dl" --clobber >/dev/null 2>&1; then
    warn "codeql bundle download failed"
    CODEQL_STATE=fail
    return 1
  fi
  if ! staging="$(mktemp -d "${CODEQL_CACHE_ROOT}/.staging-XXXXXX" 2>/dev/null)"; then
    CODEQL_STATE=fail
    return 1
  fi
  if ! tar -xzf "${dl}/codeql-bundle-linux64.tar.gz" -C "$staging" 2>/dev/null \
     || [[ ! -x "${staging}/codeql/codeql" ]]; then
    warn "codeql bundle extract failed"
    rm -rf "$staging"
    CODEQL_STATE=fail
    return 1
  fi
  if ! mv -T "$staging" "${CODEQL_CACHE_ROOT}/${CODEQL_BUNDLE_VERSION}" 2>/dev/null; then
    rm -rf "$staging"
    # A concurrent bot run may have populated the cache first — that is fine.
    if [[ ! -x "$CODEQL_BIN" ]]; then
      CODEQL_STATE=fail
      return 1
    fi
  fi
  CODEQL_STATE=ok
}

run_codeql_javascript_impl() {
  if ! grep -qE '\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|vue|html|htm)$' "$CHANGED_LIST"; then
    mark codeql_javascript skipped "no changed JavaScript/TypeScript files"
    return 0
  fi
  if ! ensure_codeql; then
    mark codeql_javascript skipped "codeql bundle ${CODEQL_BUNDLE_VERSION} unavailable"
    return 0
  fi
  local db="${TMP_DIR}/db-javascript" raw="${RAW_DIR}/codeql-javascript.sarif"
  local clog="${RAW_DIR}/codeql-javascript.log"
  # Extraction-only (build mode none): no project code is executed, so this is
  # safe for fork PR heads too.
  log "codeql javascript-typescript: database create (no build)"
  if ! timeout 1500 "$CODEQL_BIN" database create "$db" \
       --language=javascript-typescript --build-mode=none \
       --source-root "$SCAN_DIR" --threads=0 --overwrite >>"$clog" 2>&1; then
    mark codeql_javascript failed "codeql database create failed/timed out (see raw/codeql-javascript.log)"
    return 0
  fi
  log "codeql javascript-typescript: database analyze"
  if ! timeout 1500 "$CODEQL_BIN" database analyze "$db" \
       "codeql/javascript-queries:codeql-suites/javascript-code-scanning.qls" \
       --format=sarif-latest --threads=0 --output "$raw" >>"$clog" 2>&1; then
    mark codeql_javascript failed "codeql database analyze failed/timed out (see raw/codeql-javascript.log)"
    return 0
  fi
  collect_sarif codeql_javascript "$raw"
}

run_codeql_go_impl() {
  # Go extraction executes the project build — never do that for a fork head.
  # BOT_PR_IS_FORK defaults to fork (fail-closed) when unset.
  if [[ "${BOT_PR_IS_FORK:-1}" != "0" ]]; then
    mark codeql_go skipped "fork PR: Go analysis requires executing the build"
    return 0
  fi
  if ! grep -qE '(\.go$)|((^|/)go\.(mod|sum)$)' "$CHANGED_LIST"; then
    mark codeql_go skipped "no changed Go files"
    return 0
  fi
  if ! command -v go >/dev/null 2>&1; then
    mark codeql_go skipped "go toolchain not on PATH"
    return 0
  fi
  if ! ensure_codeql; then
    mark codeql_go skipped "codeql bundle ${CODEQL_BUNDLE_VERSION} unavailable"
    return 0
  fi
  # go.mod replace directives point into third_party/sdk git submodules; fetch
  # them best-effort (a miss just makes the build → database create fail,
  # which is fail-open like everything else here).
  timeout 600 git -C "$SCAN_DIR" submodule update --init --recursive --depth 1 >/dev/null 2>&1 \
    || warn "scan-head submodule fetch failed (go build may fail)"
  local db="${TMP_DIR}/db-go" raw="${RAW_DIR}/codeql-go.sarif" clog="${RAW_DIR}/codeql-go.log"
  # GOEXPERIMENT=jsonv2: this repository does not compile without it.
  log "codeql go: database create (go build ./...)"
  if ! timeout 1500 env GOEXPERIMENT=jsonv2 "$CODEQL_BIN" database create "$db" \
       --language=go --source-root "$SCAN_DIR" --threads=0 --overwrite \
       --command="go build ./..." >>"$clog" 2>&1; then
    mark codeql_go failed "codeql database create failed/timed out (see raw/codeql-go.log)"
    return 0
  fi
  log "codeql go: database analyze"
  if ! timeout 1500 "$CODEQL_BIN" database analyze "$db" \
       "codeql/go-queries:codeql-suites/go-code-scanning.qls" \
       --format=sarif-latest --threads=0 --output "$raw" >>"$clog" 2>&1; then
    mark codeql_go failed "codeql database analyze failed/timed out (see raw/codeql-go.log)"
    return 0
  fi
  collect_sarif codeql_go "$raw"
}

run_scanner() { # $1=scanner key  $2=impl function — fail-open wrapper + timing
  local start
  start="$(date +%s)"
  "$2" || warn "$1 runner aborted unexpectedly (fail-open, recorded in status.json)"
  SC_DURATION[$1]="$(( $(date +%s) - start ))"
}

# ── Main flow ─────────────────────────────────────────────────────────────────
if [[ ! "${BOT_HEAD_SHA:-}" =~ ^[0-9a-fA-F]{40}$ ]]; then
  warn "BOT_HEAD_SHA missing or malformed ('${BOT_HEAD_SHA:-}'); skipping all scanners"
  mark_all_skipped "PR head SHA unavailable or malformed (fail-open)"
  finalize_outputs
  exit 0
fi

if ! scan_checkout; then
  mark_all_skipped "scan checkout failed or head did not match ${BOT_HEAD_SHA} (fail-open)"
  finalize_outputs
  exit 0
fi

resolve_changed_files || true
if [[ ! -s "$CHANGED_LIST" ]]; then
  warn "could not determine the PR changed-file list; skipping all scanners"
  mark_all_skipped "could not determine the PR changed-file list (fail-open)"
  finalize_outputs
  exit 0
fi
jq -R -s 'split("\n") | map(select(length > 0))' < "$CHANGED_LIST" > "$CHANGED_JSON"
log "resolved $(jq 'length' "$CHANGED_JSON") changed file(s)"

run_scanner semgrep run_semgrep_impl
run_scanner codeql_javascript run_codeql_javascript_impl
run_scanner codeql_go run_codeql_go_impl

finalize_outputs
log "external scan complete"
exit 0
