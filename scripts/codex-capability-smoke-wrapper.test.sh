#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/cchp-capability-wrapper.XXXXXX")"
trap 'rm -rf "$fixture_root"' EXIT
script_root="$fixture_root/repo"
artifact_dir="$script_root/artifacts/codex-capability/run-42-2"
real_node_bin="$(command -v node)"
[[ -x "$real_node_bin" ]]
mkdir -p "$fixture_root/bin" "$script_root/scripts" "$(dirname "$artifact_dir")"
ln -s "$real_node_bin" "$fixture_root/bin/node"
cp "$repo_root/scripts/codex-capability-smoke.sh" "$script_root/scripts/"

cat >"$fixture_root/bin/bun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$CCHP_SMOKE_MODE" >>"${FAKE_SMOKE_TRACE:?}"
if [[ "$CCHP_SMOKE_MODE" == "native-v2" ]]; then exit 17; fi
printf '{"schema_version":1,"run_id":"run-42-2","status":"passed","collaborationMode":"explicit-exec","workspace_write":{"status":"passed","thread_completed":true,"apply_patch":"passed","ordinary_repo_write":"passed","git_metadata_protected":"passed","agents_metadata_protected":"passed","enforcement":"direct"}}\n' >"$CCHP_SMOKE_ARTIFACT_DIR/capability-$CCHP_SMOKE_MODE.json"
EOF
chmod +x "$fixture_root/bin/bun"

set +e
env PATH="$fixture_root/bin:/usr/bin:/bin" \
  CCHP_ARTIFACT_RUN_ID="run-42-2" \
  CCHP_SMOKE_ARTIFACT_DIR="$artifact_dir" \
  FAKE_SMOKE_TRACE="$fixture_root/trace" \
  /bin/bash "$script_root/scripts/codex-capability-smoke.sh" >"$fixture_root/output" 2>&1
status=$?
set -e
[[ "$status" -eq 17 ]]
grep -F "[codex-capability] mode=native-v2 failed status=17 log=$artifact_dir/native-v2.log" "$fixture_root/output" >/dev/null
node - "$artifact_dir/summary.json" <<'NODE'
const summary = require(process.argv[2])
if (summary.run_id !== "run-42-2" || summary.status !== "failed" || summary.stage !== "native-v2") process.exit(1)
if (summary.modes["explicit-exec"] !== "passed" || summary.modes["native-v2"] !== "failed") process.exit(1)
if (summary.workspace_write["explicit-exec"] !== "passed" || summary.workspace_write["native-v2"] !== "failed") process.exit(1)
NODE

cat >"$fixture_root/bin/bun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$CCHP_SMOKE_MODE" >>"${FAKE_SMOKE_TRACE:?}"
exit 0
EOF
chmod +x "$fixture_root/bin/bun"
empty_artifact_dir="$script_root/artifacts/codex-capability/run-empty"
set +e
env PATH="$fixture_root/bin:/usr/bin:/bin" \
  CCHP_ARTIFACT_RUN_ID="run-empty" \
  CCHP_SMOKE_ARTIFACT_DIR="$empty_artifact_dir" \
  FAKE_SMOKE_TRACE="$fixture_root/empty-trace" \
  /bin/bash "$script_root/scripts/codex-capability-smoke.sh" >"$fixture_root/empty-output" 2>&1
status=$?
set -e
[[ "$status" -ne 0 ]]
grep -F "[codex-capability] mode=explicit-exec artifact validation failed log=$empty_artifact_dir/explicit-exec.log" "$fixture_root/empty-output" >/dev/null
node - "$empty_artifact_dir/summary.json" <<'NODE'
const summary = require(process.argv[2])
if (summary.run_id !== "run-empty" || summary.status !== "failed" || summary.modes["explicit-exec"] !== "failed") process.exit(1)
NODE

expect_unsafe() {
  local run_id="$1" target="$2" tmp_root="${3:-$fixture_root/tmp-base}"
  set +e
  env PATH="$fixture_root/bin:/usr/bin:/bin" \
    TMPDIR="$tmp_root" \
    CCHP_ARTIFACT_RUN_ID="$run_id" \
    CCHP_SMOKE_ARTIFACT_DIR="$target" \
    FAKE_SMOKE_TRACE="$fixture_root/unsafe-trace" \
    /bin/bash "$fixture_root/unsafe-repo/scripts/codex-capability-smoke.sh" >"$fixture_root/unsafe-output" 2>&1
  local status=$?
  set -e
  [[ "$status" -eq 2 ]]
}

mkdir -p "$fixture_root/unsafe-repo/scripts" "$fixture_root/tmp-base" "$fixture_root/canary-parent" "$fixture_root/real-target" "$fixture_root/outside/run-outside"
cp "$repo_root/scripts/codex-capability-smoke.sh" "$fixture_root/unsafe-repo/scripts/"
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
mkdir -p "$fixture_root/unsafe-repo/artifacts/codex-capability/run-existing"
printf 'keep\n' >"$fixture_root/unsafe-repo/artifacts/codex-capability/run-existing/canary"
expect_unsafe "run-existing" "$fixture_root/unsafe-repo/artifacts/codex-capability/run-existing"

mkdir -p "$fixture_root/symlink-repo/scripts" "$fixture_root/victim/codex-capability/run-parent"
cp "$repo_root/scripts/codex-capability-smoke.sh" "$fixture_root/symlink-repo/scripts/"
ln -s "$fixture_root/victim" "$fixture_root/symlink-repo/artifacts"
printf 'keep\n' >"$fixture_root/victim/codex-capability/run-parent/canary"
set +e
env PATH="$fixture_root/bin:/usr/bin:/bin" \
  TMPDIR="$fixture_root/tmp-base" \
  CCHP_ARTIFACT_RUN_ID="run-parent" \
  CCHP_SMOKE_ARTIFACT_DIR="$fixture_root/symlink-repo/artifacts/codex-capability/run-parent" \
  FAKE_SMOKE_TRACE="$fixture_root/unsafe-trace" \
  /bin/bash "$fixture_root/symlink-repo/scripts/codex-capability-smoke.sh" >"$fixture_root/unsafe-output" 2>&1
status=$?
set -e
[[ "$status" -eq 2 ]]
[[ -e "$fixture_root/victim/codex-capability/run-parent/canary" ]]
[[ -e "$fixture_root/canary-parent/canary" ]]
[[ -e "$fixture_root/real-target/canary" ]]
[[ -e "$fixture_root/unsafe-repo/src/run-tmpdir/canary" ]]
[[ -e "$fixture_root/unsafe-repo/artifacts/codex-capability/run-existing/canary" ]]
[[ ! -e "$fixture_root/unsafe-trace" ]]
printf '[codex-capability-wrapper-test] passed\n'
