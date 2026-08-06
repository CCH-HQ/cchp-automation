#!/usr/bin/env bash

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
  local directory="$1"
  [[ -d "$directory" && ! -L "$directory" && -f "$directory/SKILL.md" && ! -L "$directory/SKILL.md" ]] || return 1
  if find "$directory" -type l -print -quit | grep -q .; then return 1; fi
  (
    cd "$directory"
    find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1
  )
}

validate_backup_skill() {
  local backup_root="$1" name="$2" directory="$3" expected actual
  expected="$(jq -er --arg name "$name" '.skills[$name].contentHash | select(type == "string" and test("^[0-9a-f]{64}$"))' "$backup_root/manifest.json")" || return 1
  actual="$(skill_content_hash "$directory")" || return 1
  [[ "$actual" == "$expected" ]]
}
