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
#   CCHP_APP_CLIENT_ID           GitHub App client id — with CCHP_APP_PRIVATE_KEY,
#                                enables the token-rotation sidecar (installation
#                                tokens hard-expire at 1h; long runs outlive them)
#   CCHP_APP_PRIVATE_KEY         GitHub App private key (PEM). NEVER reaches
#                                opencode: consumed by the sidecar, then unset
#                                here BEFORE any config assembly / launch
#   CCHP_NEEDS_WRITE             "true" when run.yml minted the write token —
#                                the sidecar mints the SAME scope (else base)
#   CCHP_TOKEN_WAIT_SECONDS      bounded wait for the first rotated token (30)
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

# ── GitHub App token 轮换 sidecar(装机 token 1h 硬过期;长任务必须中途换新)──
# Installation tokens hard-expire after 1h (GitHub limit); long runs (3h+ seen)
# outlive them and every gh/Octokit/git-push call starts failing 401. The sidecar
# (scripts/gh-token-refresher.ts) holds the App credentials and re-mints the
# token into ${BOT_WORKDIR}/.gh-token (outside the clone, ~45min cadence, atomic
# replace). HARD SECURITY INVARIANT: the private key exists ONLY in this shell's
# env + the sidecar's env — it is unset below BEFORE the opencode config is
# assembled and before opencode launches, so neither the model nor the MCP
# server can ever read it. The only new opencode-visible surface is the token
# FILE PATH (CCHP_GH_TOKEN_FILE); the token itself is exactly as sensitive as
# the static GH_TOKEN it supersedes. Best-effort:轮换起不来就记日志并回退静态
# GH_TOKEN,绝不因此拖垮整场 run。
CCHP_GH_TOKEN_FILE=""
CCHP_REFRESHER_PID=""
# || 链条:sidecar 已死/从未启动都不能触发 set -e(fallback 路径也会直呼本函数)。
refresher_cleanup() { [[ -z "${CCHP_REFRESHER_PID}" ]] || kill "${CCHP_REFRESHER_PID}" 2>/dev/null || true; }
trap refresher_cleanup EXIT
if [[ -n "${CCHP_APP_CLIENT_ID:-}" && -n "${CCHP_APP_PRIVATE_KEY:-}" && -n "${BOT_REPO:-}" ]]; then
  _token_file="${BOT_WORKDIR}/.gh-token"
  # scope 镜像 run.yml 的 steps.write.outputs.token || steps.base 二选一:只有
  # route 判定 needs_write 的任务才拿 contents/workflows write;fork/review 恒 base。
  _token_scope="base"
  [[ "${CCHP_NEEDS_WRITE:-}" == "true" ]] && _token_scope="write"
  CCHP_GH_TOKEN_FILE="${_token_file}" CCHP_TOKEN_SCOPE="${_token_scope}" \
    bun "${ENGINE_DIR}/scripts/gh-token-refresher.ts" &
  CCHP_REFRESHER_PID=$!
  _wait_ticks=$(( ${CCHP_TOKEN_WAIT_SECONDS:-30} * 2 ))
  for (( _i = 0; _i < _wait_ticks; _i++ )); do
    [[ -s "${_token_file}" ]] && break
    kill -0 "${CCHP_REFRESHER_PID}" 2>/dev/null || break   # sidecar 已死就别傻等
    sleep 0.5
  done
  if [[ -s "${_token_file}" ]]; then
    CCHP_GH_TOKEN_FILE="${_token_file}"
    export CCHP_GH_TOKEN_FILE   # path only (never the token) — children resolve their own run's file
    printf '%s' "${CCHP_REFRESHER_PID}" > "${BOT_WORKDIR}/.gh-token-refresher.pid"
    log "token rotation active (scope=${_token_scope}, refresher pid=${CCHP_REFRESHER_PID})"
    # gh wrapper:~/.local/bin 已在 PATH 最前;真实 gh 的绝对路径此刻解析(排除
    # ~/.local/bin 防自指)并烘焙进去。每次调用现读 token 文件 → progress-comment
    # 与模型的 gh 永远拿到新 token;文件消失则回落环境里的静态 GH_TOKEN。
    _real_gh=""
    IFS=':' read -r -a _path_dirs <<< "${PATH}"
    for _d in "${_path_dirs[@]}"; do
      [[ -z "${_d}" || "${_d}" == "${HOME}/.local/bin" ]] && continue
      [[ -f "${_d}/gh" && -x "${_d}/gh" ]] && { _real_gh="${_d}/gh"; break; }
    done
    if [[ -n "${_real_gh}" ]]; then
      mkdir -p "${HOME}/.local/bin"
      {
        printf '#!/usr/bin/env bash\n'
        printf '# cchp-automation: rotating-token gh wrapper (generated by run.sh; removed by cleanup.sh)\n'
        # shellcheck disable=SC2016  # 单引号系有意为之:${tf}/$@ 留给 wrapper 运行时展开
        printf 'tf="${CCHP_GH_TOKEN_FILE:-%s}"\n' "${_token_file}"
        # shellcheck disable=SC2016
        printf '[[ -r "${tf}" && -s "${tf}" ]] && exec env GH_TOKEN="$(cat "${tf}")" %q "$@"\n' "${_real_gh}"
        printf 'exec %q "$@"\n' "${_real_gh}"
      } > "${HOME}/.local/bin/gh"
      chmod 0755 "${HOME}/.local/bin/gh"
      log "gh wrapper -> ${HOME}/.local/bin/gh (real gh: ${_real_gh})"
    else
      log "WARNING: no real gh found on PATH; gh calls keep the static GH_TOKEN"
    fi
    # git 凭据改走 helper(现读 token 文件,优先本 run 导出的 CCHP_GH_TOKEN_FILE),
    # remote 重置为纯 https —— prepare-env 克隆时内嵌在 URL 里的 token 1h 后失效。
    # fork 任务 prepare-env 已把 remote 消毒为纯 https,这里再设同值无副作用。
    # ponytail: --global 在并发共用 runner 时最后写入者胜 —— helper 经环境变量解析
    # token 文件,本 run 的子进程始终拿对文件;跨 run 清理竞态仅降级(push 掉凭据),
    # 不会拿错 token。
    git config --global --replace-all credential."https://github.com".helper \
      "!f() { [ \"\$1\" = get ] || return 0; tf=\"\${CCHP_GH_TOKEN_FILE:-${_token_file}}\"; [ -s \"\$tf\" ] || return 0; echo username=x-access-token; echo \"password=\$(cat \"\$tf\")\"; }; f" \
      || log "WARNING: git credential helper setup failed (git auth relies on the clone-time token)"
    if git -C "${REPO_DIR}" remote set-url origin "https://github.com/${BOT_REPO}.git" 2>/dev/null; then
      log "origin remote reset to plain https (credential helper supplies the rotating token)"
    else
      log "WARNING: could not reset the origin remote (continuing with the clone-time URL)"
    fi
  else
    log "WARNING: token refresher produced no token within ${CCHP_TOKEN_WAIT_SECONDS:-30}s; falling back to the static GH_TOKEN (runs >1h may hit token expiry)"
    refresher_cleanup
    CCHP_REFRESHER_PID=""
    CCHP_GH_TOKEN_FILE=""
  fi
