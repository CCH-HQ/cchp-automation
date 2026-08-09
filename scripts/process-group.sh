#!/usr/bin/env bash

# Trusted Codex app-server process-group teardown shared by resume and final
# cleanup. Callers must set BOT_WORKDIR, BOT_RUN_ID, GITHUB_RUN_ID,
# GITHUB_RUN_ATTEMPT and a controller-only CCHP_PROCESS_RECORD_HMAC_KEY.

cchp_record_hmac() {
  local record_json="$1" canonical
  [[ "${CCHP_PROCESS_RECORD_HMAC_KEY:-}" =~ ^[a-f0-9]{64}$ ]] || return 2
  canonical="$(jq -cS 'del(.mac)' <<<"$record_json" 2>/dev/null)" || return 2
  printf '%s' "$canonical" |
    openssl dgst -sha256 -mac HMAC -macopt "hexkey:${CCHP_PROCESS_RECORD_HMAC_KEY}" |
    awk '{print $NF}'
}

cchp_load_process_record() {
  local record_path="$1" record_json record_links current_boot expected_mac
  [[ "$record_path" == /* && -f "$record_path" && ! -L "$record_path" && -O "$record_path" ]] || return 2
  record_links="$(stat -Lc '%h' -- "$record_path")" || return 2
  [[ "$record_links" == "1" ]] || return 2
  record_json="$(<"$record_path")" || return 2

  CCHP_PROCESS_SCHEMA="$(jq -er '.schemaVersion | numbers' <<<"$record_json" 2>/dev/null || true)"
  CCHP_PROCESS_PID="$(jq -er '.pid | numbers' <<<"$record_json" 2>/dev/null || true)"
  CCHP_PROCESS_PGID="$(jq -er '.pgid | numbers' <<<"$record_json" 2>/dev/null || true)"
  CCHP_PROCESS_START="$(jq -er '.startTicks | strings' <<<"$record_json" 2>/dev/null || true)"
  CCHP_PROCESS_BOOT="$(jq -er '.bootId | strings' <<<"$record_json" 2>/dev/null || true)"
  CCHP_PROCESS_HOME="$(jq -er '.codexHome | strings' <<<"$record_json" 2>/dev/null || true)"
  CCHP_PROCESS_GITHUB_RUN="$(jq -er '.githubRunId | strings' <<<"$record_json" 2>/dev/null || true)"
  CCHP_PROCESS_GITHUB_ATTEMPT="$(jq -er '.githubRunAttempt | strings' <<<"$record_json" 2>/dev/null || true)"
  CCHP_PROCESS_RUN_ID="$(jq -er '.runId | strings' <<<"$record_json" 2>/dev/null || true)"
  CCHP_PROCESS_RECORD_MAC="$(jq -er '.mac | strings' <<<"$record_json" 2>/dev/null || true)"
  expected_mac="$(cchp_record_hmac "$record_json")" || return 2
  CCHP_PROCESS_RECORD_PATH="$record_path"
  current_boot="$(<"/proc/sys/kernel/random/boot_id")"

  [[ "$CCHP_PROCESS_SCHEMA" == "2" && "$CCHP_PROCESS_RECORD_MAC" == "$expected_mac" ]] || return 2
  [[ "$CCHP_PROCESS_PID" =~ ^[1-9][0-9]*$ && "$CCHP_PROCESS_PGID" == "$CCHP_PROCESS_PID" ]] || return 2
  [[ -n "$CCHP_PROCESS_START" && "$CCHP_PROCESS_BOOT" == "$current_boot" ]] || return 2
  [[ "$CCHP_PROCESS_HOME" == "${BOT_WORKDIR}/codex-home" ]] || return 2
  [[ "$CCHP_PROCESS_GITHUB_RUN" == "$GITHUB_RUN_ID" && "$CCHP_PROCESS_GITHUB_ATTEMPT" == "$GITHUB_RUN_ATTEMPT" ]] || return 2
  [[ -n "${BOT_RUN_ID:-}" && "$CCHP_PROCESS_RUN_ID" == "$BOT_RUN_ID" ]] || return 2
}

cchp_process_group_alive() {
  kill -0 -- "-${CCHP_PROCESS_PGID}" 2>/dev/null
}

# 0 = original leader still owns the group, 1 = leader exited, 2 = identity drift.
cchp_process_leader_status() {
  [[ -r "/proc/${CCHP_PROCESS_PID}/stat" ]] || return 1
  local stat_suffix actual_cmdline
  local -a stat_fields
  stat_suffix="$(<"/proc/${CCHP_PROCESS_PID}/stat")"
  stat_suffix="${stat_suffix##*) }"
  read -r -a stat_fields <<<"$stat_suffix"
  [[ "${stat_fields[19]:-}" == "$CCHP_PROCESS_START" && "${stat_fields[2]:-}" == "$CCHP_PROCESS_PGID" ]] || return 2
  actual_cmdline="$(tr '\0' ' ' <"/proc/${CCHP_PROCESS_PID}/cmdline" 2>/dev/null || true)"
  [[ "$actual_cmdline" == *"app-server"* ]] || return 2
  return 0
}

cchp_wait_process_group() {
  local iterations="$1" delay="$2"
  local index
  for ((index = 0; index < iterations; index++)); do
    cchp_process_group_alive || return 0
    sleep "$delay"
  done
  ! cchp_process_group_alive
}

cchp_signal_process_group() {
  local signal="$1" status=0
  cchp_process_group_alive || return 0
  cchp_process_leader_status || status=$?
  [[ "$status" -ne 2 ]] || return 2
  kill "-$signal" -- "-${CCHP_PROCESS_PGID}" 2>/dev/null || {
    cchp_process_group_alive && return 2
  }
}

cchp_remove_owned_process_record() {
  [[ -e "$CCHP_PROCESS_RECORD_PATH" ]] || return 0
  local current_json current_mac expected_mac
  [[ -f "$CCHP_PROCESS_RECORD_PATH" && ! -L "$CCHP_PROCESS_RECORD_PATH" && -O "$CCHP_PROCESS_RECORD_PATH" ]] || return 2
  [[ "$(stat -Lc '%h' -- "$CCHP_PROCESS_RECORD_PATH")" == "1" ]] || return 2
  current_json="$(<"$CCHP_PROCESS_RECORD_PATH")" || return 2
  current_mac="$(jq -er '.mac | strings' <<<"$current_json" 2>/dev/null || true)"
  expected_mac="$(cchp_record_hmac "$current_json")" || return 2
  [[ "$current_mac" == "$CCHP_PROCESS_RECORD_MAC" && "$current_mac" == "$expected_mac" ]] || return 2
  CCHP_RECORD_HMAC_KEY="$CCHP_PROCESS_RECORD_HMAC_KEY" \
    python3 "${ENGINE_DIR:?}/scripts/secure-unlink.py" \
      --path "$CCHP_PROCESS_RECORD_PATH" \
      --expected-mac "$CCHP_PROCESS_RECORD_MAC"
}

cchp_stop_process_group() {
  local interrupt_loops="${1:-20}" term_loops="${2:-20}" kill_loops="${3:-20}" delay="${4:-0.1}"
  if ! cchp_process_group_alive; then
    cchp_remove_owned_process_record
    return
  fi
  cchp_signal_process_group INT || return 2
  if ! cchp_wait_process_group "$interrupt_loops" "$delay"; then
    cchp_signal_process_group TERM || return 2
    if ! cchp_wait_process_group "$term_loops" "$delay"; then
      cchp_signal_process_group KILL || return 2
      cchp_wait_process_group "$kill_loops" "$delay" || return 2
    fi
  fi
  cchp_remove_owned_process_record
}
