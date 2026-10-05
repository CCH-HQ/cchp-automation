#!/usr/bin/env bash
set -euo pipefail

export PATH="${HOME}/.local/bin:${PATH}"
log() { printf '\033[1;34m[prepare-pi]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[prepare-pi][warn]\033[0m %s\n' "$*" >&2; }

: "${BOT_WORKDIR:?}" "${BOT_TOKEN:?}" "${GH_REPO:?}"
TARGET_BRANCH="${BOT_TARGET_BRANCH:-${BOT_DEFAULT_BRANCH:-dev}}"
CLONE_DEPTH="${BOT_CLONE_DEPTH:-50}"
REPO_DIR="${REPO_DIR:-${BOT_WORKDIR}/repo}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "${BOT_WORKDIR}/ctx/pi" "${BOT_WORKDIR}/ctx/review" "${BOT_WORKDIR}/pi-home"
remote="https://x-access-token:${BOT_TOKEN}@github.com/${GH_REPO}.git"
log "cloning ${GH_REPO}@${TARGET_BRANCH} -> ${REPO_DIR}"
if ! git clone --depth "${CLONE_DEPTH}" --branch "${TARGET_BRANCH}" "$remote" "$REPO_DIR"; then
  warn "branch ${TARGET_BRANCH} unavailable; falling back to ${BOT_DEFAULT_BRANCH:-dev}"
  git clone --depth "${CLONE_DEPTH}" --branch "${BOT_DEFAULT_BRANCH:-dev}" "$remote" "$REPO_DIR"
fi
cd "$REPO_DIR"
git config user.name "${BOT_GIT_NAME:-cchp-automation[bot]}"
git config user.email "${BOT_GIT_EMAIL:-cchp-automation[bot]@users.noreply.github.com}"
BOT_PROMPT_FILE="${BOT_PROMPT_FILE:-${BOT_WORKDIR}/prompt.md}" bash "${SCRIPT_DIR}/compact-prompt.sh"
git submodule update --init --recursive --depth 1 2>/dev/null || warn "submodule fetch skipped"
git remote set-url origin "https://github.com/${GH_REPO}.git"
unset BOT_TOKEN GH_TOKEN HEROUI_AUTH_TOKEN

workspace_write_task=0
if [[ "${BOT_CAN_WRITE:-0}" == "1" && "${BOT_PR_IS_FORK:-0}" != "1" ]]; then
  case "${BOT_TASK:-}" in
    engage|lgtm_merge|ci_fix|reaction_execute|manual|dispatch) workspace_write_task=1 ;;
  esac
fi

if [[ "${BOT_SKIP_SKILLS:-0}" != "1" && "$workspace_write_task" == "1" ]]; then
  env -i PATH="${PATH}" HOME="${HOME}" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-C.UTF-8}" \
    BOT_WORKDIR="${BOT_WORKDIR}" CCHP_SKILLS_TARGET="${BOT_WORKDIR}/pi-home/skills" \
    CCHP_SKILLS_INSTALL_HOME="${BOT_WORKDIR}/skills-install-home" \
    bash "${SCRIPT_DIR}/install-skills.sh" || warn "skills installation failed; Pi will continue with repository instructions"
else
  log "skipping skills installation (no workspace-write task)"
fi

if [[ "${BOT_SKIP_WEB_DEPS:-0}" != "1" && "$workspace_write_task" == "1" && -f "${REPO_DIR}/web/package.json" ]]; then
  log "installing web dependencies"
  ( cd "${REPO_DIR}/web" && env -i PATH="${PATH}" HOME="${HOME}" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-C.UTF-8}" timeout --signal=TERM --kill-after=30s "${BOT_BUN_INSTALL_TIMEOUT:-600}" bun install --frozen-lockfile </dev/null ) || warn "web dependencies install failed; Pi will report repository check failures"
fi

log "Pi environment ready at ${REPO_DIR}"
