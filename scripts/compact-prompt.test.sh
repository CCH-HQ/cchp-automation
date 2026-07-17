#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

ULTRA_PROTOCOL="${SCRIPT_DIR}/../opencode/review/ultra-protocol.md"
ULTRA_PLUGIN="${SCRIPT_DIR}/../opencode/plugin/ultra-review-runner.ts"
REVIEW_GUARD="${SCRIPT_DIR}/../opencode/plugin/review-artifact-guard.ts"
REFERENCE_CATALOG="${SCRIPT_DIR}/../opencode/review/reference-library/catalog.json"
[[ -f "${ULTRA_PROTOCOL}" ]]
[[ -f "${ULTRA_PLUGIN}" ]]
[[ -f "${REVIEW_GUARD}" ]]
[[ -f "${REFERENCE_CATALOG}" ]]
jq -e '
  .statistics.unique_entries == 242 and
  .statistics.total_origins == 249 and
  .statistics.deduplicated_origins == 7 and
  (.sources | map(.imported_files) == [45,152,62])
' "${REFERENCE_CATALOG}" >/dev/null
grep -Fq 'review-reference-library.ts' "${SCRIPT_DIR}/run.sh"
grep -Fq 'Three complete fresh gap-sweep rounds' "${ULTRA_PROTOCOL}"
grep -Fq 'CONFIRMED_REPRODUCED' "${ULTRA_PROTOCOL}"
grep -Fq 'HIGH_RISK_UNRESOLVED' "${ULTRA_PROTOCOL}"
grep -Fq 'MAX_PARALLEL = 10' "${ULTRA_PLUGIN}"
grep -Fq 'AGENT_TIMEOUT_MS = 30 * 60 * 1000' "${ULTRA_PLUGIN}"
grep -Fq 'ultra_review_task' "${ULTRA_PLUGIN}"
grep -Fq 'reasoningEffort: "max"' "${SCRIPT_DIR}/run.sh"
grep -Fq 'variant: "max"' "${SCRIPT_DIR}/run.sh"
grep -Fq 'opencode run --auto --agent build --variant max' "${SCRIPT_DIR}/run.sh"
grep -Fq '/opencode/review/ultra-protocol.md' "${SCRIPT_DIR}/run.sh"
grep -Fq '/opencode/plugin/ultra-review-runner.ts' "${SCRIPT_DIR}/run.sh"

