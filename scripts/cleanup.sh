#!/usr/bin/env bash
# cchp-automation bot — environment teardown.
# Runs with `if: always()` so the isolated workdir (and any embedded token /
# cloned secrets) never lingers on the persistent self-hosted runner.
#
# Required env: BOT_WORKDIR
set -uo pipefail

log() { printf '\033[1;34m[cleanup]\033[0m %s\n' "$*"; }

if [[ -n "${BOT_WORKDIR:-}" && -d "${BOT_WORKDIR}" ]]; then
  # The clone embeds the install token in .git/config remote URL — wipe the
  # whole tree, not just the worktree.
  log "removing ${BOT_WORKDIR}"
  chmod -R u+w "${BOT_WORKDIR}" 2>/dev/null || true
  rm -rf "${BOT_WORKDIR}" || log "rm failed (will be reaped by runner GC)"
else
  log "nothing to clean (BOT_WORKDIR unset or already gone)"
fi

# Drop any session-scoped git credentials the bot may have written.
rm -f "${HOME}/.git-credentials" 2>/dev/null || true
log "done"
