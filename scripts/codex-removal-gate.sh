#!/usr/bin/env bash
set -euo pipefail

ROOT="${CCHP_REMOVAL_ROOT:-$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
[[ -n "$ROOT" && "$ROOT" != "/" ]] || {
  printf '[codex-removal][error] unsafe repository root\n' >&2
  exit 2
}
cd "$ROOT"
engine='open''code'
plugin='oh-my-''openagent'
plugin_short='o''mo'
coordinator='sis''yphus'
legacy_tool='ultra_''review_task'
legacy_noop='CCHP_BOT_OPEN''CODE_VERSION'
pattern="${engine}|${plugin}|\\b${plugin_short}\\b|${coordinator}|${legacy_tool}|${legacy_noop}"
fallback_pattern="${engine}|${plugin}|(^|[^[:alnum:]_])${plugin_short}([^[:alnum:]_]|$)|${coordinator}|${legacy_tool}|${legacy_noop}"
if command -v rg >/dev/null 2>&1; then
  has_rg=1
else
  has_rg=0
fi

search_matches() {
  local file="$1"
  if [[ "$has_rg" == "1" ]]; then
    rg -n -i "$pattern" "$file" || true
  else
    grep -nEi "$fallback_pattern" "$file" || true
  fi
}

search_stdin() {
  if [[ "$has_rg" == "1" ]]; then
    rg -n -i "$pattern" - || true
  else
    grep -nEi "$fallback_pattern" || true
  fi
}

search_files() {
  if [[ "$has_rg" == "1" ]]; then
    rg -l -0 -i "$pattern" "$@" \
      --glob '!codex/review/reference-library/**' \
      --glob '!scripts/codex-removal-gate.test.sh' \
      --glob '!scripts/codex-removal-gate.sh' || true
  else
    grep -RIlZE "$fallback_pattern" \
      --exclude-dir=.git \
      --exclude-dir=reference-library \
      "$@" || true
  fi
}

# Live production surfaces. The migration record is deliberately not in this
# list: it is historical provenance, not an instruction or runtime surface.
search_roots=(.github scripts src codex README.md docs package.json bun.lock)
[[ -e tests ]] && search_roots+=(tests)
config_files=()
while IFS= read -r -d '' file; do config_files+=("$file"); done < <(
  if [[ "$has_rg" == "1" ]]; then
    rg --files --hidden -0 \
      --glob '!.git/**' \
      -g 'package.json' \
      -g 'package-lock.json' \
      -g 'npm-shrinkwrap.json' \
      -g 'pnpm-lock.yaml' \
      -g 'yarn.lock' \
      -g 'bun.lock' \
      -g '!codex/review/reference-library/**' || true
  else
    find . -type f \
      \( -name package.json -o -name package-lock.json -o -name npm-shrinkwrap.json -o -name pnpm-lock.yaml -o -name yarn.lock -o -name bun.lock \) \
      ! -path './.git/*' \
      ! -path './codex/review/reference-library/*' \
      -print0
  fi
)
search_roots+=("${config_files[@]}")

caller_contract='src/codex/caller-contract.ts'
if [[ -f "$caller_contract" ]]; then
  noop_count="$(grep -oF "$legacy_noop" "$caller_contract" | wc -l | tr -d '[:space:]')"
  declaration_count="$(grep -nE "^[[:space:]]*\"${legacy_noop}\",[[:space:]]*$" "$caller_contract" | wc -l | tr -d '[:space:]')"
  if [[ "$noop_count" != "1" || "$declaration_count" != "1" ]]; then
    printf '[codex-removal][error] ignored legacy caller variable must appear exactly once in CALLER_VARIABLES\n' >&2
    exit 1
  fi
fi

found=0
while IFS= read -r -d '' file; do
  if [[ "$file" == "docs/ci/codex-cli-full-migration-plan.md" ]]; then
    continue
  fi
  # The caller ABI keeps one ignored variable declaration plus explicit tests
  # and documentation. Runtime reads remain forbidden, including extra reads in
  # the declaration file itself.
  case "$file" in
    README.md)
      matches="$(sed '/^- `'"$legacy_noop"'` is retained as an ignored legacy no-op so existing$/s/'"$legacy_noop"'//' "$file" | search_stdin)"
      ;;
    src/codex/caller-contract.ts)
      matches="$(sed "/^[[:space:]]*\"${legacy_noop}\",[[:space:]]*$/s/${legacy_noop}//" "$file" | search_stdin)"
      ;;
    *.test.ts)
      matches="$(sed "s/${legacy_noop}//g" "$file" | search_stdin)"
      ;;
    *)
      matches="$(search_matches "$file")"
      ;;
  esac
  if [[ -n "$matches" ]]; then
    while IFS= read -r match; do printf '%s:%s\n' "$file" "$match" >&2; done <<< "$matches"
    found=1
  fi
done < <(search_files "${search_roots[@]}")

for file in "${config_files[@]}"; do
  case "${file##*/}" in
    package.json|package-lock.json|npm-shrinkwrap.json)
      if ! decoded="$(node - "$file" <<'NODE'
const fs = require("node:fs")
const file = process.argv[2]
try {
  process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))))
} catch (error) {
  console.error(`${file}: invalid JSON package config: ${error.message}`)
  process.exit(2)
}
NODE
)"; then
        found=1
        continue
      fi
      decoded_matches="$(printf '%s' "$decoded" | search_stdin)"
      if [[ -n "$decoded_matches" ]]; then
        printf '%s:%s\n' "$file" "$decoded_matches" >&2
        found=1
      fi
      ;;
  esac
done
if [[ "$found" == "1" ]]; then
  printf '[codex-removal][error] legacy engine references remain outside the frozen ABI and vendored parity corpus\n' >&2
  exit 1
fi
for deleted in \
  "$ROOT/opencode" \
  "$ROOT/scripts/run.sh" \
  "$ROOT/scripts/permissions.sh" \
  "$ROOT/scripts/prepare-env.sh" \
  "$ROOT/scripts/review-finalize.sh" \
  "$ROOT/scripts/gh-token-refresher.ts" \
  "$ROOT/scripts/gh-token-refresher.test.ts"; do
  if [[ -e "$deleted" || -L "$deleted" ]]; then
    printf '[codex-removal][error] legacy runtime path remains: %s\n' "$deleted" >&2
    exit 1
  fi
done
if grep -RInE 'BOT_REVIEW_FINALIZER|CCHP_REVIEW_FINALIZER' .github scripts src codex \
  --exclude-dir=.git \
  --exclude='codex-removal-gate.sh' \
  --exclude='codex-removal-gate.test.sh'; then
  printf '[codex-removal][error] legacy shell finalizer wiring remains\n' >&2
  exit 1
fi
printf '[codex-removal] production paths are Codex-only\n'
