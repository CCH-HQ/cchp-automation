#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Engine root, canonicalized: run.sh derives ENGINE_DIR the same way, so the
# absolute paths it renders into prompt/config match these test expectations.
ENGINE_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
SRC_DIR="${ENGINE_ROOT}/src"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

ULTRA_PROTOCOL="${ENGINE_ROOT}/opencode/review/ultra-protocol.md"
ULTRA_PLUGIN="${ENGINE_ROOT}/opencode/plugin/ultra-review-runner.ts"
REVIEW_GUARD="${ENGINE_ROOT}/opencode/plugin/review-artifact-guard.ts"
REFERENCE_CATALOG="${ENGINE_ROOT}/opencode/review/reference-library/catalog.json"
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
# Coordinator agent is now selectable: Sisyphus when oh-my-openagent installed,
# else the built-in build agent. Ultra pipeline (review subagents / ultra_review_task
# / finalize gates / session-level read-only perms) is unchanged — only the
# coordinating agent type differs.
grep -Fq 'opencode run --auto --agent "${COORD_AGENT}" --variant max' "${SCRIPT_DIR}/run.sh"
grep -Fq 'COORD_AGENT=build' "${SCRIPT_DIR}/run.sh"
grep -Fq 'COORD_AGENT=sisyphus' "${SCRIPT_DIR}/run.sh"
# run.sh builds these from ${OPENCODE_DIR} (= $ENGINE_DIR/opencode), so only the
# path suffix is a stable literal there.
grep -Fq '/review/ultra-protocol.md' "${SCRIPT_DIR}/run.sh"
grep -Fq '/plugin/ultra-review-runner.ts' "${SCRIPT_DIR}/run.sh"

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
  BOT_PROMPT_FILE="${config_smoke}/prompt.md" \
  BOT_SYSTEM_PROMPT="${ENGINE_ROOT}/opencode/system-prompt.md" BOT_TASK=pr_opened \
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
  BOT_PROMPT_FILE="${config_smoke}/prompt.md" \
  BOT_SYSTEM_PROMPT="${ENGINE_ROOT}/opencode/system-prompt.md" BOT_TASK=pr_opened BOT_SKIP_PR_INSPECT=1 \
  BOT_CAN_WRITE=1 BOT_REPO=example/repo BOT_PR_NUMBER=7 \
  BOT_HEAD_SHA=0123456789abcdef0123456789abcdef01234567 \
  CCHP_BOT_MODEL=relay/gpt-5.6-sol \
  CCHP_BOT_PROVIDERS='{"relay":{"format":"openai-responses","base_url":"https://example.invalid/v1","models":{"gpt-5.6-sol":{"context":500000,"output":128000}}}}' \
  CAPTURE_CONFIG="${config_smoke}/metadata-opencode.json" \
  bash "${SCRIPT_DIR}/run.sh"
jq -e --arg ultra "${ULTRA_PROTOCOL}" '(.instructions | index($ultra)) == null' "${config_smoke}/metadata-opencode.json" >/dev/null

# ── agent toolchain wiring: with fff / serena / oh-my-openagent / context-mode
# "installed" (PATH stubs), assert they get wired into the synthesized config,
# the coordinator becomes Sisyphus, every oh-my-openagent agent is pinned to the
# main model + variant max, and context-mode is gated OFF on the untrusted
# pr_opened review path (fff/serena, being read-only, stay).
tc="${tmp}/toolchain-smoke"
mkdir -p "${tc}/home/.local/bin" "${tc}/repo" "${tc}/bin"
printf 'TASK: toolchain smoke\n' > "${tc}/prompt.md"
cat > "${tc}/bin/timeout" <<'MOCK'
#!/usr/bin/env bash
printf '%s' "${OPENCODE_CONFIG_CONTENT:?}" > "${CAPTURE_CONFIG:?}"
MOCK
chmod +x "${tc}/bin/timeout"
for t in fff-mcp serena oh-my-openagent context-mode; do
  printf '#!/usr/bin/env bash\n' > "${tc}/bin/${t}"; chmod +x "${tc}/bin/${t}"
done
tc_run() { # $1=task  $2=capture-file
  env HOME="${tc}/home" PATH="${tc}/bin:${PATH}" \
    BOT_WORKDIR="${tc}" REPO_DIR="${tc}/repo" BOT_PROMPT_FILE="${tc}/prompt.md" \
    BOT_SYSTEM_PROMPT="${ENGINE_ROOT}/opencode/system-prompt.md" BOT_TASK="$1" BOT_SKIP_PR_INSPECT=1 \
    BOT_CAN_WRITE=1 BOT_REPO=example/repo BOT_PR_NUMBER=7 \
    BOT_HEAD_SHA=0123456789abcdef0123456789abcdef01234567 \
    CCHP_BOT_MODEL=relay/gpt-5.6-sol \
    CCHP_BOT_PROVIDERS='{"relay":{"format":"openai-responses","base_url":"https://example.invalid/v1","models":{"gpt-5.6-sol":{"context":500000,"output":128000}}}}' \
    CAPTURE_CONFIG="$2" bash "${SCRIPT_DIR}/run.sh" >/dev/null
}
tc_run engage "${tc}/engage.json"
jq -e '
  (.mcp | has("fff")) and (.mcp | has("serena")) and
  (.mcp.serena.command | index("--enable-web-dashboard")) != null and
  (.plugin | index("context-mode")) != null and
  (.plugin | index("oh-my-openagent@latest")) != null and
  .default_agent == "sisyphus"
