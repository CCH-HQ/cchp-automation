#!/usr/bin/env bash
set -euo pipefail

export PATH="${HOME}/.local/bin:${PATH}"
log() { printf '\033[1;34m[run-codex]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[run-codex][warn]\033[0m %s\n' "$*" >&2; }

: "${BOT_WORKDIR:?}" "${ENGINE_DIR:?}" "${REPO_DIR:?}" "${BOT_PROMPT_FILE:?}"
source "${ENGINE_DIR}/scripts/process-group.sh"
mkdir -p "${BOT_WORKDIR}/ctx/review" "${BOT_WORKDIR}/ctx/codex"
if [[ -z "${CCHP_PROCESS_RECORD_HMAC_KEY:-}" ]]; then
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    warn "CCHP_PROCESS_RECORD_HMAC_KEY is required in GitHub Actions"
    exit 2
  fi
  process_record_key_file="${BOT_WORKDIR}/ctx/codex/process-record-hmac.key"
  if [[ ! -e "$process_record_key_file" ]]; then
    umask 077
    process_record_key="$(openssl rand -hex 32)"
    (set -o noclobber; printf '%s\n' "$process_record_key" > "$process_record_key_file") || {
      warn "failed to create the local process-record HMAC key"
      exit 2
    }
  fi
  [[ -f "$process_record_key_file" && ! -L "$process_record_key_file" ]] || {
    warn "local process-record HMAC key is not a regular file"
    exit 2
  }
  read -r CCHP_PROCESS_RECORD_HMAC_KEY < "$process_record_key_file"
fi
[[ "$CCHP_PROCESS_RECORD_HMAC_KEY" =~ ^[a-f0-9]{64}$ ]] || {
  warn "CCHP_PROCESS_RECORD_HMAC_KEY must be 32-byte lowercase hex"
  exit 2
}
export CCHP_PROCESS_RECORD_HMAC_KEY
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
export CCHP_CODEX_PID_FILE="${CCHP_CODEX_PID_FILE:-${BOT_WORKDIR}/.codex-app-server.pid}"

app_client_id="${CCHP_APP_CLIENT_ID:-}"
app_private_key="${CCHP_APP_PRIVATE_KEY:-}"
github_token="${GH_TOKEN:-}"
heroui_token="${HEROUI_AUTH_TOKEN:-}"
see_api_key="${SEE_API_KEY:-}"
export BOT_REPO="${BOT_REPO:-${GH_REPO:-}}"
unset CCHP_APP_CLIENT_ID CCHP_APP_PRIVATE_KEY GH_TOKEN CCHP_GH_TOKEN_FILE HEROUI_AUTH_TOKEN SEE_API_KEY

export BOT_HAVE_FFF="$(command -v fff-mcp >/dev/null 2>&1 && echo 1 || echo 0)"
export BOT_HAVE_SERENA="$(command -v serena >/dev/null 2>&1 && echo 1 || echo 0)"
export SEE_CLI_BIN="${SEE_CLI_BIN:-${BOT_WORKDIR}/ctx/tools/see/see}"
see_provenance="${BOT_WORKDIR}/ctx/tools/see/provenance.json"
SEE_CLI_SHA256=""
if [[ -f "$SEE_CLI_BIN" && ! -L "$SEE_CLI_BIN" && -f "$see_provenance" && ! -L "$see_provenance" ]]; then
  SEE_CLI_SHA256="$(jq -er 'select(.schemaVersion == 1) | .binarySha256 | select(test("^[a-f0-9]{64}$"))' "$see_provenance" 2>/dev/null || true)"
  actual_see_sha="$(sha256sum "$SEE_CLI_BIN" | awk '{print $1}')"
  [[ -n "$SEE_CLI_SHA256" && "$SEE_CLI_SHA256" == "$actual_see_sha" ]] || SEE_CLI_SHA256=""
fi
export SEE_CLI_SHA256
export BOT_HAVE_SEE="$([[ -n "$SEE_CLI_SHA256" && -x "$SEE_CLI_BIN" && -n "$see_api_key" ]] && echo 1 || echo 0)"
export BOT_SYSTEM_PROMPT="${BOT_SYSTEM_PROMPT:-${ENGINE_DIR}/codex/system-prompt.md}"

