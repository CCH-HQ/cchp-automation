#!/usr/bin/env bash
set -euo pipefail

export PATH="${HOME}/.local/bin:${PATH}"
log() { printf '\033[1;34m[run-pi]\033[0m %s\n' "$*"; }

: "${BOT_WORKDIR:?}" "${ENGINE_DIR:?}" "${REPO_DIR:?}" "${BOT_PROMPT_FILE:?}" "${PI_BIN:?}"
mkdir -p "${BOT_WORKDIR}/ctx/pi" "${BOT_WORKDIR}/ctx/review"
export BOT_RUN_ID="${BOT_RUN_ID:-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$$}"
export BOT_SYSTEM_PROMPT="${BOT_SYSTEM_PROMPT:-${ENGINE_DIR}/pi/system-prompt.md}"
export BOT_PROGRESS_TARGET="${BOT_PROGRESS_TARGET:-${BOT_PR_NUMBER:-${BOT_ISSUE_NUMBER:-}}}"

log "starting Pi RPC supervisor task=${BOT_TASK:-unknown} model=${CCHP_BOT_MODEL:-<unset>} run=${BOT_RUN_ID}"
exec bun "${ENGINE_DIR}/src/pi/runtime.ts"