config_smoke="${tmp}/config-smoke"
mkdir -p "${config_smoke}/home/.local/bin" "${config_smoke}/repo" "${config_smoke}/bin"
printf 'TASK: pr_opened smoke\n' > "${config_smoke}/prompt.md"
mkdir -p "${config_smoke}/ctx/review"
cat > "${config_smoke}/ctx/review-manifest.json" <<EOF
{"schema_version":1,"complete":true,"repository":"example/repo","pull_request":{"number":7,"base_ref":"dev","base_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head_ref":"feature","head_sha":"0123456789abcdef0123456789abcdef01234567","merge_base_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"totals":{"changed_files":1,"additions":1,"deletions":1},"commits":[],"files":[{"path":"a.txt","previous_path":null,"status":"modified","additions":1,"deletions":1,"changes":2,"patch_present":true,"hunk_headers":["@@ -1 +1 @@"]}],"patch":{"path":"${config_smoke}/ctx/pr-diff.patch","sha256":"unused"},"generated_at":"2026-01-01T00:00:00Z","blockers":[]}
EOF
printf 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n' > "${config_smoke}/ctx/pr-diff.patch"
config_patch_hash=$(sha256sum "${config_smoke}/ctx/pr-diff.patch" | awk '{print $1}')
sed -i "s/\"sha256\":\"unused\"/\"sha256\":\"${config_patch_hash}\"/" "${config_smoke}/ctx/review-manifest.json"
trusted_hash=$(sha256sum "${config_smoke}/ctx/review-manifest.json" | awk '{print $1}')
cat > "${config_smoke}/ctx/review/manifest.json" <<EOF
{"schema_version":1,"trusted_manifest_sha256":"${trusted_hash}","base_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head_sha":"0123456789abcdef0123456789abcdef01234567","merge_base_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","review_shards":["a.txt"],"environment_blockers":[]}
EOF
cat > "${config_smoke}/ctx/review/coverage.json" <<'EOF'
{"schema_version":1,"entries":[{"file":"a.txt","hunk":"@@ -1 +1 @@","correctness_passes":["p1","p2","p3","p4","p5"],"dimensions":["correctness"]}],"gap_sweeps":[{"new_candidate_ids":[],"coverage_gaps":[]},{"new_candidate_ids":[],"coverage_gaps":[]},{"new_candidate_ids":[],"coverage_gaps":[]}],"consecutive_dry_rounds":3,"completeness_panel":{"uncovered_dimensions":[]},"limitations":[]}
EOF
printf '{"schema_version":1,"candidates":[]}\n' > "${config_smoke}/ctx/review/candidate-ledger.json"
printf '{"schema_version":1,"verifications":[]}\n' > "${config_smoke}/ctx/review/verification-ledger.json"
cat > "${config_smoke}/ctx/review/final-report.md" <<'EOF'
# Code Review Result
## Scope
## Verification summary
## Verified findings
## High-risk unresolved candidates
## Coverage and limitations
## Refutation ledger
EOF
cat > "${config_smoke}/bin/timeout" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s' "${OPENCODE_CONFIG_CONTENT:?}" > "${CAPTURE_CONFIG:?}"
MOCK
chmod +x "${config_smoke}/bin/timeout"
env HOME="${config_smoke}/home" PATH="${config_smoke}/bin:${PATH}" \
  BOT_WORKDIR="${config_smoke}" REPO_DIR="${config_smoke}/repo" \
  GITHUB_WORKSPACE="$(cd "${SCRIPT_DIR}/../.." && pwd)" \
  BOT_PROMPT_FILE="${config_smoke}/prompt.md" \
  BOT_SYSTEM_PROMPT="${SCRIPT_DIR}/system-prompt.md" BOT_TASK=pr_opened \
  BOT_CAN_WRITE=1 BOT_REPO=example/repo BOT_PR_NUMBER=7 \
  BOT_HEAD_SHA=0123456789abcdef0123456789abcdef01234567 \
  CCHP_BOT_MODEL=relay/gpt-5.6-sol \
  CCHP_BOT_PROVIDERS='{"relay":{"format":"openai-responses","base_url":"https://example.invalid/v1","models":{"gpt-5.6-sol":{"context":500000,"output":128000}}}}' \
  CAPTURE_CONFIG="${config_smoke}/opencode.json" \
  bash "${SCRIPT_DIR}/run.sh"
jq -e --arg ultra "${ULTRA_PROTOCOL}" --arg runner "file://${ULTRA_PLUGIN}" '
  .model == "relay/gpt-5.6-sol" and
  .provider.relay.models["gpt-5.6-sol"].variants.max.reasoningEffort == "max" and
  .agent.build.variant == "max" and
  .agent.general.variant == "max" and
  .agent.explore.variant == "max" and
  .agent.planner.variant == "max" and
  (.instructions | index($ultra)) == null and
  (.agent.review.prompt | contains("leaf reviewer")) and
  (.plugin | index($runner)) != null
' "${config_smoke}/opencode.json" >/dev/null
grep -Fq 'review-artifact-guard.ts' "${config_smoke}/opencode.json"
grep -Fq "${ULTRA_PROTOCOL}" "${config_smoke}/prompt.md"

env HOME="${config_smoke}/home" PATH="${config_smoke}/bin:${PATH}" \
  BOT_WORKDIR="${config_smoke}" REPO_DIR="${config_smoke}/repo" \
  GITHUB_WORKSPACE="$(cd "${SCRIPT_DIR}/../.." && pwd)" \
  BOT_PROMPT_FILE="${config_smoke}/prompt.md" \
  BOT_SYSTEM_PROMPT="${SCRIPT_DIR}/system-prompt.md" BOT_TASK=pr_opened BOT_SKIP_PR_INSPECT=1 \
  BOT_CAN_WRITE=1 BOT_REPO=example/repo BOT_PR_NUMBER=7 \
  BOT_HEAD_SHA=0123456789abcdef0123456789abcdef01234567 \
  CCHP_BOT_MODEL=relay/gpt-5.6-sol \
  CCHP_BOT_PROVIDERS='{"relay":{"format":"openai-responses","base_url":"https://example.invalid/v1","models":{"gpt-5.6-sol":{"context":500000,"output":128000}}}}' \
  CAPTURE_CONFIG="${config_smoke}/metadata-opencode.json" \
  bash "${SCRIPT_DIR}/run.sh"
jq -e --arg ultra "${ULTRA_PROTOCOL}" '(.instructions | index($ultra)) == null' "${config_smoke}/metadata-opencode.json" >/dev/null

small="${tmp}/small"
mkdir -p "$small"
printf 'small prompt\n' > "${small}/prompt.md"
BOT_WORKDIR="$small" BOT_PROMPT_INLINE_MAX=100 bash "${SCRIPT_DIR}/compact-prompt.sh" >/dev/null
[[ "$(cat "${small}/prompt.md")" == "small prompt" ]]
[[ ! -e "${small}/ctx/prompt-full.md" ]]

large="${tmp}/large"
mkdir -p "$large"
printf '%*s\n' 200 '' | tr ' ' x > "${large}/prompt.md"
BOT_WORKDIR="$large" BOT_PROMPT_INLINE_MAX=100 bash "${SCRIPT_DIR}/compact-prompt.sh" >/dev/null
[[ -f "${large}/ctx/prompt-full.md" ]]
grep -Fq "${large}/ctx/prompt-full.md" "${large}/prompt.md"
grep -Fq "Read that file first" "${large}/prompt.md"
[[ "$(wc -c < "${large}/ctx/prompt-full.md")" -gt 100 ]]

review_context="$({
  sed -n '/^ctx_pr_review()/,/^}/p' "${SCRIPT_DIR}/context.sh"
} 2>/dev/null)"
grep -Fq 'ctx_pr_review "$num"' "${SCRIPT_DIR}/route.sh"
grep -Fq 'BOT_SKIP_PR_INSPECT=1' "${SCRIPT_DIR}/route.sh"
grep -Fq 'setenv BOT_SKIP_PR_INSPECT "$BOT_SKIP_PR_INSPECT"' "${SCRIPT_DIR}/route.sh"
grep -Fq 'setenv BOT_PR_IS_FORK "$BOT_PR_IS_FORK"' "${SCRIPT_DIR}/route.sh"
grep -Fq 'pr_fork_via_api "$num"; is_fork="$BOT_PR_IS_FORK"' "${SCRIPT_DIR}/route.sh"
grep -Fq 'set_pr_fork "$(j ' "${SCRIPT_DIR}/route.sh"
grep -Fq '[[ "$is_fork" == 1 ]] && effective_cw=0' "${SCRIPT_DIR}/route.sh"
grep -Fq 'setenv BOT_CAN_WRITE "$effective_cw"; setenv BOT_TASK engage' "${SCRIPT_DIR}/route.sh"
if grep -Fq '[[ "$is_fork" == 1 ]] && cw=0' "${SCRIPT_DIR}/route.sh"; then
  echo "fork PR routing must keep actor authority separate from code-write permission" >&2
  exit 1
