#!/usr/bin/env bash
# cchp-automation engine — invoke `opencode` headless against the prepared clone.
#
# Behaviour-preserving port of the consumer's .github/cchp-bot/run.sh. The
# model/provider wiring is assembled from the SAME consumer repo variables +
# secrets (CCHP_BOT_* env), UNCHANGED — changing models/gateways stays a
# variables-only change, never a code change. Everything under
# `OPENCODE_CONFIG_CONTENT` (providers/model/instructions/agent/command/plugin/
# compaction) is a faithful copy of the source; only three things are adapted
# for the engine layout:
#   1. asset paths move from .github/cchp-bot/ to the engine's opencode/ +
#      scripts/ dirs;
#   2. the OpenCode MCP config launches the engine Octokit MCP server
#      (`bun src/mcp/server.ts`) instead of the retired inline-comment server;
#   3. the engine ships opencode/system-prompt.md with {{OVERLAY.*}} placeholders
#      that are rendered from the consumer overlay (BOT_* env) before the run.
#
# Per-provider API keys never enter the config string: they are exported into
# the process env (CCHP_PK_<PROVIDER>) and the config references them as
# {env:CCHP_PK_...}. Same for GH_TOKEN in the MCP block.
#
# Engine layout (resolved from this script's own location; override $ENGINE_DIR):
#   $ENGINE_DIR/opencode/{agent,command,plugin,review}   OpenCode assets
#   $ENGINE_DIR/scripts/{permissions,review-meta,review-finalize}.sh  helpers
#   $ENGINE_DIR/src/mcp/server.ts                        Octokit MCP server
#
# Required env:
#   BOT_WORKDIR        isolated scratch dir
#   REPO_DIR           the clone (cwd for opencode)           (= $BOT_WORKDIR/repo)
#   BOT_PROMPT_FILE    task prompt written by route (already size-compacted by
#                      prepare-env.sh → compact-prompt.sh; this script only reads it)
#   GH_TOKEN           App installation token (gh + git + MCP server)
#   BOT_REPO           owner/name the run targets (the MCP server binds its client)
#   CCHP_BOT_PROVIDERS      (repo vars)   JSON provider/deployment definitions
#   CCHP_BOT_MODEL          (repo vars)   "provider/model" main model
#   CCHP_BOT_PROVIDER_KEYS  (repo secret) JSON provider -> API key map
# Optional env:
#   BOT_SYSTEM_PROMPT            override the system-prompt template path
#                               (default: the engine's opencode/system-prompt.md)
#   CCHP_BOT_SMALL_MODEL         "provider/model" for titles/summaries/compaction
#   CCHP_BOT_EXTRA_INSTRUCTIONS  JSON array of instruction paths/URLs
#   CCHP_DISABLE_AUTO_APPROVE    org-var kill-switch: downgrade APPROVE → COMMENT
#   ENGINE_DIR                   engine checkout root (else derived from this file)
#   BOT_PR_NUMBER / BOT_HEAD_SHA / BOT_ISSUE_NUMBER / BOT_TASK / BOT_PR_IS_FORK
#   BOT_CAN_WRITE / BOT_SKIP_PR_INSPECT / BOT_OPENCODE_TIMEOUT
#   Overlay values rendered into the system prompt (sensible fallbacks if unset):
#     BOT_DEFAULT_BRANCH BOT_ROADMAP_PROJECT BOT_ROADMAP_POLICY
#     BOT_SEMVER_WORKFLOW BOT_SEMVER_MARKER BOT_TECH_STACK BOT_LANGUAGES
set -euo pipefail
# See prepare-env.sh: opencode/bun live in ~/.local/bin, never added to
# GITHUB_PATH (zizmor github-env), so every step re-adds it locally.
export PATH="${HOME}/.local/bin:${PATH}"
log() { printf '\033[1;34m[run]\033[0m %s\n' "$*"; }

: "${BOT_WORKDIR:?}" "${REPO_DIR:?}" "${BOT_PROMPT_FILE:?}"
: "${CCHP_BOT_PROVIDERS:?}" "${CCHP_BOT_MODEL:?}"

