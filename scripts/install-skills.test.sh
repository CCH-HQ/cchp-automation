#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export GH_TOKEN="github-sentinel"
export BOT_TOKEN="bot-sentinel"
export CCHP_APP_PRIVATE_KEY="app-private-sentinel"
export CCHP_BOT_PROVIDER_KEYS="provider-sentinel"
export SEE_API_KEY="see-sentinel"
export HEROUI_AUTH_TOKEN="heroui-sentinel"
export CCHP_BUN_BIN="$(command -v bun)"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT
mkdir -p "$test_root/bin" "$test_root/backup/skills/fallback" "$test_root/backup/skills/wayfinder" "$test_root/work"

cat > "$test_root/manifest.json" <<'JSON'
{"schemaVersion":1,"sources":[
  {"id":"live","url":"https://github.com/example/live","timeoutSeconds":5},
  {"id":"failed","url":"https://github.com/example/failed","timeoutSeconds":5}
]}
JSON
cat > "$test_root/bin/bunx" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
for forbidden in GH_TOKEN BOT_TOKEN CCHP_APP_PRIVATE_KEY CCHP_BOT_PROVIDER_KEYS SEE_API_KEY HEROUI_AUTH_TOKEN; do
  [[ -z "${!forbidden:-}" ]] || { printf 'bunx inherited %s\n' "$forbidden" >&2; exit 97; }
done
url="${3:?}"
if [[ "$url" == *stubborn ]]; then
  trap '' TERM
  while true; do sleep 1; done
fi
if [[ "$url" == *failed ]]; then exit 23; fi
if [[ "$url" == *empty ]]; then exit 0; fi
if [[ "$url" == *symlink ]]; then
  mkdir -p "${HOME:?}/.agents/skills" "${HOME}/outside"
  printf '%s\n' '# escaped' > "${HOME}/outside/SKILL.md"
  ln -s "${HOME}/outside" "${HOME}/.agents/skills/escaped"
  exit 0
fi
mkdir -p "${HOME:?}/.agents/skills/live"
cat > "${HOME}/.agents/skills/live/SKILL.md" <<'EOF'
---
name: live
description: Live fixture.
---
# live
EOF
mkdir -p "${HOME}/.agents/skills/wayfinder"
printf '%s\n' '# malformed live skill' > "${HOME}/.agents/skills/wayfinder/SKILL.md"
SH
chmod +x "$test_root/bin/bunx"
cat > "$test_root/backup/skills/fallback/SKILL.md" <<'EOF'
---
name: fallback
description: Fallback fixture.
---
# fallback
EOF
cat > "$test_root/backup/skills/wayfinder/SKILL.md" <<'EOF'
---
name: wayfinder
description: Valid backup replaces malformed live content.
---
# backup wayfinder
EOF
source "$ROOT/scripts/skills-lib.sh"
fallback_hash="$(skill_content_hash "$test_root/backup/skills/fallback")"
wayfinder_hash="$(skill_content_hash "$test_root/backup/skills/wayfinder")"
jq -n --arg fallback "$fallback_hash" --arg wayfinder "$wayfinder_hash" \
  '{schemaVersion:1,skills:{fallback:{contentHash:$fallback},wayfinder:{contentHash:$wayfinder}}}' > "$test_root/backup/manifest.json"

PATH="$test_root/bin:/usr/bin:/bin" \
BOT_WORKDIR="$test_root/work" \
CCHP_SKILLS_MANIFEST="$test_root/manifest.json" \
CCHP_SKILLS_BACKUP="$test_root/backup" \
CCHP_SKILLS_TARGET="$test_root/target" \
bash "$ROOT/scripts/install-skills.sh"