fi
grep -Fq '"${BOT_SKIP_PR_INSPECT:-0}" != "1"' "${SCRIPT_DIR}/prepare-env.sh"
grep -Fq 'git remote set-url origin "https://github.com/${GH_REPO}.git"' "${SCRIPT_DIR}/prepare-env.sh"
[[ -x "${SCRIPT_DIR}/review-meta.sh" ]]
grep -Fq 'review-meta.sh" "${HOME}/.local/bin/cchp-review-meta"' "${SCRIPT_DIR}/run.sh"
grep -Fq 'external_directory: $external_directory_permission' "${SCRIPT_DIR}/run.sh"
grep -Fq -- '--json number,title,url,state,isDraft' <<<"${review_context}"
if grep -Eq -- '--comments|--json reviews' <<<"${review_context}"; then
  echo "pr_opened review context must exclude prior comments/reviews" >&2
  exit 1
fi

route_mock_bin="${tmp}/route-mock-bin"
mkdir -p "${route_mock_bin}"
cat > "${route_mock_bin}/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
joined="$*"
case "${joined}" in
  "api repos/example/repo/collaborators/member/permission "*) printf 'y\n' ;;
  "api repos/example/repo/collaborators/"*"/permission "*) printf 'n\n' ;;
  "api orgs/example/members/"*) exit 1 ;;
  "api repos/example/repo/pulls/7 --jq .base.ref") printf 'dev\n' ;;
  "api repos/example/repo/pulls/7 --jq .head.ref") printf 'fork-feature\n' ;;
  "api repos/example/repo/pulls/7 --jq .head.sha") printf '%040d\n' 1 ;;
  "api repos/example/repo/pulls/7 --jq .head.repo.full_name // empty")
    [[ "${MOCK_HEAD_REPO_MODE:-fork}" != "fail" ]] || exit 1
    printf 'contributor/repo\n'
    ;;
  "pr view "*) printf 'mock PR context\n' ;;
  "pr diff "*) printf 'diff --git a/file b/file\n+new content\n' ;;
  api*) ;;
  *) printf 'unexpected mock gh invocation: %s\n' "${joined}" >&2; exit 2 ;;
esac
MOCK
chmod +x "${route_mock_bin}/gh"

run_route_case() { # $1=name $2=actor $3=head-repo-mode
  local name="$1" actor="$2" head_mode="$3"
  local work="${tmp}/route-${name}"
  mkdir -p "${work}"
  jq -n --arg actor "$actor" '{
    action: "created",
    comment: {id: 99, user: {login: $actor}, body: "please inspect"},
    issue: {number: 7, pull_request: {url: "https://api.github.test/pulls/7"}}
  }' > "${work}/event.json"
  : > "${work}/github-env"
  : > "${work}/github-output"
  env PATH="${route_mock_bin}:${PATH}" MOCK_HEAD_REPO_MODE="$head_mode" \
    GITHUB_EVENT_NAME=issue_comment GITHUB_EVENT_PATH="${work}/event.json" \
    GH_REPO=example/repo BOT_SLUG=cchp-automation BOT_WORKDIR="$work" GH_TOKEN=test \
    GITHUB_ENV="${work}/github-env" GITHUB_OUTPUT="${work}/github-output" \
    bash "${SCRIPT_DIR}/route.sh"
  grep -Fxq 'BOT_PR_IS_FORK=1' "${work}/github-env"
  if grep -Fq 'BOT_TRIGGER_TRUSTED=' "${work}/github-env"; then
    echo "fork routing must not use actor trust to relax untrusted PR content" >&2
    exit 1
  fi
  grep -Fxq 'BOT_CAN_WRITE=0' "${work}/github-env"
  grep -Fxq 'needs_write=false' "${work}/github-output"
  grep -Fxq 'act=true' "${work}/github-output"
  [[ -s "${work}/ctx/pr-diff.patch" ]]
}

run_route_case member-fork member fork
run_route_case api-failure-outsider outsider fail

context_mock_bin="${tmp}/context-mock-bin"
mkdir -p "${context_mock_bin}"
cat > "${context_mock_bin}/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == pr && "$2" == view ]]; then
  printf '{"number":7,"title":"test review","url":"https://example.invalid/pr/7","state":"OPEN","isDraft":false,"author":{"login":"test"},"baseRefName":"dev","baseRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headRefName":"feature","headRefOid":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","body":"","additions":1,"deletions":0,"changedFiles":1,"files":[{"path":"a.txt","additions":1,"deletions":0}]}\n'
  exit 0
