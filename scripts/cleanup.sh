#!/usr/bin/env bash
# cchp-automation bot — environment teardown.
set -euo pipefail

log() { printf '\033[1;34m[cleanup]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[cleanup]\033[0m %s\n' "$*" >&2; exit 2; }

if [[ -z "${BOT_WORKDIR:-}" ]]; then
  log "nothing to clean (BOT_WORKDIR unset)"
  exit 0
fi

[[ -n "${ENGINE_DIR:-}" ]] || ENGINE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "${ENGINE_DIR}/scripts/process-group.sh"

[[ -n "${RUNNER_TEMP:-}" && "$RUNNER_TEMP" == /* ]] || fail "RUNNER_TEMP must be an absolute path"
[[ "$BOT_WORKDIR" == /* ]] || fail "BOT_WORKDIR must be an absolute path"
[[ -n "${GITHUB_RUN_ID:-}" && -n "${GITHUB_RUN_ATTEMPT:-}" ]] || fail "GitHub run identity is required"
[[ -n "${BOT_RUN_ID:-}" ]] || fail "BOT_RUN_ID is required"
[[ "${CCHP_PROCESS_RECORD_HMAC_KEY:-}" =~ ^[a-f0-9]{64}$ ]] || fail "controller process-record HMAC key is required"
[[ -n "${CCHP_WORKDIR_IDENTITY_PATH:-}" && "$CCHP_WORKDIR_IDENTITY_PATH" == /* ]] || fail "trusted workdir identity path is required"
[[ -n "${CCHP_CLEANUP_COMPLETE_PATH:-}" && "$CCHP_CLEANUP_COMPLETE_PATH" == /* ]] || fail "trusted cleanup marker path is required"

runner_root="$(realpath -e -- "$RUNNER_TEMP")" || fail "RUNNER_TEMP must exist"
workdir_parent="$(dirname -- "$BOT_WORKDIR")"
canonical_parent="$(realpath -e -- "$workdir_parent")" || fail "BOT_WORKDIR parent must exist"
workdir_name="$(basename -- "$BOT_WORKDIR")"
[[ "$canonical_parent" == "$runner_root" ]] || fail "BOT_WORKDIR must be a direct child of RUNNER_TEMP"
[[ "$workdir_name" == "cchp-bot.${GITHUB_RUN_ID}.${GITHUB_RUN_ATTEMPT}."?????? ]] || fail "BOT_WORKDIR name is not run-owned"

[[ -f "$CCHP_WORKDIR_IDENTITY_PATH" && ! -L "$CCHP_WORKDIR_IDENTITY_PATH" && -O "$CCHP_WORKDIR_IDENTITY_PATH" ]] || fail "trusted workdir identity is invalid"
[[ "$(stat -Lc '%h' -- "$CCHP_WORKDIR_IDENTITY_PATH")" == "1" ]] || fail "trusted workdir identity must have one link"
identity_json="$(<"$CCHP_WORKDIR_IDENTITY_PATH")"
identity_sha256="$(sha256sum -- "$CCHP_WORKDIR_IDENTITY_PATH" | cut -d' ' -f1)"
identity_schema="$(jq -er '.schemaVersion | numbers' <<<"$identity_json" 2>/dev/null || true)"
identity_path="$(jq -er '.path | strings' <<<"$identity_json" 2>/dev/null || true)"
identity_device="$(jq -er '.device | numbers' <<<"$identity_json" 2>/dev/null || true)"
identity_inode="$(jq -er '.inode | numbers' <<<"$identity_json" 2>/dev/null || true)"
identity_run="$(jq -er '.githubRunId | strings' <<<"$identity_json" 2>/dev/null || true)"
identity_attempt="$(jq -er '.githubRunAttempt | strings' <<<"$identity_json" 2>/dev/null || true)"
identity_mac="$(jq -er '.mac | strings' <<<"$identity_json" 2>/dev/null || true)"
identity_expected_mac="$(cchp_record_hmac "$identity_json")" || fail "trusted workdir identity authentication failed"
[[ "$identity_schema" == "1" && "$identity_path" == "$BOT_WORKDIR" ]] || fail "trusted workdir identity binding is invalid"
[[ "$identity_device" =~ ^[0-9]+$ && "$identity_inode" =~ ^[1-9][0-9]*$ ]] || fail "trusted workdir filesystem identity is invalid"
[[ "$identity_run" == "$GITHUB_RUN_ID" && "$identity_attempt" == "$GITHUB_RUN_ATTEMPT" ]] || fail "trusted workdir run identity is invalid"
[[ "$identity_mac" == "$identity_expected_mac" ]] || fail "trusted workdir identity authentication failed"

valid_cleanup_marker() {
  [[ -f "$CCHP_CLEANUP_COMPLETE_PATH" && ! -L "$CCHP_CLEANUP_COMPLETE_PATH" && -O "$CCHP_CLEANUP_COMPLETE_PATH" ]] || return 1
  [[ "$(stat -Lc '%h' -- "$CCHP_CLEANUP_COMPLETE_PATH")" == "1" ]] || return 1
  local marker_json marker_schema marker_identity marker_run marker_attempt marker_mac marker_expected_mac
  marker_json="$(<"$CCHP_CLEANUP_COMPLETE_PATH")" || return 1
  marker_schema="$(jq -er '.schemaVersion | numbers' <<<"$marker_json" 2>/dev/null || true)"
  marker_identity="$(jq -er '.workdirIdentitySha256 | strings' <<<"$marker_json" 2>/dev/null || true)"
  marker_run="$(jq -er '.githubRunId | strings' <<<"$marker_json" 2>/dev/null || true)"
  marker_attempt="$(jq -er '.githubRunAttempt | strings' <<<"$marker_json" 2>/dev/null || true)"
  marker_mac="$(jq -er '.mac | strings' <<<"$marker_json" 2>/dev/null || true)"
  marker_expected_mac="$(cchp_record_hmac "$marker_json")" || return 1
  [[ "$marker_schema" == "1" && "$marker_identity" == "$identity_sha256" ]] || return 1
  [[ "$marker_run" == "$GITHUB_RUN_ID" && "$marker_attempt" == "$GITHUB_RUN_ATTEMPT" ]] || return 1
  [[ "$marker_mac" == "$marker_expected_mac" ]]
}

cleanup_target=""
if [[ -e "$BOT_WORKDIR" || -L "$BOT_WORKDIR" ]]; then
  [[ -d "$BOT_WORKDIR" && ! -L "$BOT_WORKDIR" && -O "$BOT_WORKDIR" ]] || fail "BOT_WORKDIR must be an owned directory"
  current_identity="$(stat -Lc '%d:%i' -- "$BOT_WORKDIR")"
  [[ "$current_identity" == "${identity_device}:${identity_inode}" ]] || fail "BOT_WORKDIR filesystem identity changed"
  cleanup_target="$BOT_WORKDIR"
else
  while IFS= read -r -d '' candidate; do
    [[ -d "$candidate" && ! -L "$candidate" && -O "$candidate" ]] || continue
    if [[ "$(stat -Lc '%d:%i' -- "$candidate")" == "${identity_device}:${identity_inode}" ]]; then
      [[ -z "$cleanup_target" ]] || fail "workdir identity is ambiguous"
      cleanup_target="$candidate"
    fi
  done < <(find "$runner_root" -mindepth 1 -maxdepth 1 -type d -print0)
  if [[ -n "$cleanup_target" ]]; then
    log "resolved renamed workdir ${cleanup_target} by filesystem identity"
  elif valid_cleanup_marker; then
    cleanup_target=""
  else
    fail "run-owned workdir disappeared without verified cleanup"
  fi
fi

process_cleanup_failed=0
process_record="${CCHP_CODEX_PID_FILE:-}"
if [[ -n "$process_record" && -e "$process_record" ]]; then
  if ! cchp_load_process_record "$process_record" || ! cchp_stop_process_group 10 10 20 0.1; then
    process_cleanup_failed=1
    log "Codex app-server cleanup did not reach a verified terminal state"
  else
    log "Codex app-server process group stopped"
  fi
fi

explicit_cleanup_failed=0
if [[ -n "$cleanup_target" ]]; then
  if ! python3 "$ENGINE_DIR/scripts/cleanup-explicit-children.py" \
    --workdir "$cleanup_target" --expected-workdir "$BOT_WORKDIR" --run-id "$BOT_RUN_ID"; then
    explicit_cleanup_failed=1
    log "detached explicit child cleanup did not reach a verified terminal state"
  fi
fi

[[ "$process_cleanup_failed" -eq 0 ]] || fail "Codex app-server cleanup did not reach a verified terminal state"
[[ "$explicit_cleanup_failed" -eq 0 ]] || fail "detached explicit child cleanup did not reach a verified terminal state"

if [[ -n "$cleanup_target" ]]; then
  canonical_target_parent="$(realpath -e -- "$(dirname -- "$cleanup_target")")" || fail "cleanup target parent disappeared"
  [[ "$canonical_target_parent" == "$runner_root" ]] || fail "resolved cleanup target escaped RUNNER_TEMP"
  [[ "$(stat -Lc '%d:%i' -- "$cleanup_target")" == "${identity_device}:${identity_inode}" ]] || fail "cleanup target changed before deletion"
  log "removing ${cleanup_target}"
  python3 "$ENGINE_DIR/scripts/secure-remove-tree.py" \
    --path "$cleanup_target" --runner-root "$runner_root" \
    --device "$identity_device" --inode "$identity_inode" || fail "failed to remove BOT_WORKDIR"
  [[ ! -e "$cleanup_target" && ! -L "$cleanup_target" ]] || fail "BOT_WORKDIR still exists after removal"
fi

marker_dir="$(dirname -- "$CCHP_CLEANUP_COMPLETE_PATH")"
mkdir -p -- "$marker_dir"
marker_tmp="$(mktemp "${marker_dir}/.cleanup-complete.XXXXXX")"
marker_payload="$(jq -cn --arg identity "$identity_sha256" --arg run "$GITHUB_RUN_ID" --arg attempt "$GITHUB_RUN_ATTEMPT" \
  '{schemaVersion: 1, workdirIdentitySha256: $identity, githubRunId: $run, githubRunAttempt: $attempt}')"
marker_mac="$(cchp_record_hmac "$marker_payload")" || fail "failed to authenticate cleanup completion marker"
jq --arg mac "$marker_mac" '. + {mac: $mac}' <<<"$marker_payload" >"$marker_tmp"
chmod 600 -- "$marker_tmp"
mv -f -- "$marker_tmp" "$CCHP_CLEANUP_COMPLETE_PATH"

log "done"
