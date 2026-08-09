#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
real_bun="$(command -v bun)"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT
mkdir -p "$test_root/bin" "$test_root/work" "$test_root/home"
: > "$test_root/work/prompt.md"

cat > "$test_root/bin/git" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  clone)
    destination="${!#}"
    mkdir -p "$destination/.git"
    mkdir -p "$destination/web"
    mkdir -p "$destination/scripts/ci"
    printf '{"name":"fixture"}\n' > "$destination/web/package.json"
    cat > "$destination/scripts/ci/bun-trust.sh" <<'TRUST'
#!/usr/bin/env bash
set -euo pipefail
env | sed 's/=.*//' | sort > "${HOME:?}/bun-trust-env.names"
printf '%s\n' "${HEROUI_AUTH_TOKEN:-missing}" > "${HOME:?}/bun-trust-token"
TRUST
    chmod +x "$destination/scripts/ci/bun-trust.sh"
    printf '[remote "origin"]\n\turl = https://x-access-token:token-sentinel@github.com/CCH-HQ/fixture.git\n' > "$destination/.git/config"
    ;;
  remote)
    [[ "${2:-}" == "set-url" && "${3:-}" == "origin" ]]
    printf '[remote "origin"]\n\turl = %s\n' "${4:?}" > .git/config
    ;;
  config|submodule)
    ;;
  *)
    printf 'unexpected git invocation: %s\n' "$*" >&2
    exit 2
    ;;
esac
SH
chmod +x "$test_root/bin/git"

cat > "$test_root/bin/bun" <<SH
#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "install" ]]; then
  env | sed 's/=.*//' | sort > "\${HOME:?}/bun-env.names"
  printf '%s\n' "\${HEROUI_AUTH_TOKEN:-missing}" > "\${HOME:?}/bun-env.log"
  exit 0
fi
exec "$real_bun" "\$@"
SH
chmod +x "$test_root/bin/bun"

cat > "$test_root/bin/bunx" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
env | sed 's/=.*//' | sort > "${HOME:?}/bunx-env.names"
for forbidden in BOT_TOKEN GH_TOKEN CCHP_APP_PRIVATE_KEY CCHP_BOT_PROVIDER_KEYS SEE_API_KEY HEROUI_AUTH_TOKEN; do
  [[ -z "${!forbidden:-}" ]] || { printf 'bunx inherited %s\n' "$forbidden" >&2; exit 97; }
done
mkdir -p "${HOME}/.agents/skills/fixture"
cat > "${HOME}/.agents/skills/fixture/SKILL.md" <<'EOF'
---
name: fixture
description: Prepare Codex environment fixture.
---
# fixture skill
EOF
SH
chmod +x "$test_root/bin/bunx"

cat > "$test_root/bin/uv" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
env | sed 's/=.*//' | sort > "${HOME:?}/uv-env.names"
for forbidden in BOT_TOKEN GH_TOKEN CCHP_APP_PRIVATE_KEY CCHP_BOT_PROVIDER_KEYS SEE_API_KEY HEROUI_AUTH_TOKEN; do
  [[ -z "${!forbidden:-}" ]] || { printf 'uv inherited %s\n' "$forbidden" >&2; exit 98; }
done
SH
chmod +x "$test_root/bin/uv"

cat > "$test_root/bin/see-cli" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "${SEE_API_KEY:-missing}" > "${SEE_INVOCATION_LOG:?}"
SH
chmod +x "$test_root/bin/see-cli"

cat > "$test_root/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
output=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "$output" ]]
printf 'verified archive fixture\n' > "$output"
SH
chmod +x "$test_root/bin/curl"

cat > "$test_root/bin/sha256sum" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == *see_Linux_x86_64.tar.gz ]]; then
  printf 'ef0ff8e41579a828db303585e6711bf599619b3e0929b15e7616ed446647db90  %s\n' "$1"
else
  exec /usr/bin/sha256sum "$@"
fi
SH
chmod +x "$test_root/bin/sha256sum"

cat > "$test_root/bin/tar" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
destination=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -C) destination="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "$destination" ]]
printf '%s\n' '#!/bin/sh' 'exit 0' > "$destination/see"
chmod +x "$destination/see"
SH
chmod +x "$test_root/bin/tar"