fi
if [[ "$1" == pr && "$2" == diff ]]; then
  printf 'diff\n' >> "${MOCK_GH_LOG:?}"
  case "${MOCK_GH_DIFF_MODE:-success}" in
    success) printf 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1 @@\n+review me\n' ;;
    fail) printf 'mock diff failure\n' >&2; exit 23 ;;
    oversize) printf '%080d\n' 0 ;;
    *) exit 24 ;;
  esac
  exit 0
fi
if [[ "$1" == api ]]; then
  joined="$*"
  case "$joined" in
    "api repos/example/repo/compare/"*) printf '{"merge_base_commit":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}\n' ;;
    *"pulls/7/files?per_page=100"*) printf '[{"filename":"a.txt","status":"modified","additions":1,"deletions":0,"changes":1,"patch":"@@ -0,0 +1 @@\\n+review me"}]\n' ;;
    *"pulls/7/commits?per_page=100"*) printf '[{"sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","commit":{"message":"test"}}]\n' ;;
    *) exit 26 ;;
  esac
  exit 0
fi
exit 25
MOCK
chmod +x "${context_mock_bin}/gh"

context_success="${tmp}/context-success"
mkdir -p "${context_success}/ctx"
: > "${context_success}/prompt.md"
: > "${context_success}/gh.log"
(
  export PATH="${context_mock_bin}:${PATH}"
  export MOCK_GH_LOG="${context_success}/gh.log"
  export MOCK_GH_DIFF_MODE=success
  REPO=example/repo
  PROMPT="${context_success}/prompt.md"
  CTX_DIR="${context_success}/ctx"
  CTX_INLINE_MAX=1
  CTX_PR_DIFF_MAX_BYTES=1024
  CTX_PR_DIFF_TIMEOUT_SECONDS=10
  # shellcheck source=context.sh
  source "${SCRIPT_DIR}/context.sh"
  ctx_pr_review 7 ''
)
grep -Fq 'diff --git a/a.txt b/a.txt' "${context_success}/ctx/pr-diff.patch"
grep -Fq "${context_success}/ctx/context.md" "${context_success}/prompt.md"
grep -Fq "${context_success}/ctx/pr-diff.patch" "${context_success}/prompt.md"
grep -Fq 'Read that absolute path with the built-in Read tool' "${context_success}/prompt.md"
grep -Fq 'UNTRUSTED data' "${context_success}/prompt.md"
grep -Fxq 'diff' "${context_success}/gh.log"
[[ -s "${context_success}/ctx/review-manifest.json" ]]
jq -e '.complete == true and .pull_request.base_sha == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" and .pull_request.head_sha == "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" and .files[0].hunk_headers == ["@@ -0,0 +1 @@"]' "${context_success}/ctx/review-manifest.json" >/dev/null
grep -Fq "${context_success}/ctx/review-manifest.json" "${context_success}/prompt.md"

context_skip="${tmp}/context-skip"
mkdir -p "${context_skip}/ctx"
: > "${context_skip}/prompt.md"
: > "${context_skip}/gh.log"
(
  export PATH="${context_mock_bin}:${PATH}"
  export MOCK_GH_LOG="${context_skip}/gh.log"
  export MOCK_GH_DIFF_MODE=success
  REPO=example/repo
  PROMPT="${context_skip}/prompt.md"
  CTX_DIR="${context_skip}/ctx"
  BOT_SKIP_PR_INSPECT=1
  # shellcheck source=context.sh
  source "${SCRIPT_DIR}/context.sh"
  ctx_pr_review 7 ''
)
[[ ! -e "${context_skip}/ctx/pr-diff.patch" ]]
[[ ! -e "${context_skip}/ctx/review-manifest.json" ]]
[[ ! -s "${context_skip}/gh.log" ]]
grep -Fq 'Skipped by policy for this metadata-only PR edit' "${context_skip}/prompt.md"

context_failure="${tmp}/context-failure"
mkdir -p "${context_failure}/ctx"
: > "${context_failure}/prompt.md"
: > "${context_failure}/gh.log"
(
  export PATH="${context_mock_bin}:${PATH}"
  export MOCK_GH_LOG="${context_failure}/gh.log"
  export MOCK_GH_DIFF_MODE=fail
  REPO=example/repo
  PROMPT="${context_failure}/prompt.md"
  CTX_DIR="${context_failure}/ctx"
  # shellcheck source=context.sh
  source "${SCRIPT_DIR}/context.sh"
  ctx_pr_review 7 ''
)
[[ ! -e "${context_failure}/ctx/pr-diff.patch" ]]
[[ ! -e "${context_failure}/ctx/pr-diff.patch.tmp" ]]
[[ ! -e "${context_failure}/ctx/review-manifest.json" ]]
[[ -s "${context_failure}/ctx/pr-diff.err" ]]
grep -Fq 'Complete current PR diff — UNAVAILABLE' "${context_failure}/prompt.md"
grep -Fq 'diff fetch failed, timed out, or returned an empty patch' "${context_failure}/prompt.md"
grep -Fq 'Do not claim that a complete ultrareview was performed' "${context_failure}/prompt.md"

