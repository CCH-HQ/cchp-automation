#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/cchp-removal-gate.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT

new_fixture() {
  local name="$1"
  local root="$test_root/$name"
  mkdir -p "$root/.github" "$root/scripts" "$root/src/codex" \
    "$root/codex/review/reference-library" "$root/docs/ci"
  printf '%s\n' '- `CCHP_BOT_OPENCODE_VERSION` is retained as an ignored legacy no-op so existing' >"$root/README.md"
  printf 'Codex-only live operator guide.\n' >"$root/docs/ci/agent-toolchain.md"
  printf 'export const CALLER_VARIABLES = [\n  "CCHP_BOT_OPENCODE_VERSION",\n] as const\n' >"$root/src/codex/caller-contract.ts"
  printf '{"scripts":{"test":"bun test"}}\n' >"$root/package.json"
  printf '# clean lockfile\n' >"$root/bun.lock"
  printf '%s\n' "$root"
}

expect_pass() {
  local root="$1"
  if ! CCHP_REMOVAL_ROOT="$root" bash "$repo_root/scripts/codex-removal-gate.sh" >"$root/gate.out" 2>&1; then
    sed -n '1,200p' "$root/gate.out" >&2
    exit 1
  fi
}

expect_fail() {
  local root="$1"
  if CCHP_REMOVAL_ROOT="$root" bash "$repo_root/scripts/codex-removal-gate.sh" >"$root/gate.out" 2>&1; then
    printf '[codex-removal-gate-test][error] expected failure for %s\n' "$root" >&2
    exit 1
  fi
}

clean="$(new_fixture clean)"
expect_pass "$clean"

for legacy in OpenCode oPeNcOdE Oh-My-OpenAgent omo Sisyphus Ultra_Review_Task; do
  slug="$(printf '%s' "$legacy" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-')"
  fixture="$(new_fixture "legacy-$slug")"
  printf 'Live production fallback: %s.\n' "$legacy" >>"$fixture/docs/ci/agent-toolchain.md"
  expect_fail "$fixture"
done

docs_scope="$(new_fixture docs-scope)"
mkdir -p "$docs_scope/docs/operator"
printf 'Install OpenCode and OMo for production runs.\n' >"$docs_scope/docs/operator/setup.md"
expect_fail "$docs_scope"

same_line="$(new_fixture same-line)"
printf 'CCHP_BOT_OPENCODE_VERSION OpenCode runtime selection\n' >>"$same_line/README.md"
expect_fail "$same_line"

active_noop="$(new_fixture active-noop)"
printf 'const selected = env.CCHP_BOT_OPENCODE_VERSION\n' >"$active_noop/src/runtime.ts"
expect_fail "$active_noop"

caller_drift="$(new_fixture caller-drift)"
printf 'export const selected = process.env.CCHP_BOT_OPENCODE_VERSION\n' >>"$caller_drift/src/codex/caller-contract.ts"
expect_fail "$caller_drift"

caller_duplicate="$(new_fixture caller-duplicate)"
printf 'export const ACTIVE_RUNTIME_KEYS = [\n  "CCHP_BOT_OPENCODE_VERSION",\n]\n' >>"$caller_duplicate/src/codex/caller-contract.ts"
expect_fail "$caller_duplicate"

dependency="$(new_fixture dependency)"
printf '{"scripts":{"legacy":"opencode run"},"dependencies":{"oh-my-openagent":"1.0.0"}}\n' >"$dependency/package.json"
expect_fail "$dependency"

lockfile="$(new_fixture lockfile)"
printf 'opencode@1.0.0\n' >"$lockfile/bun.lock"
expect_fail "$lockfile"

for lock_name in package-lock.json npm-shrinkwrap.json pnpm-lock.yaml yarn.lock; do
  slug="${lock_name//./-}"
  config="$(new_fixture "config-$slug")"
  printf 'opencode@1.0.0\n' >"$config/$lock_name"
  expect_fail "$config"
done

nested_package="$(new_fixture nested-package)"
mkdir -p "$nested_package/packages/live"
printf '{"scripts":{"legacy":"opencode run"}}\n' >"$nested_package/packages/live/package.json"
expect_fail "$nested_package"

escaped_package="$(new_fixture escaped-package)"
printf '%s\n' '{"scripts":{"legacy":"openco\u0064e run"}}' >"$escaped_package/package.json"
expect_fail "$escaped_package"

hidden_escaped_package="$(new_fixture hidden-escaped-package)"
mkdir -p "$hidden_escaped_package/.github/actions/live"
printf '%s\n' '{"scripts":{"legacy":"openco\u0064e run"}}' \
  >"$hidden_escaped_package/.github/actions/live/package.json"
expect_fail "$hidden_escaped_package"
if ! grep -qF '.github/actions/live/package.json:' "$hidden_escaped_package/gate.out"; then
  printf '[codex-removal-gate-test][error] hidden escaped package was not reported\n' >&2
  exit 1
fi

hidden_lockfile="$(new_fixture hidden-lockfile)"
mkdir -p "$hidden_lockfile/.cache"
printf 'opencode@1.0.0\n' >"$hidden_lockfile/.cache/pnpm-lock.yaml"
expect_fail "$hidden_lockfile"
if ! grep -qF '.cache/pnpm-lock.yaml:' "$hidden_lockfile/gate.out"; then
  printf '[codex-removal-gate-test][error] hidden lockfile was not reported\n' >&2
  exit 1
fi

historical="$(new_fixture historical)"
printf 'Historical OpenCode and OMo migration baseline.\n' >"$historical/docs/ci/codex-cli-full-migration-plan.md"
printf 'Vendored OpenCode parity fixture.\n' >"$historical/codex/review/reference-library/baseline.md"
mkdir -p "$historical/codex/review/reference-library/.fixture"
printf '%s\n' '{"scripts":{"legacy":"openco\u0064e run"}}' \
  >"$historical/codex/review/reference-library/.fixture/package.json"
expect_pass "$historical"

deleted_path="$(new_fixture deleted-path)"
printf '#!/usr/bin/env bash\n' >"$deleted_path/scripts/run.sh"
expect_fail "$deleted_path"

token_sidecar="$(new_fixture token-sidecar)"
printf '#!/usr/bin/env bun\n' >"$token_sidecar/scripts/gh-token-refresher.ts"
expect_fail "$token_sidecar"

finalizer="$(new_fixture finalizer)"
printf 'const legacy = "BOT_REVIEW_FINALIZER"\n' >"$finalizer/src/finalizer.ts"
expect_fail "$finalizer"

workflow_finalizer="$(new_fixture workflow-finalizer)"
printf 'env:\n  CCHP_REVIEW_FINALIZER: scripts/review-finalize.sh\n' >"$workflow_finalizer/.github/live.yml"
expect_fail "$workflow_finalizer"

broken_path="$(new_fixture broken-path)"
ln -s missing-target "$broken_path/opencode"
expect_fail "$broken_path"

# The detector fixtures intentionally contain forbidden literals, so the live
# gate must exclude this behavior-test file while still passing on the repo.
CCHP_REMOVAL_ROOT="$repo_root" bash "$repo_root/scripts/codex-removal-gate.sh" >/dev/null

printf '[codex-removal-gate-test] passed\n'