[[ -f "$test_root/target/live/SKILL.md" ]] || { echo 'live skill missing' >&2; exit 1; }
[[ -f "$test_root/target/fallback/SKILL.md" ]] || { echo 'fallback skill missing' >&2; exit 1; }
grep -F '# backup wayfinder' "$test_root/target/wayfinder/SKILL.md" >/dev/null || { echo 'malformed live skill did not fall back to validated backup' >&2; exit 1; }

cat > "$test_root/stubborn-manifest.json" <<'JSON'
{"schemaVersion":1,"sources":[{"id":"stubborn","url":"https://github.com/example/stubborn","timeoutSeconds":1}]}
JSON
rm -rf -- "$test_root/target" "$test_root/work/skills-install-home"
if ! /usr/bin/timeout --signal=TERM --kill-after=1s 12s env \
  PATH="$test_root/bin:/usr/bin:/bin" \
  BOT_WORKDIR="$test_root/work" \
  CCHP_SKILLS_MANIFEST="$test_root/stubborn-manifest.json" \
  CCHP_SKILLS_BACKUP="$test_root/backup" \
  CCHP_SKILLS_TARGET="$test_root/target" \
  bash "$ROOT/scripts/install-skills.sh"; then
  echo 'stubborn skills installer exceeded its hard timeout' >&2
  exit 1
fi
[[ -f "$test_root/target/fallback/SKILL.md" ]] || { echo 'stubborn install did not activate backup' >&2; exit 1; }

printf '%s\n' 'tampered' >> "$test_root/backup/skills/fallback/SKILL.md"
rm -rf -- "$test_root/target/fallback" "$test_root/work/skills-install-home"
PATH="$test_root/bin:/usr/bin:/bin" \
BOT_WORKDIR="$test_root/work" \
CCHP_SKILLS_MANIFEST="$test_root/manifest.json" \
CCHP_SKILLS_BACKUP="$test_root/backup" \
CCHP_SKILLS_TARGET="$test_root/target" \
bash "$ROOT/scripts/install-skills.sh"
[[ ! -e "$test_root/target/fallback" ]] || { echo 'tampered fallback was restored' >&2; exit 1; }

cat > "$test_root/mixed-invalid.json" <<'JSON'
{"schemaVersion":1,"sources":[
  {"id":"valid","url":"https://github.com/example/live","timeoutSeconds":5},
  {"id":"INVALID","url":"https://github.com/example/invalid","timeoutSeconds":5}
]}
JSON
if skills_manifest_rows "$test_root/mixed-invalid.json" >/dev/null 2>&1; then
  echo 'mixed valid/invalid manifest was silently accepted' >&2
  exit 1
fi

cat > "$test_root/empty-manifest.json" <<'JSON'
{"schemaVersion":1,"sources":[{"id":"empty","url":"https://github.com/example/empty","timeoutSeconds":5}]}
JSON
rm -rf -- "$test_root/target" "$test_root/work/skills-install-home"
mkdir -p "$test_root/target"
cat > "$test_root/backup/skills/fallback/SKILL.md" <<'EOF'
---
name: fallback
description: Fallback fixture.
---
# fallback
EOF
fallback_hash="$(skill_content_hash "$test_root/backup/skills/fallback")"
wayfinder_hash="$(skill_content_hash "$test_root/backup/skills/wayfinder")"
jq -n --arg fallback "$fallback_hash" --arg wayfinder "$wayfinder_hash" \
  '{schemaVersion:1,skills:{fallback:{contentHash:$fallback},wayfinder:{contentHash:$wayfinder}}}' > "$test_root/backup/manifest.json"
PATH="$test_root/bin:/usr/bin:/bin" \
BOT_WORKDIR="$test_root/work" \
CCHP_SKILLS_MANIFEST="$test_root/empty-manifest.json" \
CCHP_SKILLS_BACKUP="$test_root/backup" \
CCHP_SKILLS_TARGET="$test_root/target" \
bash "$ROOT/scripts/install-skills.sh"
[[ -f "$test_root/target/fallback/SKILL.md" ]] || { echo 'empty successful install did not activate backup' >&2; exit 1; }