else
  log "token rotation unavailable (no app credentials in env); using the static GH_TOKEN"
fi
# HARD INVARIANT:私钥绝不能进入 opencode 可读面 —— 在合成任何配置字符串、启动
# opencode 之前,从本 shell 环境剥离 App 凭据(sidecar 已在自己的 env 里持有)。
unset CCHP_APP_PRIVATE_KEY CCHP_APP_CLIENT_ID

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

# ── Agent 工具链探测 —— prepare-env.sh best-effort 装完后,这里探测装成功与否再接入。
# 装失败即优雅降级:缺失的 MCP/插件不写进配置,绝不让一个缺失的二进制拖垮整场 run。
command -v fff-mcp         >/dev/null 2>&1 && HAVE_FFF=1    || HAVE_FFF=0
command -v serena          >/dev/null 2>&1 && HAVE_SERENA=1 || HAVE_SERENA=0
command -v oh-my-openagent >/dev/null 2>&1 && HAVE_OMOA=1   || HAVE_OMOA=0
command -v context-mode    >/dev/null 2>&1 && HAVE_CTX=1    || HAVE_CTX=0
# context-mode 暴露 ctx_execute 等沙箱执行工具(经 MCP,不受 opencode bash/edit 权限约束)。
# 审查未信任 PR 的路径(pr_opened / 受限 fork 任务)一律不挂 context-mode,免得在带凭据的
# runner 上给未信任代码开出执行面;其余任务按官方全局启用。
CTX_ACTIVE="${HAVE_CTX}"
case "${BOT_TASK:-}" in pr_opened) CTX_ACTIVE=0 ;; esac
if [[ "${BOT_PR_IS_FORK:-0}" == "1" ]] && \
   { [[ "${BOT_TASK:-}" == "lgtm_merge" ]] || [[ "${BOT_TASK:-}" == "engage" ]]; }; then
  CTX_ACTIVE=0
