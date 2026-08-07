#!/usr/bin/env bash

SKILLS_LIB_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

validate_skill_frontmatter() {
  local directory="$1" expected_name="${2:-$(basename "$1")}" bun_bin="${CCHP_BUN_BIN:-}"
  if [[ -z "$bun_bin" ]]; then bun_bin="$(command -v bun)" || return 1; fi
  "$bun_bin" "$SKILLS_LIB_DIR/validate-skill-frontmatter.ts" "$directory" "$expected_name" >/dev/null
}

skills_manifest_rows() {
  local manifest="$1"
  [[ -f "$manifest" && ! -L "$manifest" ]] || {
    printf 'skills manifest must be a regular file: %s\n' "$manifest" >&2
    return 1
  }
  jq -er '
    def valid_source:
      ((.id | type) == "string" and (.id | test("^[a-z0-9][a-z0-9-]*$")))
      and ((.url | type) == "string" and (.url | startswith("https://github.com/")))
      and ((.timeoutSeconds | type) == "number"
        and (.timeoutSeconds | floor) == .timeoutSeconds
        and (.timeoutSeconds >= 1)
        and (.timeoutSeconds <= 600));
    select(.schemaVersion == 1)
    | select((.sources | type) == "array" and (.sources | length) > 0)
    | select(all(.sources[]; valid_source))
    | select([.sources[].id] | length == (unique | length))
    | select([.sources[].url] | length == (unique | length))
    | .sources[]
    | [.id, .url, (.timeoutSeconds | tostring)]
    | @tsv
  ' "$manifest"
}

skill_content_hash() {
  local directory="$1" expected_name="${2:-$(basename "$1")}"
  [[ -d "$directory" && ! -L "$directory" && -f "$directory/SKILL.md" && ! -L "$directory/SKILL.md" ]] || return 1
  if find "$directory" -type l -print -quit | grep -q .; then return 1; fi
  validate_skill_frontmatter "$directory" "$expected_name" || return 1
  (
    cd "$directory"
    find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1
  )
}

replace_skill_directory() {
  local source="$1" target_root="$2" name="$3" stage bun_bin="${CCHP_BUN_BIN:-}"
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || return 1
  if [[ -z "$bun_bin" ]]; then bun_bin="$(command -v bun)" || return 1; fi
  stage="$(mktemp -d "$target_root/.${name}.XXXXXX")" || return 1
  if ! cp -R "$source/." "$stage/" || ! skill_content_hash "$stage" "$name" >/dev/null; then
    rm -rf -- "$stage"
    return 1
  fi
  if ! "$bun_bin" "$SKILLS_LIB_DIR/atomic-replace-directory.ts" "$stage" "$target_root/$name"; then
    rm -rf -- "$stage"
    return 1
  fi
}

validate_backup_skill() {
  local backup_root="$1" name="$2" directory="$3" expected actual
  expected="$(jq -er --arg name "$name" '.skills[$name].contentHash | select(type == "string" and test("^[0-9a-f]{64}$"))' "$backup_root/manifest.json")" || return 1
  actual="$(skill_content_hash "$directory")" || return 1
  [[ "$actual" == "$expected" ]]
}