context_oversize="${tmp}/context-oversize"
mkdir -p "${context_oversize}/ctx"
: > "${context_oversize}/prompt.md"
: > "${context_oversize}/gh.log"
(
  export PATH="${context_mock_bin}:${PATH}"
  export MOCK_GH_LOG="${context_oversize}/gh.log"
  export MOCK_GH_DIFF_MODE=oversize
  REPO=example/repo
  PROMPT="${context_oversize}/prompt.md"
  CTX_DIR="${context_oversize}/ctx"
  CTX_PR_DIFF_MAX_BYTES=32
  # shellcheck source=context.sh
  source "${SCRIPT_DIR}/context.sh"
  ctx_pr_review 7 ''
)
[[ ! -e "${context_oversize}/ctx/pr-diff.patch" ]]
[[ ! -e "${context_oversize}/ctx/pr-diff.patch.tmp" ]]
[[ ! -e "${context_oversize}/ctx/review-manifest.json" ]]
grep -Fq 'exceeded the 32-byte safety limit' "${context_oversize}/prompt.md"
grep -Fq 'No partial diff was exposed' "${context_oversize}/prompt.md"
grep -Fq 'Do not claim that a complete ultrareview was performed' "${context_oversize}/prompt.md"

# shellcheck source=permissions.sh
source "${SCRIPT_DIR}/permissions.sh"
review_permission="$(build_opencode_permission "$tmp/review" 1 pr_opened 0)"
jq -e --arg workdir "$tmp/review/*" --arg artifacts "$tmp/review/ctx/review/*" --arg reply "$tmp/review/ctx/reply.md" '
  .edit["*"] == "deny" and
  .edit[$artifacts] == "allow" and
  .edit[$reply] == "allow" and
  .edit["../ctx/review/*"] == "allow" and
  .edit["../ctx/reply.md"] == "allow" and
  .bash["*"] == "deny" and
  .bash["cchp-review-meta *"] == "allow" and
  .external_directory["*"] == "ask" and
  .external_directory[$workdir] == "allow"
' <<<"${review_permission}" >/dev/null

fork_review_permission="$(build_opencode_permission "$tmp/fork-review" 1 pr_opened 1)"
jq -e --arg ctx "$tmp/fork-review/ctx/*" --arg artifacts "$tmp/fork-review/ctx/review/*" --arg reply "$tmp/fork-review/ctx/reply.md" --arg workdir "$tmp/fork-review/*" '
  .edit["*"] == "deny" and
  .edit[$artifacts] == "allow" and
  .edit[$reply] == "allow" and
  .edit["../ctx/review/*"] == "allow" and
  .edit["../ctx/reply.md"] == "allow" and
  (.read | has("*.git/*") | not) and
  .external_directory["*"] == "deny" and
  .external_directory[$ctx] == "allow" and
  (.external_directory | has($workdir) | not) and
  .bash["*"] == "deny" and
  .bash["cchp-review-meta *"] == "allow" and
  .bash["cchp-review-meta *;*"] == "deny" and
  .bash["cchp-review-meta *$*"] == "deny"
' <<<"${fork_review_permission}" >/dev/null

fork_engage_permission="$(build_opencode_permission "$tmp/fork-engage" 0 engage 1)"
jq -e --arg ctx "$tmp/fork-engage/ctx/*" --arg reply "$tmp/fork-engage/ctx/reply.md" --arg workdir "$tmp/fork-engage/*" '
  .edit["*"] == "deny" and
  .edit[$reply] == "allow" and
  (.read | has("*.git/*") | not) and
  .external_directory["*"] == "deny" and
  .external_directory[$ctx] == "allow" and
  (.external_directory | has($workdir) | not) and
  .bash["*"] == "deny" and
  .bash["cchp-review-meta *"] == "allow"
' <<<"${fork_engage_permission}" >/dev/null

fork_member_engage_permission="$(build_opencode_permission "$tmp/fork-member-engage" 0 engage 1)"
jq -e --arg ctx "$tmp/fork-member-engage/ctx/*" --arg reply "$tmp/fork-member-engage/ctx/reply.md" --arg workdir "$tmp/fork-member-engage/*" '
  .edit["*"] == "deny" and
  .edit[$reply] == "allow" and
  .external_directory["*"] == "deny" and
  .external_directory[$ctx] == "allow" and
  (.external_directory | has($workdir) | not) and
  .bash["*"] == "deny" and
  .bash["cchp-review-meta *"] == "allow"
' <<<"${fork_member_engage_permission}" >/dev/null

same_repo_external_engage_permission="$(build_opencode_permission "$tmp/same-repo-external-engage" 0 engage 0 0)"
jq -e --arg workdir "$tmp/same-repo-external-engage/*" '
  .edit == "deny" and
  (has("bash") | not) and
  .external_directory["*"] == "ask" and
  .external_directory[$workdir] == "allow"
' <<<"${same_repo_external_engage_permission}" >/dev/null

fork_merge_permission="$(build_opencode_permission "$tmp/fork-merge" 1 lgtm_merge 1)"
jq -e --arg ctx "$tmp/fork-merge/ctx/*" --arg reply "$tmp/fork-merge/ctx/reply.md" --arg workdir "$tmp/fork-merge/*" '
  .edit["*"] == "deny" and
  .edit[$reply] == "allow" and
  .external_directory["*"] == "deny" and
  .external_directory[$ctx] == "allow" and
  (.external_directory | has($workdir) | not) and
  .bash["*"] == "deny" and
  .bash["cchp-review-meta *"] == "allow"
' <<<"${fork_merge_permission}" >/dev/null

