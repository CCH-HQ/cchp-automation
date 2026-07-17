#!/usr/bin/env bash
# cchp-automation bot — environment teardown.
# Runs with `if: always()` so the isolated workdir (and any embedded token /
# cloned secrets) never lingers on the persistent self-hosted runner.
#
# Required env: BOT_WORKDIR
set -uo pipefail

log() { printf '\033[1;34m[cleanup]\033[0m %s\n' "$*"; }

# Stop the gh-token-refresher sidecar if run.sh's exit trap didn't get to run
# (e.g. the run step was SIGKILLed). Its PID file lives beside the token file.
if [[ -n "${BOT_WORKDIR:-}" && -f "${BOT_WORKDIR}/.gh-token-refresher.pid" ]]; then
  kill "$(cat "${BOT_WORKDIR}/.gh-token-refresher.pid")" 2>/dev/null || true
  log "token refresher sidecar stopped"
fi

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

# Drop the run-scoped rotating-token git credential helper + gh wrapper installed
# by run.sh (the token file they point at is wiped with BOT_WORKDIR above). Only
# remove the wrapper if it is ours — never a real gh living in ~/.local/bin.
git config --global --unset-all credential."https://github.com".helper 2>/dev/null || true
if grep -q "cchp-automation: rotating-token gh wrapper" "${HOME}/.local/bin/gh" 2>/dev/null; then
  rm -f "${HOME}/.local/bin/gh" 2>/dev/null || true
fi
log "done"