# ── engine layout (asset roots) ──────────────────────────────────────────────
# run.sh lives at $ENGINE_DIR/scripts/run.sh; derive the engine root from it
# (same BASH_SOURCE idiom as prepare-env.sh) unless $ENGINE_DIR is provided.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="${ENGINE_DIR:-$(cd -- "${SCRIPT_DIR}/.." && pwd)}"
OPENCODE_DIR="${ENGINE_DIR}/opencode"
MCP_SERVER="${ENGINE_DIR}/src/mcp/server.ts"   # replaces mcp/inline-comment-server.mjs
ULTRA_PROTOCOL="${OPENCODE_DIR}/review/ultra-protocol.md"
ULTRA_RUNNER="${OPENCODE_DIR}/plugin/ultra-review-runner.ts"
REVIEW_ARTIFACT_GUARD="${OPENCODE_DIR}/plugin/review-artifact-guard.ts"
REVIEW_FINALIZER="${SCRIPT_DIR}/review-finalize.sh"
export ULTRA_RUNNER REVIEW_ARTIFACT_GUARD   # (mirrored from source; plugins wire their own paths)
CTX_DIR="${BOT_WORKDIR}/ctx"
mkdir -p "${CTX_DIR}/review"   # all plan/review evidence stays outside the clone
if [[ "${BOT_TASK:-}" == "pr_opened" && "${BOT_SKIP_PR_INSPECT:-0}" != "1" ]]; then
  {
    printf '\nULTRA REVIEW PROTOCOL (coordinator only): read the complete protocol at:\n%s\n' "${ULTRA_PROTOCOL}"
    printf 'Use ultra_review_task for all independent review work. Child sessions receive a leaf-only contract.\n'
  } >> "${BOT_PROMPT_FILE}"
fi
# shellcheck source=scripts/permissions.sh
source "${SCRIPT_DIR}/permissions.sh"
install -m 0555 "${SCRIPT_DIR}/review-meta.sh" "${HOME}/.local/bin/cchp-review-meta"
export CCHP_REVIEW_FINALIZER="${REVIEW_FINALIZER}"
export CCHP_TRUSTED_REVIEW_MANIFEST="${CTX_DIR}/review-manifest.json"
EXTERNAL_DIRECTORY_PERMISSION="$(build_external_directory_permission \
  "${BOT_WORKDIR}" "${BOT_TASK:-}" "${BOT_PR_IS_FORK:-0}")"

# ── render the engine system-prompt overlay ──────────────────────────────────
# The engine ships opencode/system-prompt.md with {{OVERLAY.*}} placeholders;
# the consumer overlay supplies their values via BOT_* env (reusable-workflow
# inputs). Substitute them into a rendered copy under ctx/ (never committed);
# unset keys fall back to sensible generic defaults so a bare install still runs.
SYSTEM_PROMPT_TEMPLATE="${BOT_SYSTEM_PROMPT:-${OPENCODE_DIR}/system-prompt.md}"
RENDERED_SYSTEM_PROMPT="${CTX_DIR}/system-prompt.rendered.md"
[[ -f "${SYSTEM_PROMPT_TEMPLATE}" ]] \
  || { log "ERROR: system prompt template not found: ${SYSTEM_PROMPT_TEMPLATE}"; exit 2; }