mock_bin="${tmp}/mock-bin"
mkdir -p "${mock_bin}"
mock_gh="${mock_bin}/gh"
cat > "${mock_gh}" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1" == project && "$2" == view ]]; then
  printf 'PVT_project\n'
  exit 0
fi
if [[ "$1" == label && "$2" == view && "${MOCK_LABEL_MISSING:-0}" == 1 ]]; then
  exit 1
fi
printf '%s\n' "$@"
MOCK
chmod +x "${mock_gh}"

wrapper_env=(PATH="${mock_bin}:${PATH}" GH_REPO=example/repo BOT_PR_NUMBER=7 BOT_ROADMAP_PROJECT=1)
title_args="$(env "${wrapper_env[@]}" "${SCRIPT_DIR}/review-meta.sh" pr-title 'fix: normalized title')"
grep -Fxq 'pr' <<<"${title_args}"
grep -Fxq '7' <<<"${title_args}"
grep -Fxq -- '--title' <<<"${title_args}"
grep -Fxq 'fix: normalized title' <<<"${title_args}"

fork_workdir="${tmp}/fork-wrapper"
mkdir -p "${fork_workdir}/ctx"
printf 'first line\n\nsecond line with `code`\n' > "${fork_workdir}/ctx/reply.md"
fork_wrapper_env=("${wrapper_env[@]}" BOT_WORKDIR="${fork_workdir}" BOT_TASK=engage BOT_CAN_WRITE=0 BOT_PR_IS_FORK=1)
fork_comment_args="$(env "${fork_wrapper_env[@]}" "${SCRIPT_DIR}/review-meta.sh" pr-comment 'review finding')"
grep -Fxq 'pr' <<<"${fork_comment_args}"
grep -Fxq '7' <<<"${fork_comment_args}"
grep -Fxq -- '--body' <<<"${fork_comment_args}"
fork_comment_file_args="$(env "${fork_wrapper_env[@]}" "${SCRIPT_DIR}/review-meta.sh" pr-comment-file)"
grep -Fxq -- '--body-file' <<<"${fork_comment_file_args}"
grep -Fxq "${fork_workdir}/ctx/reply.md" <<<"${fork_comment_file_args}"
mv "${fork_workdir}/ctx/reply.md" "${fork_workdir}/ctx/reply-target.md"
ln -s "${fork_workdir}/ctx/reply-target.md" "${fork_workdir}/ctx/reply.md"
if env "${fork_wrapper_env[@]}" "${SCRIPT_DIR}/review-meta.sh" pr-comment-file >/dev/null 2>&1; then
  echo "fork PR reply file must reject symlinks" >&2
  exit 1
fi
rm -f "${fork_workdir}/ctx/reply.md" "${fork_workdir}/ctx/reply-target.md"
if env "${fork_wrapper_env[@]}" "${SCRIPT_DIR}/review-meta.sh" pr-comment-file >/dev/null 2>&1; then
  echo "fork PR reply file must exist" >&2
  exit 1
fi
env "${fork_wrapper_env[@]}" "${SCRIPT_DIR}/review-meta.sh" pr-title 'fix: fork title' >/dev/null
env "${fork_wrapper_env[@]}" "${SCRIPT_DIR}/review-meta.sh" pr-close 'clearly spam' >/dev/null
env "${fork_wrapper_env[@]}" "${SCRIPT_DIR}/review-meta.sh" pr-lock spam >/dev/null
fork_spam_label_args="$(env "${fork_wrapper_env[@]}" "${SCRIPT_DIR}/review-meta.sh" pr-triage-label spam)"
grep -Fxq -- '--add-label' <<<"${fork_spam_label_args}"
grep -Fxq 'spam' <<<"${fork_spam_label_args}"
fork_invalid_label_args="$(env "${fork_wrapper_env[@]}" MOCK_LABEL_MISSING=1 \
  "${SCRIPT_DIR}/review-meta.sh" pr-triage-label invalid)"
grep -Fxq 'label' <<<"${fork_invalid_label_args}"
grep -Fxq 'create' <<<"${fork_invalid_label_args}"
grep -Fxq 'e4e669' <<<"${fork_invalid_label_args}"
grep -Fxq -- '--add-label' <<<"${fork_invalid_label_args}"
if env "${fork_wrapper_env[@]}" "${SCRIPT_DIR}/review-meta.sh" pr-triage-label arbitrary >/dev/null 2>&1; then
  echo "fork PR triage label must reject arbitrary labels" >&2
  exit 1
fi
for forbidden_op in issue-title milestone-list milestone-create project-items tag-list pr-label; do
  if env "${fork_wrapper_env[@]}" "${SCRIPT_DIR}/review-meta.sh" "${forbidden_op}" >/dev/null 2>&1; then
    echo "fork PR review must reject review-meta operation: ${forbidden_op}" >&2
    exit 1
  fi
done