fi
# 协调 agent:装上 oh-my-openagent 时用 Sisyphus(西西弗斯)统领全部任务(含 pr_opened 的
# Ultra 审查)。Ultra 流水线(review 叶子子代理 / ultra_review_task / finalize 闸门 / 会话级
# 只读权限)结构不变 —— 仅把协调者从 build 换成 sisyphus。装失败则回落 build。
COORD_AGENT=build
[[ "${HAVE_OMOA}" == "1" ]] && COORD_AGENT=sisyphus

# oh-my-openagent 逐 agent/category 显式钉死 model + 思考预算 = 主模型(variant max)。否则其
# 子代理会自作主张用便宜回退模型,且那些默认模型不在本仓 providers 里会直接失败。同时关掉会
# 外泄未信任 PR 代码的远端 MCP(websearch/context7/grep_app)、遥测、自更新。写到用户级 opencode
# 配置目录,与 OPENCODE_CONFIG_CONTENT 独立生效(oh-my-openagent.jsonc 自有加载器)。
if [[ "${HAVE_OMOA}" == "1" ]]; then
  mkdir -p "${HOME}/.config/opencode"
  jq -n --arg model "${CCHP_BOT_MODEL}" \
     --argjson agents '["sisyphus","hephaestus","prometheus","atlas","oracle","librarian","explore","multimodal-looker","metis","momus","sisyphus-junior"]' \
     --argjson cats   '["quick","deep","ultrabrain","visual-engineering","writing","unspecified-low","unspecified-high"]' '
     { telemetry: false, auto_update: false,
       disabled_mcps: ["websearch", "context7", "grep_app"],
       agents:     ($agents | map({ (.): { model: $model, variant: "max" } }) | add),
       categories: ($cats   | map({ (.): { model: $model, variant: "max" } }) | add) }
  ' > "${HOME}/.config/opencode/oh-my-openagent.jsonc"
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
  --arg tokenfile "${CCHP_GH_TOKEN_FILE}" \
  --argjson external_directory_permission "${EXTERNAL_DIRECTORY_PERMISSION}" \
  --arg have_fff "${HAVE_FFF}" \
  --arg have_serena "${HAVE_SERENA}" \
  --arg have_ctx "${CTX_ACTIVE}" \
  --arg have_omoa "${HAVE_OMOA}" \
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
    mcp: ({ github_inline_comment: {
      type: "local", command: ["bun", $mcp], enabled: true,
      environment: ({ BOT_REPO: $botrepo, BOT_PR_NUMBER: $botpr,
                      BOT_ISSUE_NUMBER: $botissue, BOT_TASK: $task,
                      BOT_HEAD_SHA: $botsha, BOT_PATCH_FILE: $patch,
                      BOT_TRUSTED_REVIEW_MANIFEST: $trusted_manifest,
                      BOT_REVIEW_ARTIFACT_DIR: $review_artifacts,
                      BOT_REVIEW_FINALIZER: $review_finalizer,
                      BOT_REVIEW_FINALIZED_MARKER: $finalized_marker,
                      GH_TOKEN: "{env:GH_TOKEN}" }
        # 轮换 sidecar 在跑时把 token 文件路径(不是 token 本身)交给 MCP server,
        # 它按请求现读文件;GH_TOKEN 引用保留为静态回退。
        + (if $tokenfile != "" then { CCHP_GH_TOKEN_FILE: $tokenfile } else {} end)
        + (if $killswitch != "" then { CCHP_DISABLE_AUTO_APPROVE: $killswitch } else {} end)) } }
      # fff-mcp:超快文件/内容搜索(grep / find_files / multi_grep),只读。
      + (if $have_fff == "1" then
          { fff: { type: "local", enabled: true, command: ["fff-mcp", "--no-update-check"] } }
        else {} end)
      # serena:LSP 语义代码检索(find_symbol / references / overview / …)。只读锁在
      # ~/.serena/serena_config.yml 的 excluded_tools;--context ide + dashboard off。
      + (if $have_serena == "1" then
          { serena: { type: "local", enabled: true,
            command: ["serena", "start-mcp-server", "--context", "ide", "--project-from-cwd",
                      "--enable-web-dashboard", "false", "--mode", "no-onboarding"],
            environment: { SERENA_USAGE_REPORTING: "false" } } }
        else {} end) ),
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
      description: "Deep planning specialist. Called AFTER initial exploration (explore first), before any non-trivial code-modifying work: explores the repo in parallel, drafts a plan, verifies every referenced file, writes the final plan to ctx/plan.md and returns it in full.",
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
    plugin: ([
      ("file://" + $opencodedir + "/plugin/ultra-review-runner.ts"),
      ("file://" + $opencodedir + "/plugin/review-artifact-guard.ts"),
      ("file://" + $opencodedir + "/plugin/review-reference-library.ts"),
      ("file://" + $opencodedir + "/plugin/plan-guard.ts"),
      ("file://" + $opencodedir + "/plugin/progress-comment.ts"),
      "@dietrichgebert/ponytail@4.8.4"
    ]
    # context-mode:上下文优化器(ctx_* 沙箱/知识库)。opencode 官方接入是插件而非 MCP;
    # 仅在非未信任审查路径挂载(见 CTX_ACTIVE)。oh-my-openagent:Sisyphus 等编排 agent。
    + (if $have_ctx == "1" then ["context-mode"] else [] end)
    + (if $have_omoa == "1" then ["oh-my-openagent@latest"] else [] end))
  }
  + (if $small != "" then { small_model: $small } else {} end)
  + (if $mainm.context then
      { compaction: { reserved:
          (($mainm.context * (1 - ($mainm.compact_threshold // 0.9))) | round) } }
    else {} end)
  # 装上 oh-my-openagent 时把默认 agent 也设为 Sisyphus(与 --agent 显式传参双保险)。
  + (if $have_omoa == "1" then { default_agent: "sisyphus" } else {} end)
')"
# Tripwire(硬安全不变量):合成配置里绝不允许出现 PEM 私钥材料 —— 上面已 unset
# App 凭据,这里再兜底拦截任何未来把 key 误接进配置的改动。
if grep -Eq 'BEGIN[A-Z ]*PRIVATE KEY' <<<"${OPENCODE_CONFIG_CONTENT}"; then
  log "ERROR: OPENCODE_CONFIG_CONTENT contains private-key material; refusing to launch opencode"
  exit 2
fi
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
# 外部工具链运行期开关:context-mode 落盘到 ctx/(runner 可写、克隆外);rtk 关遥测。
mkdir -p "${CTX_DIR}/context-mode"
export CONTEXT_MODE_DIR="${CTX_DIR}/context-mode"
export CONTEXT_MODE_PROJECT_DIR="${REPO_DIR}"
export RTK_TELEMETRY_DISABLED=1

log "model=${CCHP_BOT_MODEL} small=${CCHP_BOT_SMALL_MODEL:-<main>} can_write=${BOT_CAN_WRITE:-0} cwd=${REPO_DIR}"
log "providers=$(jq -r 'keys | join(",")' <<<"${CCHP_BOT_PROVIDERS}")"
log "coordinator=${COORD_AGENT} fff=${HAVE_FFF} serena=${HAVE_SERENA} context-mode=${CTX_ACTIVE} oh-my-openagent=${HAVE_OMOA}"

cd "${REPO_DIR}"
# Prompt is passed on stdin so arbitrary issue/PR text can't break arg parsing.
# Under non-interactive mode any permission request not matched by a rule is
# auto-denied (never hangs); --auto turns ask into allow. The hard timeout only
# backstops a permanently-hung process. Default is the workflow's 12h ceiling;
# each Ultra reviewer's own 30min timeout is enforced separately by
# ultra-review-runner, which cancels it independently.
rc=0
timeout --signal=TERM --kill-after=30s "${BOT_OPENCODE_TIMEOUT:-43200}" \
  opencode run --auto --agent "${COORD_AGENT}" --variant max < "${BOT_PROMPT_FILE}" || rc=$?
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