_sp="$(cat -- "${SYSTEM_PROMPT_TEMPLATE}")"
render_overlay() { local pat="{{OVERLAY.$1}}"; _sp="${_sp//"$pat"/"$2"}"; }  # $1=key $2=value
render_overlay default_branch  "${BOT_DEFAULT_BRANCH:-main}"
render_overlay roadmap_project "${BOT_ROADMAP_PROJECT:-}"
render_overlay roadmap_policy  "${BOT_ROADMAP_POLICY:-.github/cchp-automation/roadmap-policy.md}"
render_overlay semver_workflow "${BOT_SEMVER_WORKFLOW:-semver-guard}"
render_overlay semver_marker   "${BOT_SEMVER_MARKER:-cchp-semver-guard}"
render_overlay tech_stack      "${BOT_TECH_STACK:-the stack documented in the repository CLAUDE.md files}"
render_overlay languages       "${BOT_LANGUAGES:-the language the user used}"
printf '%s\n' "${_sp}" > "${RENDERED_SYSTEM_PROMPT}"
if grep -q '{{OVERLAY\.' "${RENDERED_SYSTEM_PROMPT}"; then
  log "WARNING: unresolved {{OVERLAY.*}} placeholders remain (add overlay env or update system-prompt.md):"
  grep -oE '\{\{OVERLAY\.[a-z_]+\}\}' "${RENDERED_SYSTEM_PROMPT}" | sort -u | sed 's/^/  /'
fi
BOT_SYSTEM_PROMPT="${RENDERED_SYSTEM_PROMPT}"

# ── per-provider API key → 进程环境变量,config 里只写 {env:…} 引用 ────────────
# per-provider API key → process env; the config only stores {env:…} references,
# so the keys never appear in the OPENCODE_CONFIG_CONTENT string itself.
# NOTE: do not write ${VAR:-{}} — bash treats the first } in the default as the
# closing brace of the expansion.
KEYS_JSON="${CCHP_BOT_PROVIDER_KEYS:-}"
[[ -z "${KEYS_JSON}" ]] && KEYS_JSON='{}'
# provider id → valid bash identifier: uppercase, then every non-[A-Z0-9] → _
# (must match the jq `envref` sanitizer below, else the export name and the
# config reference name won't line up).
while IFS=$'\t' read -r pid key; do
  [[ -z "${pid}" || -z "${key}" ]] && continue
  envname="CCHP_PK_$(printf '%s' "${pid}" | tr '[:lower:]' '[:upper:]' | sed 's/[^A-Z0-9]/_/g')"
  export "${envname}=${key}"
done < <(jq -r 'to_entries[] | [.key, .value] | @tsv' <<<"${KEYS_JSON}")