PATH="$test_root/bin:/usr/bin:/bin" \
HOME="$test_root/home" \
BOT_WORKDIR="$test_root/work" \
BOT_TOKEN="token-sentinel" \
GH_TOKEN="gh-sentinel" \
CCHP_APP_PRIVATE_KEY="app-private-sentinel" \
CCHP_BOT_PROVIDER_KEYS='{"relay":"provider-sentinel"}' \
GH_REPO="CCH-HQ/fixture" \
BOT_DEFAULT_BRANCH="dev" \
BOT_TARGET_BRANCH="dev" \
REPO_DIR="$test_root/work/repo" \
BOT_PROMPT_FILE="$test_root/work/prompt.md" \
  BOT_SKIP_ATARAXY=1 \
  BOT_SKIP_PR_INSPECT=1 \
  HEROUI_AUTH_TOKEN="heroui-sentinel" \
  SEE_API_KEY="see-sentinel" \
  SEE_INVOCATION_LOG="$test_root/see-env.log" \
  bash "$ROOT/scripts/prepare-codex-env.sh"

config="$test_root/work/repo/.git/config"
[[ -f "$config" ]]
[[ "$(<"$config")" == *"https://github.com/CCH-HQ/fixture.git"* ]]
[[ "$(<"$config")" != *"token-sentinel"* ]]
[[ "$(<"$test_root/home/bun-env.log")" == "heroui-sentinel" ]]
[[ "$(<"$test_root/home/bun-trust-token")" == "heroui-sentinel" ]]
for env_file in \
  "$test_root/home/bun-env.names" \
  "$test_root/home/bun-trust-env.names" \
  "$test_root/work/skills-install-home/bunx-env.names" \
  "$test_root/home/uv-env.names"; do
  names="$(<"$env_file")"
  for forbidden in BOT_TOKEN GH_TOKEN CCHP_APP_PRIVATE_KEY CCHP_BOT_PROVIDER_KEYS SEE_API_KEY; do
    [[ $'\n'"$names"$'\n' != *$'\n'"$forbidden"$'\n'* ]] || {
      printf '%s inherited forbidden variable %s\n' "$env_file" "$forbidden" >&2
      exit 1
    }
  done
done
for env_file in "$test_root/work/skills-install-home/bunx-env.names" "$test_root/home/uv-env.names"; do
  names="$(<"$env_file")"
  [[ $'\n'"$names"$'\n' != *$'\n'HEROUI_AUTH_TOKEN$'\n'* ]] || {
    printf '%s inherited HeroUI token\n' "$env_file" >&2
    exit 1
  }
done
[[ ! -e "$test_root/work/ctx/see/api-key" ]]
[[ ! -e "$test_root/see-env.log" ]]
[[ -x "$test_root/work/ctx/tools/see/see" ]]
[[ ! -e "$test_root/home/.local/lib/see-cli/see" ]]
jq -e '.schemaVersion == 1 and .version == "v1.2.0" and (.binarySha256 | test("^[a-f0-9]{64}$"))' \
  "$test_root/work/ctx/tools/see/provenance.json" >/dev/null

second_work="$test_root/read-only-work"
second_home="$test_root/read-only-home"
mkdir -p "$second_work" "$second_home"
: > "$second_work/prompt.md"
PATH="$test_root/bin:/usr/bin:/bin" \
HOME="$second_home" \
BOT_WORKDIR="$second_work" \
BOT_TASK=manual \
BOT_CAN_WRITE=0 \
BOT_TOKEN="token-sentinel" \
GH_REPO="CCH-HQ/fixture" \
BOT_DEFAULT_BRANCH="dev" \
BOT_TARGET_BRANCH="dev" \
REPO_DIR="$second_work/repo" \
BOT_PROMPT_FILE="$second_work/prompt.md" \
BOT_SKIP_SKILLS=1 \
BOT_SKIP_SEE=1 \
BOT_SKIP_ATARAXY=1 \
BOT_SKIP_PR_INSPECT=1 \
  bash "$ROOT/scripts/prepare-codex-env.sh"
[[ ! -e "$second_home/bun-env.log" ]] || { echo 'read-only manual unexpectedly installed web deps' >&2; exit 1; }
printf 'prepare-codex-env credential sanitization test passed\n'
