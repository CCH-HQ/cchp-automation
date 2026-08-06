#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/skills-lib.sh
source "${SCRIPT_DIR}/skills-lib.sh"

manifest="${CCHP_SKILLS_MANIFEST:-${ROOT}/skills/manifest.json}"
backup_root="${CCHP_SKILLS_BACKUP:-${ROOT}/skills-backup}"
target="${CCHP_SKILLS_TARGET:?CCHP_SKILLS_TARGET is required}"
install_home="${CCHP_SKILLS_INSTALL_HOME:-${BOT_WORKDIR:?BOT_WORKDIR is required}/skills-install-home}"

mapfile -t sources < <(skills_manifest_rows "$manifest")
(( ${#sources[@]} > 0 )) || { printf '[skills][error] manifest yielded no sources\n' >&2; exit 2; }
mkdir -p "$install_home" "$target"

failures=0
for row in "${sources[@]}"; do
  IFS=$'\t' read -r id url timeout_seconds <<<"$row"
  printf '[skills] install %s from %s\n' "$id" "$url"
  if ! timeout "$timeout_seconds" env -i \
    PATH="${PATH}" HOME="$install_home" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-C.UTF-8}" DO_NOT_TRACK=1 \
    bunx skills add "$url" --global --all -y </dev/null >/dev/null 2>&1; then
    printf '[skills][warn] source failed or timed out: %s\n' "$id" >&2
    failures=$((failures + 1))
  fi
done

live_root="${install_home}/.agents/skills"
live_valid=0
live_invalid=0
if [[ -d "$live_root" ]]; then
  for directory in "$live_root"/*; do
    [[ -e "$directory" || -L "$directory" ]] || continue
    name="$(basename "$directory")"
    if ! skill_content_hash "$directory" >/dev/null; then
      printf '[skills][warn] live skill validation failed: %s\n' "$name" >&2
      live_invalid=$((live_invalid + 1))
      continue
    fi
    mkdir -p "$target/$name"
    cp -R "$directory/." "$target/$name/"
    live_valid=$((live_valid + 1))
  done
fi
if (( live_valid == 0 )); then
  printf '[skills][warn] live install produced no valid skills\n' >&2
  failures=$((failures + 1))
fi

restored=0
invalid=0
if (( failures > 0 || live_invalid > 0 )); then
  if [[ -f "$backup_root/manifest.json" && ! -L "$backup_root/manifest.json" && -d "$backup_root/skills" ]]; then
    for directory in "$backup_root/skills"/*/; do
      [[ -d "$directory" && ! -L "$directory" ]] || continue
      name="$(basename "$directory")"
      [[ ! -e "$target/$name" ]] || continue
      if validate_backup_skill "$backup_root" "$name" "$directory"; then
        cp -R "$directory" "$target/$name"
        restored=$((restored + 1))
      else
        printf '[skills][warn] backup hash or SKILL.md validation failed: %s\n' "$name" >&2
        invalid=$((invalid + 1))
      fi
    done
    printf '[skills][warn] degraded: %d source(s) failed; restored %d backup skill(s); rejected %d invalid backup skill(s)\n' \
      "$failures" "$restored" "$invalid" >&2
  else
    printf '[skills][warn] degraded: %d source(s) failed and no validated backup is available\n' "$failures" >&2
  fi
fi

ready=0
for directory in "$target"/*; do
  [[ -e "$directory" || -L "$directory" ]] || continue
  if skill_content_hash "$directory" >/dev/null; then ready=$((ready + 1)); fi
done
(( ready > 0 )) || { printf '[skills][error] no valid skills are available after live install and backup recovery\n' >&2; exit 2; }

printf '[skills] ready target=%s live_failures=%d live_invalid=%d restored=%d valid=%d\n' \
  "$target" "$failures" "$live_invalid" "$restored" "$ready"