fork_merge_env=("${wrapper_env[@]}" BOT_TASK=lgtm_merge BOT_PR_IS_FORK=1 BOT_HEAD_SHA=0123456789abcdef0123456789abcdef01234567)
fork_label_args="$(env "${fork_merge_env[@]}" "${SCRIPT_DIR}/review-meta.sh" pr-lgtm-label)"
grep -Fxq 'pr' <<<"${fork_label_args}"
grep -Fxq 'edit' <<<"${fork_label_args}"
grep -Fxq -- '--add-label' <<<"${fork_label_args}"
grep -Fxq 'LGTM' <<<"${fork_label_args}"
fork_merge_args="$(env "${fork_merge_env[@]}" "${SCRIPT_DIR}/review-meta.sh" pr-merge)"
grep -Fxq 'merge' <<<"${fork_merge_args}"
grep -Fxq -- '--squash' <<<"${fork_merge_args}"
grep -Fxq -- '--match-head-commit' <<<"${fork_merge_args}"
grep -Fxq '0123456789abcdef0123456789abcdef01234567' <<<"${fork_merge_args}"
if env "${fork_merge_env[@]}" BOT_HEAD_SHA=bad "${SCRIPT_DIR}/review-meta.sh" pr-merge >/dev/null 2>&1; then
  echo "fork PR merge must reject an invalid head SHA" >&2
  exit 1
fi

milestone_args="$(env "${wrapper_env[@]}" "${SCRIPT_DIR}/review-meta.sh" milestone-create v0.2.0)"
grep -Fxq 'api' <<<"${milestone_args}"
grep -Fxq -- '--method' <<<"${milestone_args}"
grep -Fxq 'POST' <<<"${milestone_args}"
grep -Fxq 'repos/example/repo/milestones' <<<"${milestone_args}"

milestone_list_args="$(env "${wrapper_env[@]}" "${SCRIPT_DIR}/review-meta.sh" milestone-list)"
grep -Fxq 'repos/example/repo/milestones?state=all' <<<"${milestone_list_args}"
grep -Fxq -- '--paginate' <<<"${milestone_list_args}"

status_args="$(env "${wrapper_env[@]}" "${SCRIPT_DIR}/review-meta.sh" project-item-status PVTI_item PVTSSF_field option_id)"
grep -Fxq 'project' <<<"${status_args}"
grep -Fxq 'item-edit' <<<"${status_args}"
grep -Fxq -- '--single-select-option-id' <<<"${status_args}"

project_items_args="$(env "${wrapper_env[@]}" "${SCRIPT_DIR}/review-meta.sh" project-items)"
grep -Fxq 'item-list' <<<"${project_items_args}"
grep -Fxq '1' <<<"${project_items_args}"
grep -Fxq 'example' <<<"${project_items_args}"

tag_args="$(env "${wrapper_env[@]}" "${SCRIPT_DIR}/review-meta.sh" tag-list)"
grep -Fxq 'repos/example/repo/tags' <<<"${tag_args}"
grep -Fxq -- '--paginate' <<<"${tag_args}"

if env "${wrapper_env[@]}" "${SCRIPT_DIR}/review-meta.sh" \
  project-item-add https://github.com/other/repo/issues/1 >/dev/null 2>&1; then
  echo "review-meta must reject cross-repository project items" >&2
  exit 1
fi
if env "${wrapper_env[@]}" "${SCRIPT_DIR}/review-meta.sh" \
  pr-title title unexpected >/dev/null 2>&1; then
  echo "review-meta must reject extra arguments" >&2
  exit 1
fi
if env PATH="${mock_bin}:${PATH}" GH_REPO=example/repo BOT_PR_NUMBER=0 BOT_ROADMAP_PROJECT=1 \
  "${SCRIPT_DIR}/review-meta.sh" pr-title title >/dev/null 2>&1; then
  echo "review-meta must reject invalid issue/PR numbers" >&2
  exit 1
fi
if env "${wrapper_env[@]}" "${SCRIPT_DIR}/review-meta.sh" \
  pr-comment $'line one\nline two' >/dev/null 2>&1; then
  echo "review-meta must reject multiline shell metadata" >&2
  exit 1
fi
if env "${wrapper_env[@]}" "${SCRIPT_DIR}/review-meta.sh" \
  pr-comment 'unsafe; command' >/dev/null 2>&1; then
  echo "review-meta must reject shell control characters in metadata" >&2
  exit 1
fi
if env "${wrapper_env[@]}" "${SCRIPT_DIR}/review-meta.sh" \
  pr-title '$GH_TOKEN' >/dev/null 2>&1; then
  echo "review-meta must reject literal environment expansion syntax" >&2
  exit 1
fi
if env "${wrapper_env[@]}" "${SCRIPT_DIR}/review-meta.sh" \
  project-item-status 'bad/id' field option >/dev/null 2>&1; then
  echo "review-meta must reject invalid project node IDs" >&2
  exit 1
fi
if env PATH="${mock_bin}:${PATH}" GH_REPO=example/repo BOT_PR_NUMBER=7 BOT_ROADMAP_PROJECT=0 \
  "${SCRIPT_DIR}/review-meta.sh" project-item-archive item >/dev/null 2>&1; then
  echo "review-meta must reject an invalid roadmap project scope" >&2
  exit 1
fi
if env "${wrapper_env[@]}" "${SCRIPT_DIR}/review-meta.sh" \
  label-create spam invalid >/dev/null 2>&1; then
  echo "review-meta must reject invalid label colors" >&2
  exit 1
fi

if grep -Eq 'permission-(statuses|checks):[[:space:]]*write' "${SCRIPT_DIR}/../workflows/cchp-bot.yml"; then
  echo "cchp bot tokens must not receive status/check write permissions" >&2
  exit 1
fi

write_permission="$(build_opencode_permission "$tmp/write" 1 ci_fix)"
jq -e 'has("edit") | not' <<<"${write_permission}" >/dev/null
jq -e 'has("bash") | not' <<<"${write_permission}" >/dev/null

