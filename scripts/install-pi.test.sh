#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
bash -n "$root/scripts/install-pi.sh"
grep -F 'readonly PI_VERSION="1.0.0"' "$root/scripts/install-pi.sh" >/dev/null
grep -F 'npm install --prefix "$install_root" --ignore-scripts' "$root/scripts/install-pi.sh" >/dev/null
grep -F 'PI_BIN=' "$root/scripts/install-pi.sh" >/dev/null
printf '[install-pi-test] passed\n'