is_resumable_manifest() {
  [[ -f "$run_manifest" && ! -L "$run_manifest" && ! -e "$terminal_manifest" ]] || return 1
  jq -e --arg run_id "$BOT_RUN_ID" '
    .schemaVersion == 1 and
    .runId == $run_id and
    (.state == "ROOT_RUNNING" or .state == "ROOT_DRAINING" or .state == "FINALIZING") and
    (.rootThreadId | type == "string" and length > 0)
  ' "$run_manifest" >/dev/null
}

terminal_checkpoint_state() {
  if [[ -e "$terminal_manifest" ]]; then
    [[ -f "$terminal_manifest" && ! -L "$terminal_manifest" ]] || return 1
    jq -er '
      select(
        (.state == "SUCCEEDED" or .state == "FAILED" or .state == "TIMED_OUT" or
         .state == "CANCELLED" or .state == "LOST" or .state == "TOKEN_BUDGET_EXCEEDED" or
         .state == "NO_PROGRESS_TIMEOUT") and
        (.usage | type == "object") and
        (.usage.consumed | type == "number" and . >= 0) and
        (.usage.limit | type == "number" and . >= 0)
      ) | .state
    ' "$terminal_manifest"
    return
  fi
  [[ -f "$run_manifest" && ! -L "$run_manifest" ]] || return 1
  jq -er --arg run_id "$BOT_RUN_ID" --arg task "${BOT_TASK:-}" '
    select(
      .schemaVersion == 1 and .runId == $run_id and .task == $task and
      (.state == "SUCCEEDED" or .state == "FAILED" or .state == "TIMED_OUT" or
       .state == "CANCELLED" or .state == "LOST" or .state == "TOKEN_BUDGET_EXCEEDED" or
       .state == "NO_PROGRESS_TIMEOUT") and
      (.rootThreadId | type == "string" and length > 0) and
      (.execution_mode == "native_v2" or .execution_mode == "explicit_child") and
      (.codexVersion | type == "string" and length > 0) and
      (.usage | type == "object") and
      (.usage.consumed | type == "number" and . >= 0) and
      (.usage.limit | type == "number" and . >= 0)
    ) | .state
  ' "$run_manifest"
}

terminal_exit_code() {
  case "$1" in
    SUCCEEDED) printf '0\n' ;;
    TIMED_OUT|NO_PROGRESS_TIMEOUT) printf '124\n' ;;
    CANCELLED) printf '130\n' ;;
    TOKEN_BUDGET_EXCEEDED) printf '125\n' ;;
    *) printf '1\n' ;;
  esac
}

manifest_state() {
  [[ -f "$run_manifest" && ! -L "$run_manifest" ]] || { printf 'absent\n'; return; }
  jq -r '.state // "invalid"' "$run_manifest" 2>/dev/null || printf 'invalid\n'
}

stop_stale_codex() {
  local pid_file="${CCHP_CODEX_PID_FILE}"
  [[ -f "$pid_file" ]] || return 0
  if ! cchp_load_process_record "$pid_file"; then
    warn "refusing resume because the Codex process record is invalid or not owned by this workflow run"
    return 2
  fi
  warn "stopping stale Codex app-server process group ${CCHP_PROCESS_PGID} before resume"
  cchp_stop_process_group 20 20 20 0.1 || {
    warn "stale Codex process group did not reach a verified terminal state"
    return 2
  }
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
  checkpoint_state="$(terminal_checkpoint_state 2>/dev/null || true)"
  if [[ -n "$checkpoint_state" ]]; then
    checkpoint_rc="$(terminal_exit_code "$checkpoint_state")"
    warn "Codex runtime exited ${rc} after durable terminal checkpoint state=${checkpoint_state}; preserving checkpoint outcome"
    exit "$checkpoint_rc"
  fi
  if (( attempt >= max_restarts )); then
    warn "Codex runtime exited ${rc}; restart budget exhausted"
    exit "$rc"
  fi
  resumable=false
  for _ in 1 2 3; do
    if is_resumable_manifest; then resumable=true; break; fi
    sleep 0.2
  done
  if [[ "$resumable" != "true" ]]; then
    warn "Codex runtime exited ${rc}; durable state is not safely resumable (manifest_state=$(manifest_state))"
    exit "$rc"
  fi
  attempt=$((attempt + 1))
  warn "Codex runtime exited ${rc} with a resumable manifest; restarting once"
  stop_stale_codex
done
