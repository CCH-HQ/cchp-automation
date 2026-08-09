#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/cchp-pre-cutover-wrapper.XXXXXX")"
trap 'rm -rf "$fixture_root"' EXIT
script_root="$fixture_root/repo"
artifact_dir="$script_root/artifacts/pre-cutover/run-77-3"
mkdir -p "$fixture_root/bin" "$script_root/scripts" "$(dirname "$artifact_dir")"
cp "$repo_root/scripts/pre-cutover-acceptance.sh" "$script_root/scripts/"

cat >"$fixture_root/bin/bun" <<'EOF'
#!/usr/bin/env bash
exit 23
EOF
chmod +x "$fixture_root/bin/bun"

set +e
env PATH="$fixture_root/bin:/usr/bin:/bin" \
  CCHP_ARTIFACT_RUN_ID="run-77-3" \
  CCHP_ACCEPTANCE_ARTIFACT_DIR="$artifact_dir" \
  /bin/bash "$script_root/scripts/pre-cutover-acceptance.sh" >"$fixture_root/output" 2>&1
status=$?
set -e
if [[ "$status" -ne 23 ]]; then
  sed -n '1,200p' "$fixture_root/output" >&2
  exit 1
fi
node - "$artifact_dir/summary.json" <<'NODE'
const summary = require(process.argv[2])
if (summary.run_id !== "run-77-3" || summary.status !== "failed" || summary.stage !== "tests" || summary.exit_code !== 23) process.exit(1)
if (summary.phases.tests !== "failed" || summary.phases.typecheck !== "skipped" || summary.phases.cleanup !== "skipped") process.exit(1)
NODE

expect_unsafe() {
  local run_id="$1" target="$2" tmp_root="${3:-$fixture_root/tmp-base}"
  set +e
  env PATH="$fixture_root/bin:/usr/bin:/bin" \
    TMPDIR="$tmp_root" \
    CCHP_ARTIFACT_RUN_ID="$run_id" \
    CCHP_ACCEPTANCE_ARTIFACT_DIR="$target" \
    /bin/bash "$fixture_root/unsafe-repo/scripts/pre-cutover-acceptance.sh" >"$fixture_root/unsafe-output" 2>&1
  local status=$?
  set -e
  [[ "$status" -eq 2 ]]
}

mkdir -p "$fixture_root/unsafe-repo/scripts" "$fixture_root/tmp-base" "$fixture_root/canary-parent" "$fixture_root/real-target" "$fixture_root/outside/run-outside"
cp "$repo_root/scripts/pre-cutover-acceptance.sh" "$fixture_root/unsafe-repo/scripts/"
printf 'keep\n' >"$fixture_root/canary-parent/canary"
printf 'keep\n' >"$fixture_root/real-target/canary"
ln -s "$fixture_root/real-target" "$fixture_root/run-symlink"
expect_unsafe "tmp-base" "$fixture_root/tmp-base"
expect_unsafe "run-dotdot" "$fixture_root/canary-parent/../run-dotdot"
expect_unsafe "unsafe-repo" "$fixture_root/unsafe-repo/."
expect_unsafe "run-symlink" "$fixture_root/run-symlink"
expect_unsafe "run-outside" "$fixture_root/outside/run-outside"
mkdir -p "$fixture_root/unsafe-repo/src/run-tmpdir"
printf 'keep\n' >"$fixture_root/unsafe-repo/src/run-tmpdir/canary"
expect_unsafe "run-tmpdir" "$fixture_root/unsafe-repo/src/run-tmpdir" "$fixture_root/unsafe-repo"
mkdir -p "$fixture_root/unsafe-repo/artifacts/pre-cutover/run-existing"
printf 'keep\n' >"$fixture_root/unsafe-repo/artifacts/pre-cutover/run-existing/canary"
expect_unsafe "run-existing" "$fixture_root/unsafe-repo/artifacts/pre-cutover/run-existing"

mkdir -p "$fixture_root/symlink-repo/scripts" "$fixture_root/victim/pre-cutover/run-parent"
cp "$repo_root/scripts/pre-cutover-acceptance.sh" "$fixture_root/symlink-repo/scripts/"
ln -s "$fixture_root/victim" "$fixture_root/symlink-repo/artifacts"
printf 'keep\n' >"$fixture_root/victim/pre-cutover/run-parent/canary"
set +e
env PATH="$fixture_root/bin:/usr/bin:/bin" \
  TMPDIR="$fixture_root/tmp-base" \
  CCHP_ARTIFACT_RUN_ID="run-parent" \
  CCHP_ACCEPTANCE_ARTIFACT_DIR="$fixture_root/symlink-repo/artifacts/pre-cutover/run-parent" \
  /bin/bash "$fixture_root/symlink-repo/scripts/pre-cutover-acceptance.sh" >"$fixture_root/unsafe-output" 2>&1
status=$?
set -e
[[ "$status" -eq 2 ]]
[[ -e "$fixture_root/victim/pre-cutover/run-parent/canary" ]]
[[ -e "$fixture_root/canary-parent/canary" ]]
[[ -e "$fixture_root/real-target/canary" ]]
[[ -e "$fixture_root/unsafe-repo/src/run-tmpdir/canary" ]]
[[ -e "$fixture_root/unsafe-repo/artifacts/pre-cutover/run-existing/canary" ]]
printf '[pre-cutover-wrapper-test] passed\n'
