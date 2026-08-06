#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/skills-lib.sh
source "${SCRIPT_DIR}/skills-lib.sh"

manifest="${CCHP_SKILLS_MANIFEST:-${ROOT}/skills/manifest.json}"
mapfile -t sources < <(skills_manifest_rows "$manifest")
(( ${#sources[@]} > 0 )) || { printf '[skills-backup][error] manifest yielded no sources\n' >&2; exit 2; }

stage="$(mktemp -d "${TMPDIR:-/tmp}/cchp-skills-backup.XXXXXX")"
next="${ROOT}/.skills-backup.next.$$"
previous="${ROOT}/.skills-backup.previous.$$"
cleanup() { rm -rf -- "$stage" "$next" "$previous"; }
trap cleanup EXIT
mkdir -p "$stage"
fetched_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
: > "$stage/sources.ndjson"

cd "$stage"
for row in "${sources[@]}"; do
  IFS=$'\t' read -r id url timeout_seconds <<<"$row"
  printf '[skills-backup] install %s from %s\n' "$id" "$url"
  if ! timeout "$timeout_seconds" env DO_NOT_TRACK=1 bunx skills add "$url" --all -y </dev/null; then
    printf '[skills-backup][error] source failed or timed out: %s; preserving the previous complete backup\n' "$id" >&2
    exit 1
  fi
  path="${url#https://github.com/}"
  repo="$(printf '%s' "$path" | cut -d/ -f1-2)"
  ref="HEAD"
  subpath=""
  if [[ "$path" == */tree/* ]]; then
    suffix="${path#*/tree/}"
    ref="${suffix%%/*}"
    [[ "$suffix" == */* ]] && subpath="${suffix#*/}"
  fi
  commit="$(git ls-remote "https://github.com/${repo}.git" "$ref" 2>/dev/null | head -n1 | cut -f1 || true)"
  if [[ -z "$commit" ]]; then
    commit="$(git ls-remote "https://github.com/${repo}.git" HEAD 2>/dev/null | head -n1 | cut -f1 || true)"
  fi
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || {
    printf '[skills-backup][error] could not resolve commit for %s\n' "$id" >&2
    exit 1
  }
  jq -cn \
    --arg id "$id" --arg url "$url" --arg repo "$repo" --arg ref "$ref" \
    --arg subpath "$subpath" --arg commit "$commit" --arg fetchedAt "$fetched_at" \
    '{id:$id,url:$url,repo:$repo,ref:$ref,subpath:$subpath,commit:$commit,fetchedAt:$fetchedAt}' \
    >> "$stage/sources.ndjson"
done

[[ -f "$stage/skills-lock.json" && -d "$stage/.agents/skills" ]] || {
  printf '[skills-backup][error] skills CLI produced no complete staged tree\n' >&2
  exit 1
}
jq -s '.' "$stage/sources.ndjson" > "$stage/sources.json"
: > "$stage/skills.ndjson"
for directory in "$stage/.agents/skills"/*/; do
  [[ -d "$directory" && ! -L "$directory" ]] || continue
  name="$(basename "$directory")"
  hash="$(skill_content_hash "$directory")" || {
    printf '[skills-backup][error] %s is missing a regular SKILL.md or contains symlinks\n' "$name" >&2
    exit 1
  }
  lock="$(jq -cer --arg name "$name" '.skills[$name] | select(type == "object")' "$stage/skills-lock.json")" || {
    printf '[skills-backup][error] staged skill %s has no lock entry\n' "$name" >&2
    exit 1
  }
  repo="$(jq -r '.source' <<<"$lock")"
  skill_path="$(jq -r '.skillPath' <<<"$lock")"
  source="$(jq -cer --arg repo "$repo" --arg path "$skill_path" '
    [ .[] | . as $source | select($source.repo == $repo and ($source.subpath == "" or ($path | startswith($source.subpath)))) ]
    | sort_by(.subpath | length)
    | last
  ' "$stage/sources.json")" || {
    printf '[skills-backup][error] no manifest source owns staged skill %s (%s)\n' "$name" "$skill_path" >&2
    exit 1
  }
  jq -cn --arg name "$name" --arg hash "$hash" --argjson lock "$lock" --argjson source "$source" '
    {key:$name,value:{
      sourceId:$source.id,url:$source.url,repo:$source.repo,ref:$source.ref,commit:$source.commit,
      fetchedAt:$source.fetchedAt,skillPath:$lock.skillPath,contentHash:$hash,
      cliComputedHash:($lock.computedHash // null)
    }}
  ' >> "$stage/skills.ndjson"
done

mkdir -p "$next"
cp -R "$stage/.agents/skills" "$next/skills"
jq -n \
  --arg generatedAt "$fetched_at" \
  --slurpfile sources "$stage/sources.json" \
  --slurpfile skills "$stage/skills.ndjson" '
  {
    schemaVersion:1,
    note:"Trace-only backup of Agent Skills; NOT a runtime pin. Runs install latest and use this backup only for missing live skills.",
    generatedAt:$generatedAt,
    sourceCount:($sources[0] | length),
    installFailures:0,
    sources:$sources[0],
    skills:($skills | from_entries)
  }
  ' > "$next/manifest.json"

if [[ -d "$ROOT/skills-backup/skills" && -f "$ROOT/skills-backup/manifest.json" ]]; then
  strip='del(.generatedAt) | (.sources // []) |= map(del(.fetchedAt)) | (.skills // {}) |= map_values(del(.fetchedAt))'
  old_stable="$(jq -S "$strip" "$ROOT/skills-backup/manifest.json")"
  new_stable="$(jq -S "$strip" "$next/manifest.json")"
  if [[ "$old_stable" == "$new_stable" ]] && diff -qr "$ROOT/skills-backup/skills" "$next/skills" >/dev/null; then
    printf '[skills-backup] content unchanged\n'
    exit 0
  fi
fi

if [[ -e "$ROOT/skills-backup" ]]; then mv "$ROOT/skills-backup" "$previous"; fi
mv "$next" "$ROOT/skills-backup"
rm -rf -- "$previous"
printf '[skills-backup] refreshed %s skills from %s sources\n' \
  "$(jq '.skills | length' "$ROOT/skills-backup/manifest.json")" \
  "$(jq '.sourceCount' "$ROOT/skills-backup/manifest.json")"