cat > "$test_root/symlink-manifest.json" <<'JSON'
{"schemaVersion":1,"sources":[{"id":"symlink","url":"https://github.com/example/symlink","timeoutSeconds":5}]}
JSON
rm -rf -- "$test_root/target" "$test_root/work/skills-install-home"
mkdir -p "$test_root/target"
PATH="$test_root/bin:/usr/bin:/bin" \
BOT_WORKDIR="$test_root/work" \
CCHP_SKILLS_MANIFEST="$test_root/symlink-manifest.json" \
CCHP_SKILLS_BACKUP="$test_root/backup" \
CCHP_SKILLS_TARGET="$test_root/target" \
bash "$ROOT/scripts/install-skills.sh"
[[ ! -L "$test_root/target/escaped" ]] || { echo 'live symlink was copied into target' >&2; exit 1; }
[[ -f "$test_root/target/fallback/SKILL.md" ]] || { echo 'invalid live tree did not activate backup' >&2; exit 1; }

for fixture in missing-open missing-close invalid-yaml missing-name missing-description; do
  directory="$test_root/frontmatter/$fixture"
  mkdir -p "$directory"
  case "$fixture" in
    missing-open) printf '%s\n' 'name: missing-open' 'description: invalid' > "$directory/SKILL.md" ;;
    missing-close) printf '%s\n' '---' 'name: missing-close' 'description: invalid' > "$directory/SKILL.md" ;;
    invalid-yaml) printf '%s\n' '---' 'name: [invalid' 'description: invalid' '---' > "$directory/SKILL.md" ;;
    missing-name) printf '%s\n' '---' 'description: invalid' '---' > "$directory/SKILL.md" ;;
    missing-description) printf '%s\n' '---' 'name: missing-description' '---' > "$directory/SKILL.md" ;;
  esac
  if skill_content_hash "$directory" >/dev/null 2>&1; then
    printf 'malformed frontmatter was accepted: %s\n' "$fixture" >&2
    exit 1
  fi
done

mkdir -p "$test_root/atomic/source" "$test_root/atomic/target/atomic"
cat > "$test_root/atomic/source/SKILL.md" <<'EOF'
---
name: atomic
description: New atomic fixture.
---
# new
EOF
cat > "$test_root/atomic/target/atomic/SKILL.md" <<'EOF'
---
name: atomic
description: Previous atomic fixture.
---
# old
EOF
if CCHP_ATOMIC_REPLACE_FAIL_BEFORE_EXCHANGE=1 \
  replace_skill_directory "$test_root/atomic/source" "$test_root/atomic/target" atomic; then
  echo 'injected atomic replacement failure unexpectedly succeeded' >&2
  exit 1
fi
grep -F '# old' "$test_root/atomic/target/atomic/SKILL.md" >/dev/null || {
  echo 'failed atomic replacement removed the previous skill' >&2
  exit 1
}
replace_skill_directory "$test_root/atomic/source" "$test_root/atomic/target" atomic
grep -F '# new' "$test_root/atomic/target/atomic/SKILL.md" >/dev/null || {
  echo 'atomic replacement did not activate the new skill' >&2
  exit 1
}

rm -rf -- "$test_root/target" "$test_root/work/skills-install-home" "$test_root/no-backup"
mkdir -p "$test_root/target"
if PATH="$test_root/bin:/usr/bin:/bin" \
  BOT_WORKDIR="$test_root/work" \
  CCHP_SKILLS_MANIFEST="$test_root/empty-manifest.json" \
  CCHP_SKILLS_BACKUP="$test_root/no-backup" \
  CCHP_SKILLS_TARGET="$test_root/target" \
  bash "$ROOT/scripts/install-skills.sh"; then
  echo 'empty successful install without backup unexpectedly succeeded' >&2
  exit 1
fi

printf 'skills install/fallback tests passed\n'