' "${tc}/engage.json" >/dev/null
# every oh-my-openagent agent + category pinned to the main model + variant max
jq -e '
  (.agents | length) == 11 and
  (.agents | to_entries | all(.value == {model: "relay/gpt-5.6-sol", variant: "max"})) and
  (.categories | length) == 7 and
  (.disabled_mcps | index("websearch")) != null and
  .telemetry == false and .auto_update == false
' "${tc}/home/.config/opencode/oh-my-openagent.jsonc" >/dev/null
tc_run pr_opened "${tc}/review.json"
jq -e '
  (.plugin | index("context-mode")) == null and
  (.mcp | has("fff")) and (.mcp | has("serena"))
' "${tc}/review.json" >/dev/null

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

# Route + context moved from bash (route.sh / context.sh) into the TS engine
# (src/cli.ts + src/route/* + src/context.ts). The invariants the old greps
# pinned are asserted against the TS sources; behaviour is covered by `bun test`
# (src/route/classify.test.ts, src/context.test.ts, src/review/diff.test.ts).
grep -Fq 'await ctxPrReview(deps, num' "${SRC_DIR}/cli.ts"
grep -Fq 'BOT_SKIP_PR_INSPECT = "1"' "${SRC_DIR}/route/classify.ts"
grep -Fq 'BOT_PR_IS_FORK: fork ? "1" : "0"' "${SRC_DIR}/route/classify.ts"
grep -Fq 'const effectiveCw = fork ? false : cw' "${SRC_DIR}/route/classify.ts"
if grep -Eq '\bcw = fork' "${SRC_DIR}/route/classify.ts"; then
  echo "fork PR routing must keep actor authority separate from code-write permission" >&2
  exit 1
fi
grep -Fq '"${BOT_SKIP_PR_INSPECT:-0}" != "1"' "${SCRIPT_DIR}/prepare-env.sh"
grep -Fq 'git remote set-url origin "https://github.com/${GH_REPO}.git"' "${SCRIPT_DIR}/prepare-env.sh"
[[ -x "${SCRIPT_DIR}/review-meta.sh" ]]
grep -Fq 'review-meta.sh" "${HOME}/.local/bin/cchp-review-meta"' "${SCRIPT_DIR}/run.sh"
grep -Fq 'external_directory: $external_directory_permission' "${SCRIPT_DIR}/run.sh"
review_context="$(sed -n '/^export async function ctxPrReview(/,/^}/p' "${SRC_DIR}/context.ts")"
grep -Fq 'pulls.get' <<<"${review_context}"
if grep -Eq 'listComments|listReviews' <<<"${review_context}"; then
  echo "pr_opened review context must exclude prior comments/reviews" >&2
  exit 1
fi

# Behavioural fork-routing and PR-diff context cases (previously driven through
# bash route.sh / context.sh with a mock `gh`) are exercised by the TS suite
# (`bun test`): src/route/classify.test.ts (fork clamp, act/needs_write,
# skip-inspect), src/context.test.ts (context assembly), and
# src/review/diff.test.ts (diff capture success / skip / failure / oversize).
# Here we pin that those suites exist and that the fail-closed diff messages the
# old bash cases asserted are still emitted by the TS implementation.
[[ -f "${SRC_DIR}/route/classify.test.ts" ]]
[[ -f "${SRC_DIR}/context.test.ts" ]]
[[ -f "${SRC_DIR}/review/diff.test.ts" ]]
grep -Fq 'Skipped by policy for this metadata-only PR edit' "${SRC_DIR}/review/diff.ts"
grep -Fq 'Complete current PR diff — UNAVAILABLE' "${SRC_DIR}/review/diff.ts"
grep -Fq 'No partial diff was exposed. Do not claim that a complete ultrareview was performed.' "${SRC_DIR}/review/diff.ts"
grep -Fq -- '-byte safety limit' "${SRC_DIR}/review/diff.ts"

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

if grep -Eq 'permission-(statuses|checks):[[:space:]]*write' "${ENGINE_ROOT}/.github/workflows/run.yml"; then
  echo "cchp bot tokens must not receive status/check write permissions" >&2
  exit 1
fi

write_permission="$(build_opencode_permission "$tmp/write" 1 ci_fix)"
jq -e 'has("edit") | not' <<<"${write_permission}" >/dev/null
jq -e 'has("bash") | not' <<<"${write_permission}" >/dev/null

readonly_permission="$(build_opencode_permission "$tmp/readonly" 0 engage)"
jq -e '.edit == "deny" and (has("bash") | not)' <<<"${readonly_permission}" >/dev/null

# --- additive block: review philosophy + external scanner evidence contract ---
SYSTEM_PROMPT_MD="${ENGINE_ROOT}/opencode/system-prompt.md"
CODE_REVIEW_CMD="${ENGINE_ROOT}/opencode/command/code-review.md"
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
# The behavioural cases (member check triggers engage, outsider check no-ops,
# no-new-check no-ops, bot self-edit never re-triggers) run in the TS suite:
# src/types.test.ts (newlyCheckedActionIds) + src/route/classify.test.ts
# (action_menu_* routing). Pin the static wiring here.
grep -Fq 'newlyCheckedActionIds' "${SRC_DIR}/route/classify.ts"
grep -Fq 'action_menu_pr' "${SRC_DIR}/route/classify.ts"
grep -Fq 'cchp-action' "${SRC_DIR}/types.ts"
grep -Fq "checked the action box" "${SRC_DIR}/route/prompts.ts"
grep -Fq "RESET its checkbox" "${SRC_DIR}/route/prompts.ts"
[[ -f "${SRC_DIR}/types.test.ts" ]]
grep -Fq 'cchp-action' "${SRC_DIR}/route/classify.test.ts"

echo "compact-prompt tests passed"
