#!/usr/bin/env bash
set -euo pipefail

export PATH="${HOME}/.local/bin:${PATH}"
log() { printf '\033[1;34m[run-codex]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[run-codex][warn]\033[0m %s\n' "$*" >&2; }

: "${BOT_WORKDIR:?}" "${ENGINE_DIR:?}" "${REPO_DIR:?}" "${BOT_PROMPT_FILE:?}"
mkdir -p "${BOT_WORKDIR}/ctx/review" "${BOT_WORKDIR}/ctx/codex"
run_manifest="${BOT_WORKDIR}/ctx/codex/run-manifest.json"
terminal_manifest="${BOT_WORKDIR}/ctx/codex/terminal.json"
if [[ -z "${BOT_RUN_ID:-}" && -f "$run_manifest" ]]; then
  BOT_RUN_ID="$(jq -er 'select(.schemaVersion == 1) | .runId | select(type == "string" and length > 0)' "$run_manifest")" || {
    warn "existing run manifest has no valid run id"
    exit 2
  }
fi
export BOT_RUN_ID="${BOT_RUN_ID:-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-${RANDOM}-$$}"
export BOT_PROGRESS_TARGET="${BOT_PROGRESS_TARGET:-${BOT_PR_NUMBER:-${BOT_ISSUE_NUMBER:-}}}"
export BOT_PATCH_FILE="${BOT_PATCH_FILE:-${BOT_WORKDIR}/ctx/pr-diff.patch}"
export BOT_TRUSTED_REVIEW_MANIFEST="${BOT_TRUSTED_REVIEW_MANIFEST:-${BOT_WORKDIR}/ctx/review-manifest.json}"
export BOT_REVIEW_ARTIFACT_DIR="${BOT_REVIEW_ARTIFACT_DIR:-${BOT_WORKDIR}/ctx/review}"
export BOT_REVIEW_FINALIZED_MARKER="${BOT_REVIEW_FINALIZED_MARKER:-${BOT_WORKDIR}/ctx/review-finalized.json}"
export CCHP_CODEX_PID_FILE="${BOT_WORKDIR}/.codex-app-server.pid"

app_client_id="${CCHP_APP_CLIENT_ID:-}"
app_private_key="${CCHP_APP_PRIVATE_KEY:-}"
github_token="${GH_TOKEN:-}"
heroui_token="${HEROUI_AUTH_TOKEN:-}"
see_api_key="${SEE_API_KEY:-}"
export BOT_REPO="${BOT_REPO:-${GH_REPO:-}}"
unset CCHP_APP_CLIENT_ID CCHP_APP_PRIVATE_KEY GH_TOKEN CCHP_GH_TOKEN_FILE HEROUI_AUTH_TOKEN SEE_API_KEY

export BOT_HAVE_FFF="$(command -v fff-mcp >/dev/null 2>&1 && echo 1 || echo 0)"
export BOT_HAVE_SERENA="$(command -v serena >/dev/null 2>&1 && echo 1 || echo 0)"
export BOT_HAVE_SEE="$([[ -x "${HOME}/.local/lib/see-cli/see" && -n "$see_api_key" ]] && echo 1 || echo 0)"
export BOT_SYSTEM_PROMPT="${BOT_SYSTEM_PROMPT:-${ENGINE_DIR}/codex/system-prompt.md}"

is_resumable_manifest() {
  [[ -f "$run_manifest" && ! -e "$terminal_manifest" ]] || return 1
  jq -e --arg run_id "$BOT_RUN_ID" '
    .schemaVersion == 1 and
    .runId == $run_id and
    (.state == "ROOT_RUNNING" or .state == "ROOT_DRAINING" or .state == "FINALIZING") and
    (.rootThreadId | type == "string" and length > 0)
  ' "$run_manifest" >/dev/null
}

stop_stale_codex() {
  local pid_file="${CCHP_CODEX_PID_FILE}" pid pgid cmdline expected_start expected_boot stat_suffix
  [[ -f "$pid_file" ]] || return 0
  pid="$(jq -er '.pid | numbers' "$pid_file" 2>/dev/null || true)"
  pgid="$(jq -er '.pgid | numbers' "$pid_file" 2>/dev/null || true)"
  expected_start="$(jq -er '.startTicks | strings' "$pid_file" 2>/dev/null || true)"
  expected_boot="$(jq -er '.bootId | strings' "$pid_file" 2>/dev/null || true)"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || { warn "ignoring invalid Codex PID file"; return 0; }
  [[ "$pgid" =~ ^[1-9][0-9]*$ && -n "$expected_start" && -n "$expected_boot" ]] || { warn "ignoring legacy or incomplete Codex process record"; return 0; }
  [[ -r "/proc/${pid}/cmdline" ]] || return 0
  stat_suffix="$(<"/proc/${pid}/stat")"
  stat_suffix="${stat_suffix##*) }"
  read -r -a stat_fields <<< "$stat_suffix"
  [[ "${stat_fields[19]:-}" == "$expected_start" && "$(<"/proc/sys/kernel/random/boot_id")" == "$expected_boot" ]] || {
    warn "refusing to stop PID ${pid}: process identity does not match the Codex record"
    return 0
  }
  cmdline="$(tr '\0' ' ' < "/proc/${pid}/cmdline")"
  [[ "$cmdline" == *"app-server"* ]] || { warn "refusing to stop stale PID ${pid}: not a Codex app-server"; return 0; }
  warn "stopping stale Codex app-server process group ${pgid} before resume"
  kill -INT -- "-${pgid}" 2>/dev/null || kill -INT "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-${pgid}" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  fi
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL -- "-${pgid}" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
}

max_restarts="${CCHP_RUNTIME_RESTARTS:-1}"
[[ "$max_restarts" =~ ^[01]$ ]] || { warn "CCHP_RUNTIME_RESTARTS must be 0 or 1"; exit 2; }
attempt=0
run_runtime() {
  local see_stdin="$1"
  env \
    CCHP_APP_CLIENT_ID="${app_client_id}" \
    CCHP_APP_PRIVATE_KEY="${app_private_key}" \
    GH_TOKEN="${github_token}" \
    HEROUI_AUTH_TOKEN="${heroui_token}" \
    CCHP_SEE_API_KEY_STDIN="$see_stdin" \
    timeout --signal=TERM --kill-after=30s "${BOT_CODEX_TIMEOUT:-${CCHP_CODEX_TIMEOUT:-42690}}" \
      bun "${ENGINE_DIR}/src/codex/runtime.ts"
}
while :; do
  log "starting Codex supervisor task=${BOT_TASK:-unknown} model=${CCHP_BOT_MODEL:-<unset>} run=${BOT_RUN_ID} attempt=$((attempt + 1))"
  rc=0
  if [[ -n "$see_api_key" ]]; then
    printf '%s' "$see_api_key" | run_runtime 1 || rc=$?
  else
    run_runtime 0 </dev/null || rc=$?
  fi
  if [[ "$rc" -eq 0 ]]; then exit 0; fi
  if [[ "$rc" -eq 124 || "$rc" -eq 137 ]]; then
    warn "Codex supervisor exceeded its deadline and was killed"
    exit "$rc"
  fi
  if (( attempt >= max_restarts )) || ! is_resumable_manifest; then exit "$rc"; fi
  attempt=$((attempt + 1))
  warn "Codex runtime exited ${rc} with a resumable manifest; restarting once"
  stop_stale_codex
done
