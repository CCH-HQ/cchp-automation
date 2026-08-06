#!/usr/bin/env bash
# cchp-automation bot — environment teardown.
# Runs with `if: always()` so the isolated workdir (and any embedded token /
# cloned secrets) never lingers on the persistent self-hosted runner.
#
# Required env: BOT_WORKDIR
set -uo pipefail

log() { printf '\033[1;34m[cleanup]\033[0m %s\n' "$*"; }

if [[ -n "${BOT_WORKDIR:-}" && -f "${BOT_WORKDIR}/.codex-app-server.pid" ]]; then
  codex_record="${BOT_WORKDIR}/.codex-app-server.pid"
  codex_pid="$(jq -er '.pid | numbers' "$codex_record" 2>/dev/null || true)"
  codex_pgid="$(jq -er '.pgid | numbers' "$codex_record" 2>/dev/null || true)"
  expected_start="$(jq -er '.startTicks | strings' "$codex_record" 2>/dev/null || true)"
  expected_boot="$(jq -er '.bootId | strings' "$codex_record" 2>/dev/null || true)"
  if [[ "$codex_pid" =~ ^[1-9][0-9]*$ && "$codex_pgid" =~ ^[1-9][0-9]*$ && -n "$expected_start" && -n "$expected_boot" && -r "/proc/${codex_pid}/stat" ]]; then
    stat_suffix="$(<"/proc/${codex_pid}/stat")"
    stat_suffix="${stat_suffix##*) }"
    read -r -a stat_fields <<< "$stat_suffix"
    if [[ "${stat_fields[19]:-}" == "$expected_start" && "$(<"/proc/sys/kernel/random/boot_id")" == "$expected_boot" ]]; then
      kill -TERM -- "-$codex_pgid" 2>/dev/null || kill -TERM "$codex_pid" 2>/dev/null || true
      sleep 1
      kill -KILL -- "-$codex_pgid" 2>/dev/null || kill -KILL "$codex_pid" 2>/dev/null || true
      log "Codex app-server process group stopped"
    fi
  fi
fi

if [[ -n "${BOT_WORKDIR:-}" && -d "${BOT_WORKDIR}" ]]; then
  # The workdir contains run-scoped tokens, sockets, ledgers and the clone.
  log "removing ${BOT_WORKDIR}"
  chmod -R u+w "${BOT_WORKDIR}" 2>/dev/null || true
  rm -rf "${BOT_WORKDIR}" || log "rm failed (will be reaped by runner GC)"
else
  log "nothing to clean (BOT_WORKDIR unset or already gone)"
fi

log "done"
