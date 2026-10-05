#!/usr/bin/env bash
set -euo pipefail

export PATH="${HOME}/.local/bin:${PATH}"
log() { printf '\033[1;34m[pi-install]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[pi-install]\033[0m %s\n' "$*" >&2; exit 2; }

: "${BOT_WORKDIR:?}" "${ENGINE_DIR:?}"
readonly PI_VERSION="1.0.0"
command -v node >/dev/null 2>&1 || fail "Node.js 22.19 or newer is required"
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 19)) process.exit(2)' || fail "Node.js 22.19 or newer is required"
command -v npm >/dev/null 2>&1 || fail "npm is required to install Pi"

install_root="${BOT_WORKDIR}/pi-install"
mkdir -p "$install_root"
chmod 700 "$install_root"
log "installing @earendil-works/pi-coding-agent@${PI_VERSION}"
npm install --prefix "$install_root" --ignore-scripts --no-audit --no-fund "@earendil-works/pi-coding-agent@${PI_VERSION}"
pi_bin="${install_root}/node_modules/.bin/pi"
[[ -x "$pi_bin" ]] || fail "Pi executable was not installed"
pi_real="$(realpath -- "$pi_bin")"
case "$pi_real" in
  "${install_root}/"*) ;;
  *) fail "Pi executable escaped the run-owned installation directory" ;;
esac
version="$($pi_bin --version 2>/dev/null | tr -d '\r\n')"
[[ "$version" == *"${PI_VERSION}"* ]] || fail "Pi version mismatch: expected ${PI_VERSION}, got ${version:-<empty>}"

if [[ -n "${GITHUB_ENV:-}" ]]; then
  printf 'PI_BIN=%s\nPI_VERSION=%s\n' "$pi_bin" "$PI_VERSION" >> "$GITHUB_ENV"
fi
if [[ -n "${GITHUB_PATH:-}" ]]; then
  printf '%s\n' "${install_root}/node_modules/.bin" >> "$GITHUB_PATH"
fi
log "Pi ${version} ready at ${pi_bin}"
