#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/cchp-capability-gate.XXXXXX")"
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/repo/scripts"
cp "$root/scripts/verify-capability-gate.sh" "$fixture/repo/scripts/"

cat >"$fixture/bin/bun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mode="${CCHP_SMOKE_MODE:?}"
artifact="${CCHP_CAPABILITY_ARTIFACT_DIR:?}/capability-${mode}.json"
mkdir -p "$(dirname "$artifact")"
app_server='"app_server_long_lived_secrets_absent":"passed",'
shell_caps='"shell_capabilities_excluded":"passed",'
shell_snapshot='"shell_snapshot_directory_absent":"passed",'
network_reason="${TEST_NETWORK_REASON:-proxy-structured-denial}"
network='"external_network":{"result":"policy-blocked","reason":"'"$network_reason"'","probe_target":"https://example.com","configured_enforcement":"direct"},'
[[ "${TEST_OMIT_FIELD:-}" != "app_server_long_lived_secrets_absent" ]] || app_server=''
[[ "${TEST_OMIT_FIELD:-}" != "shell_capabilities_excluded" ]] || shell_caps=''
[[ "${TEST_OMIT_FIELD:-}" != "shell_snapshot_directory_absent" ]] || shell_snapshot=''
[[ "${TEST_OMIT_FIELD:-}" != "external_network" ]] || network=''
printf '{"schema_version":2,"run_id":"%s","status":"passed","collaborationMode":"%s","workspace_write":{"status":"passed","thread_completed":true,"apply_patch":"passed","ordinary_repo_write":"passed",%s%s%s%s"git_metadata_protected":"passed","agents_metadata_protected":"passed","configured_enforcement":"direct"}}\n' \
  "$CCHP_ARTIFACT_RUN_ID" "$mode" "$app_server" "$shell_caps" "$shell_snapshot" "$network" >"$artifact"
EOF
chmod +x "$fixture/bin/bun"

run_case() {
  local name="$1" omitted="$2" expected="$3" network_reason="${4:-}" status
  local directory="$fixture/repo/artifacts/$name"
  set +e
  PATH="$fixture/bin:/usr/bin:/bin" \
    TEST_OMIT_FIELD="$omitted" \
    TEST_NETWORK_REASON="$network_reason" \
    CCHP_ARTIFACT_RUN_ID="$name" \
    CCHP_CAPABILITY_ARTIFACT_DIR="$directory" \
    bash "$fixture/repo/scripts/verify-capability-gate.sh" >"$fixture/$name.log" 2>&1
  status=$?
  set -e
  [[ "$status" -eq "$expected" ]] || {
    printf 'case %s expected exit %s, got %s\n' "$name" "$expected" "$status" >&2
    cat "$fixture/$name.log" >&2
    return 1
  }
}

run_case complete "" 0
run_case missing-app-server app_server_long_lived_secrets_absent 1
run_case missing-shell-capabilities shell_capabilities_excluded 1
run_case missing-shell-snapshot shell_snapshot_directory_absent 1
run_case missing-network external_network 1
run_case ambiguous-network "" 1 unclassified-error
printf '[capability-gate-test] passed\n'