# Early validation: the main model's provider must exist in CCHP_BOT_PROVIDERS,
# otherwise OpenCode falls back to the built-in models.dev catalog and all
# key/compaction wiring is silently dropped (almost always a config typo).
MAIN_PROVIDER="${CCHP_BOT_MODEL%%/*}"
MAIN_MODEL="${CCHP_BOT_MODEL#*/}"
if ! jq -e --arg p "${MAIN_PROVIDER}" --arg m "${MAIN_MODEL}" '
  .[$p].format != null and
  (.[$p].models[$m] // null) != null and
  (.[$p].models[$m].reasoning != false) and
  ((.[$p].models[$m].upstream_id // $m) | test("(^|/)gpt-5\\.6-sol($|[-/])"))
' <<<"${CCHP_BOT_PROVIDERS}" >/dev/null; then
  log "ERROR: CCHP_BOT_MODEL must resolve to a reasoning gpt-5.6-sol model in CCHP_BOT_PROVIDERS; refusing silent models.dev fallback"
  exit 2
fi

# ── 合成 OpenCode 配置(providers/model/instructions/mcp/agent/command/plugin)──
# Synthesize the OpenCode config. Mapping rules (unchanged from the source):
#   format → npm 包;vision → attachment+modalities;compact_threshold →
#   compaction.reserved = round(context × (1 − threshold)), computed on the main model.
EXTRA_INSTR="$(jq -c '.' <<<"${CCHP_BOT_EXTRA_INSTRUCTIONS:-[]}" 2>/dev/null || echo '[]')"
OPENCODE_CONFIG_CONTENT="$(jq -nc \
  --argjson providers "${CCHP_BOT_PROVIDERS}" \
  --argjson keys "${KEYS_JSON}" \
  --argjson extra "${EXTRA_INSTR}" \
  --arg model "${CCHP_BOT_MODEL}" \
  --arg small "${CCHP_BOT_SMALL_MODEL:-}" \
  --arg sysprompt "${BOT_SYSTEM_PROMPT}" \
  --arg task "${BOT_TASK:-}" \
  --arg mcp "${MCP_SERVER}" \
  --arg botrepo "${BOT_REPO:-}" \
  --arg botpr "${BOT_PR_NUMBER:-}" \
  --arg botissue "${BOT_ISSUE_NUMBER:-}" \
  --arg botsha "${BOT_HEAD_SHA:-}" \
  --arg patch "${CTX_DIR}/pr-diff.patch" \
  --arg trusted_manifest "${CTX_DIR}/review-manifest.json" \
  --arg review_artifacts "${CTX_DIR}/review" \
  --arg review_finalizer "${REVIEW_FINALIZER}" \
  --arg finalized_marker "${CTX_DIR}/review-finalized.json" \
  --arg workdir "${BOT_WORKDIR}" \
  --arg killswitch "${CCHP_DISABLE_AUTO_APPROVE:-}" \
  --argjson external_directory_permission "${EXTERNAL_DIRECTORY_PERMISSION}" \
  --arg opencodedir "${OPENCODE_DIR}" '
  def npm_of($f):
    {"anthropic": "@ai-sdk/anthropic",
     "openai-responses": "@ai-sdk/openai",
     "openai-compatible": "@ai-sdk/openai-compatible"}[$f]
    // error("CCHP_BOT_PROVIDERS: unknown format \"\($f)\"");
  def envref($pid): "{env:CCHP_PK_" + ($pid | ascii_upcase | gsub("[^A-Z0-9]"; "_")) + "}";
  def max_variant($f):
    if $f == "anthropic" then
      { thinking: { type: "adaptive", display: "summarized" }, effort: "max" }
    else
      { reasoningEffort: "max" }
    end;
  def model_obj($mk; $m; $format):
    { name: $mk, tool_call: true,
      reasoning: (if $m.reasoning == false then false else true end) }
    + (if $m.upstream_id then { id: $m.upstream_id } else {} end)
    # OpenCode v1 schema 要求 limit.context 与 limit.output 同时存在:
    # 只给 context 时 output 缺省 32768;没给 context 则整个 limit 省略。
    + (if $m.context then
        { limit: { context: $m.context, output: ($m.output // 32768) } }
      else {} end)
    + (if $m.vision then { attachment: true, modalities: { input: ["text", "image"] } } else {} end)
    # gpt-5.6-sol supports max even when OpenCode model-id heuristics would
    # otherwise synthesize only xhigh/high. Define the variant explicitly so the
    # provider receives reasoningEffort: "max" and every review agent can select it.
    + (if $m.reasoning == false then {} else { variants: { max: max_variant($format) } } end);

  ($model | split("/")) as $mparts |
  ($providers[$mparts[0]] // {}) as $mprov |
  ($mprov.models[($mparts[1:] | join("/"))] // {}) as $mainm |
  (if ($mainm.reasoning != false) and ($mprov.format != null) then "max" else null end) as $mainvariant |

  {
    "$schema": "https://opencode.ai/config.json",
    model: $model,
    provider: ($providers | with_entries(
      .key as $pid | .value as $p | .value = {
        npm: npm_of($p.format),
        name: $pid,
        options: ({ baseURL: $p.base_url }
          + (if ($keys[$pid] // "") != "" then { apiKey: envref($pid) } else {} end)
          + (if $p.headers then { headers: $p.headers } else {} end)),
        models: ($p.models | with_entries(.key as $mk | .value = model_obj($mk; .value; $p.format)))
      })),
    # Extra instructions may add context, but the Ultra protocol remains the
    # final review instruction and cannot be weakened by a variable override.
    instructions: ([$sysprompt] + $extra),
    mcp: { github_inline_comment: {
      type: "local", command: ["bun", $mcp], enabled: true,
      environment: ({ BOT_REPO: $botrepo, BOT_PR_NUMBER: $botpr,
                      BOT_ISSUE_NUMBER: $botissue, BOT_TASK: $task,
                      BOT_HEAD_SHA: $botsha, BOT_PATCH_FILE: $patch,
                      BOT_TRUSTED_REVIEW_MANIFEST: $trusted_manifest,
                      BOT_REVIEW_ARTIFACT_DIR: $review_artifacts,
                      BOT_REVIEW_FINALIZER: $review_finalizer,
                      BOT_REVIEW_FINALIZED_MARKER: $finalized_marker,
                      GH_TOKEN: "{env:GH_TOKEN}" }
        + (if $killswitch != "" then { CCHP_DISABLE_AUTO_APPROVE: $killswitch } else {} end)) } },
    # 思考强度:主线程编排、planner、finder、verifier 全部固定 max。
    # reasoning effort is pinned to max for the coordinator + planner + all reviewers.
    agent: ((if $mainvariant then
      { build: ({ model: $model, variant: "max" }
          + (if $task == "pr_opened" then { permission: { task: "deny" } } else {} end)),
        general: { model: $model, variant: "max" },
        explore: { model: $model, variant: "max" },
        review: {
          model: $model,
          variant: "max",
          mode: "subagent",
          description: "Read-only Ultra review child. Never modify files, execute nested tasks, or publish comments.",
          prompt: "You are a leaf reviewer. Perform only the assigned role from the task prompt. Do not run the coordinator protocol, do not delegate, do not call task or ultra_review_task, do not publish comments, and return only structured evidence for the parent.",
          permission: { edit: "deny", task: "deny", bash: "deny" }
        }
      } else {} end)
    + { planner: ({
      model: $model,
      mode: "subagent",
      description: "Deep planning specialist. MUST be called FIRST, before any code-modifying work: explores the repo in parallel, drafts a plan, verifies every referenced file, writes the final plan to ctx/plan.md and returns it in full.",
      prompt: ("{file:" + $opencodedir + "/agent/planner.md}\n\nPlan file (absolute path — the ONLY file you may write): " + $workdir + "/ctx/plan.md"),
      permission: {
        edit: { "*": "deny", ($workdir + "/ctx/plan.md"): "allow" },
        # planner 是纯只读规划角色:bash 一并 deny(防经 shell 改克隆/推送)。
        # planner is a read-only planning role: bash is denied too (no editing the
        # clone / pushing via a shell). Agent-level limits apply to this agent only
        # and are not inherited; its explore subagent still uses bash per its own
        # permissions (subagent-permissions only inherit session-level deny).
        bash: "deny",
        task: { "*": "deny", explore: "allow" },
        external_directory: $external_directory_permission
      } } + (if $mainvariant then { variant: $mainvariant } else {} end)) }),
    command: { "code-review": {
      description: "Independent multi-perspective PR review pass (subagent fan-out + inline comments)",
      template: ("{file:" + $opencodedir + "/command/code-review.md}") } },
    plugin: [
      ("file://" + $opencodedir + "/plugin/ultra-review-runner.ts"),
      ("file://" + $opencodedir + "/plugin/review-artifact-guard.ts"),
      ("file://" + $opencodedir + "/plugin/review-reference-library.ts"),
      ("file://" + $opencodedir + "/plugin/plan-guard.ts"),
      ("file://" + $opencodedir + "/plugin/progress-comment.ts"),
      "@dietrichgebert/ponytail@4.8.4"
    ]
  }
  + (if $small != "" then { small_model: $small } else {} end)
  + (if $mainm.context then
      { compaction: { reserved:
          (($mainm.context * (1 - ($mainm.compact_threshold // 0.9))) | round) } }
    else {} end)
')"
export OPENCODE_CONFIG_CONTENT

# ── 权限规则集(permissions.sh 装配)─────────────────────────────────────────────
# Permission ruleset. Both modes run --auto (auto-approve any request not
# explicitly denied); deny is a hard blacklist --auto cannot bypass. Reading
# credential files is denied throughout: OpenCode's pattern matcher expands * to
# a cross-/ .* (util/wildcard.ts), so "*.env" / "*.env.*" cover .env, sub/.env,
# foo.env, .env.local, etc. Ordinary tasks explicitly allow BOT_WORKDIR;
# restricted fork review/engage/merge allow only BOT_WORKDIR/ctx and deny every
# other external directory (blocks /proc/self/environ). prepare-env.sh already
# strips the temporary install token from the clone remote. can_write=0 or
# pr_opened appends edit:deny. All pr_opened reviews (incl. same-repo) deny bash
# except the argv-validated cchp-review-meta, so the review clone's read-only
# contract is enforced by the execution layer, not model self-discipline.
rm -f "${CTX_DIR}/reply.md"
OPENCODE_PERMISSION="$(build_opencode_permission \
  "${BOT_WORKDIR}" "${BOT_CAN_WRITE:-0}" "${BOT_TASK:-}" "${BOT_PR_IS_FORK:-0}")"
export OPENCODE_PERMISSION

# ── 实时进度评论(progress-comment plugin)────────────────────────────────────
# Live progress comment (progress-comment plugin): the main session's todowrite
# list mirrors to one sticky checklist comment. Enabled only for session tasks
# with a concrete issue/PR target; roadmap/release etc. (no-comment tasks) off.
BOT_PROGRESS_TARGET=""
case "${BOT_TASK:-}" in
  pr_opened|engage|ci_fix|reaction_execute|lgtm_merge)
    BOT_PROGRESS_TARGET="${BOT_PR_NUMBER:-${BOT_ISSUE_NUMBER:-}}" ;;
esac
[[ "${BOT_SKIP_PR_INSPECT:-0}" == "1" ]] && BOT_PROGRESS_TARGET=""
export BOT_PROGRESS_TARGET

# ── 运行开关 / run switches ───────────────────────────────────────────────────
export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true   # allow parallel background task
export OPENCODE_DISABLE_SHARE=true                       # CI sessions never share externally
export CCHP_REVIEW_MAX_PARALLEL=10                       # Ultra runner hard cap
export CCHP_REVIEW_AGENT_TIMEOUT_SECONDS=1800            # single reviewer max 30min

log "model=${CCHP_BOT_MODEL} small=${CCHP_BOT_SMALL_MODEL:-<main>} can_write=${BOT_CAN_WRITE:-0} cwd=${REPO_DIR}"
log "providers=$(jq -r 'keys | join(",")' <<<"${CCHP_BOT_PROVIDERS}")"

cd "${REPO_DIR}"
# Prompt is passed on stdin so arbitrary issue/PR text can't break arg parsing.
# Under non-interactive mode any permission request not matched by a rule is
# auto-denied (never hangs); --auto turns ask into allow. The hard timeout only
# backstops a permanently-hung process. Default is the workflow's 12h ceiling;
# each Ultra reviewer's own 30min timeout is enforced separately by
# ultra-review-runner, which cancels it independently.
rc=0
timeout --signal=TERM --kill-after=30s "${BOT_OPENCODE_TIMEOUT:-43200}" \
  opencode run --auto --agent build --variant max < "${BOT_PROMPT_FILE}" || rc=$?
if [[ "${rc}" -eq 124 || "${rc}" -eq 137 ]]; then
  log "ERROR: opencode run exceeded ${BOT_OPENCODE_TIMEOUT:-43200}s and was killed — likely the model gateway hung (check the provider format matches what the gateway actually implements)."
fi
if [[ "${rc}" -eq 0 && "${BOT_TASK:-}" == "pr_opened" && "${BOT_SKIP_PR_INSPECT:-0}" != "1" ]]; then
  if ! "${REVIEW_FINALIZER}" "${CTX_DIR}/review" "${CTX_DIR}/review-manifest.json" "${CTX_DIR}/review-finalized.json"; then
    log "ERROR: Ultra review artifacts did not satisfy the trusted completion gates"
    rc=1
  fi
fi
exit "${rc}"