readonly_permission="$(build_opencode_permission "$tmp/readonly" 0 engage)"
jq -e '.edit == "deny" and (has("bash") | not)' <<<"${readonly_permission}" >/dev/null

# --- additive block: review philosophy + external scanner evidence contract ---
SYSTEM_PROMPT_MD="${SCRIPT_DIR}/system-prompt.md"
CODE_REVIEW_CMD="${SCRIPT_DIR}/../opencode/command/code-review.md"
# Google eng-practices absorption: approval standard + severity labels
grep -Fq 'improves overall code health' "${SYSTEM_PROMPT_MD}"
grep -Fq 'no perfect code, only better code' "${SYSTEM_PROMPT_MD}"
grep -Fq 'Nit:' "${SYSTEM_PROMPT_MD}"
grep -Fq 'Optional:' "${SYSTEM_PROMPT_MD}"
grep -Fq 'FYI:' "${SYSTEM_PROMPT_MD}"
# Greiler checklist absorption: eight coverage domains
grep -Fq 'intent & correctness' "${SYSTEM_PROMPT_MD}"
grep -Fq 'design & maintainability' "${SYSTEM_PROMPT_MD}"
grep -Fq 'impact & dependencies' "${SYSTEM_PROMPT_MD}"
grep -Fq 'reliability & observability' "${SYSTEM_PROMPT_MD}"
grep -Fq 'security, privacy & societal' "${SYSTEM_PROMPT_MD}"
grep -Fq 'performance & resources' "${SYSTEM_PROMPT_MD}"
grep -Fq 'tests & verification' "${SYSTEM_PROMPT_MD}"
grep -Fq 'product quality & ownership' "${SYSTEM_PROMPT_MD}"
# External scanner evidence contract: candidates, never scope/completion proof
grep -Fq 'ctx/external/status.json' "${SYSTEM_PROMPT_MD}"
grep -Fq 'ctx/external/findings.json' "${SYSTEM_PROMPT_MD}"
grep -Fq 'ctx/external' "${ULTRA_PROTOCOL}"
grep -Fq 'UNVERIFIED candidate' "${ULTRA_PROTOCOL}"
grep -Fq 'ctx/external' "${CODE_REVIEW_CMD}"
grep -Fq 'UNVERIFIED candidate' "${CODE_REVIEW_CMD}"

# --- additive block: interactive action-menu routing (checkbox replaces reactions) ---
run_action_case() { # $1=name $2=sender $3=old-body $4=new-body
  local name="$1" sender="$2" old_body="$3" new_body="$4"
  local work="${tmp}/action-${name}"
  mkdir -p "${work}"
  jq -n --arg sender "$sender" --arg old "$old_body" --arg new "$new_body" '{
    action: "edited",
    sender: {login: $sender},
    comment: {id: 555, user: {login: "cchp-automation[bot]"}, body: $new},
    changes: {body: {from: $old}},
    issue: {number: 7}
  }' > "${work}/event.json"
  : > "${work}/github-env"
  : > "${work}/github-output"
  env PATH="${route_mock_bin}:${PATH}" \
    GITHUB_EVENT_NAME=issue_comment GITHUB_EVENT_PATH="${work}/event.json" \
    GH_REPO=example/repo BOT_SLUG=cchp-automation BOT_WORKDIR="$work" GH_TOKEN=test \
    GITHUB_ENV="${work}/github-env" GITHUB_OUTPUT="${work}/github-output" \
    bash "${SCRIPT_DIR}/route.sh"
}

menu_unchecked='Pick one:
- [ ] Re-run the review <!-- cchp-action:rerun-review -->
- [ ] Implement the plan <!-- cchp-action:implement-plan -->'
menu_checked='Pick one:
- [x] Re-run the review <!-- cchp-action:rerun-review -->
- [ ] Implement the plan <!-- cchp-action:implement-plan -->'

# member checks a box on the bot menu → engage with the selected action id
run_action_case member-check member "$menu_unchecked" "$menu_checked"
grep -Fxq 'BOT_TASK=engage' "${tmp}/action-member-check/github-env"
grep -Fxq 'BOT_ISSUE_NUMBER=7' "${tmp}/action-member-check/github-env"
grep -Fxq 'BOT_CAN_WRITE=1' "${tmp}/action-member-check/github-env"
grep -Fxq 'act=true' "${tmp}/action-member-check/github-output"
grep -Fxq 'needs_write=true' "${tmp}/action-member-check/github-output"
grep -Fq "checked the action box 'rerun-review'" "${tmp}/action-member-check/prompt.md"
grep -Fq "RESET its checkbox" "${tmp}/action-member-check/prompt.md"

# non-member checking a box must not trigger anything
run_action_case outsider-check outsider "$menu_unchecked" "$menu_checked"
grep -Fxq 'act=false' "${tmp}/action-outsider-check/github-output"

# an edit that does not newly check any box is a no-op
run_action_case no-new-check member "$menu_checked" "$menu_checked"
grep -Fxq 'act=false' "${tmp}/action-no-new-check/github-output"

# the bot editing its own menu (ack/reset) must never re-trigger
run_action_case bot-self-edit 'cchp-automation[bot]' "$menu_unchecked" "$menu_checked"
grep -Fxq 'act=false' "${tmp}/action-bot-self-edit/github-output"

echo "compact-prompt tests passed"
