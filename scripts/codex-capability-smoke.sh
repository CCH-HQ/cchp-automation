#!/usr/bin/env bash
set -euo pipefail
export PATH="${HOME}/.local/bin:${PATH}"
root="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
run_id="${CCHP_ARTIFACT_RUN_ID:-local-$$}"
[[ "$run_id" =~ ^[A-Za-z0-9._-]+$ ]] || { printf '[codex-capability] invalid artifact run id\n' >&2; exit 2; }
: "${CCHP_SMOKE_ARTIFACT_DIR:=${root}/artifacts/codex-capability/${run_id}}"
case "/$CCHP_SMOKE_ARTIFACT_DIR/" in *'/../'*|*'/./'*) printf '[codex-capability] unsafe artifact directory\n' >&2; exit 2;; esac
if [[ "$CCHP_SMOKE_ARTIFACT_DIR" == /* ]]; then
  artifact_input="$CCHP_SMOKE_ARTIFACT_DIR"
else
  artifact_input="$root/$CCHP_SMOKE_ARTIFACT_DIR"
fi
artifact_parent="$root/artifacts"
artifact_base="$artifact_parent/codex-capability"
[[ ! -L "$artifact_parent" && ! -L "$artifact_base" && ! -L "$artifact_input" ]] || { printf '[codex-capability] unsafe artifact directory\n' >&2; exit 2; }
[[ "$(realpath -m -- "$artifact_parent")" == "$artifact_parent" ]] || { printf '[codex-capability] unsafe artifact directory\n' >&2; exit 2; }
[[ "$(realpath -m -- "$artifact_base")" == "$artifact_base" ]] || { printf '[codex-capability] unsafe artifact directory\n' >&2; exit 2; }
CCHP_SMOKE_ARTIFACT_DIR="$(realpath -m -- "$artifact_input")"
[[ "$CCHP_SMOKE_ARTIFACT_DIR" == "$artifact_base/$run_id" ]] || { printf '[codex-capability] artifact directory must be the run-owned capability path\n' >&2; exit 2; }
[[ ! -e "$CCHP_SMOKE_ARTIFACT_DIR" && ! -L "$CCHP_SMOKE_ARTIFACT_DIR" ]] || { printf '[codex-capability] artifact directory already exists; use a new run id\n' >&2; exit 2; }
mkdir -p -- "$CCHP_SMOKE_ARTIFACT_DIR"
export CCHP_SMOKE_ARTIFACT_DIR CCHP_ARTIFACT_RUN_ID="$run_id"

stage="initializing"
explicit_state="pending"
native_state="pending"
completed=0

write_summary() {
  local status="$1" exit_code="${2:-}"
  local tmp="$CCHP_SMOKE_ARTIFACT_DIR/.summary.$$.tmp"
  {
    printf '{\n'
    printf '  "schema_version": 2,\n'
    printf '  "run_id": "%s",\n' "$run_id"
    printf '  "status": "%s",\n' "$status"
    printf '  "stage": "%s",\n' "$stage"
    if [[ -n "$exit_code" ]]; then printf '  "exit_code": %s,\n' "$exit_code"; fi
    printf '  "modes": {"explicit-exec": "%s", "native-v2": "%s"},\n' "$explicit_state" "$native_state"
    printf '  "workspace_write": {"explicit-exec": "%s", "native-v2": "%s"}\n' "$explicit_state" "$native_state"
    printf '}\n'
  } >"$tmp"
  mv "$tmp" "$CCHP_SMOKE_ARTIFACT_DIR/summary.json"
}

validate_mode_artifact() {
  local mode="$1" path="$CCHP_SMOKE_ARTIFACT_DIR/capability-$mode.json"
  [[ -f "$path" && ! -L "$path" ]] || { printf '[codex-capability] missing mode artifact: %s\n' "$path" >&2; return 1; }
  node - "$path" "$mode" "$run_id" <<'NODE'
const fs = require("node:fs")
const [path, mode, runId] = process.argv.slice(2)
const value = JSON.parse(fs.readFileSync(path, "utf8"))
if (value.schema_version !== 2 || value.status !== "passed" || value.run_id !== runId || value.collaborationMode !== mode) {
  throw new Error(`invalid capability artifact: ${path}`)
}
const workspace = value.workspace_write
const network = workspace?.external_network
if (!workspace || workspace.status !== "passed" || workspace.thread_completed !== true ||
    workspace.apply_patch !== "passed" || workspace.ordinary_repo_write !== "passed" ||
    workspace.app_server_long_lived_secrets_absent !== "passed" || workspace.shell_capabilities_excluded !== "passed" ||
    workspace.shell_snapshot_directory_absent !== "passed" ||
    !network || network.result !== "policy-blocked" ||
    !["proxy-structured-denial", "os-connect-denied"].includes(network.reason) ||
    network.probe_target !== "https://example.com" || network.configured_enforcement !== "direct" ||
    workspace.git_metadata_protected !== "passed" || workspace.agents_metadata_protected !== "passed" ||
    workspace.configured_enforcement !== "direct") {
  throw new Error(`workspace-write capability is incomplete: ${path}`)
}
NODE
}

on_exit() {
  local code=$?
  if [[ "$completed" -ne 1 ]]; then
    if [[ "$explicit_state" == "pending" ]]; then explicit_state="skipped"; fi
    if [[ "$native_state" == "pending" ]]; then native_state="skipped"; fi
    write_summary failed "$code"
  fi
}
trap on_exit EXIT
write_summary running

for mode in explicit-exec native-v2; do
  stage="$mode"
  if [[ "$mode" == "explicit-exec" ]]; then explicit_state="running"; else native_state="running"; fi
  write_summary running
  set +e
  CCHP_SMOKE_MODE="$mode" bun "$root/scripts/codex-capability-smoke.ts" 2>&1 | tee "$CCHP_SMOKE_ARTIFACT_DIR/$mode.log"
  status=${PIPESTATUS[0]}
  set -e
  if [[ "$status" -ne 0 ]]; then
    printf '[codex-capability] mode=%s failed status=%s log=%s\n' \
      "$mode" "$status" "$CCHP_SMOKE_ARTIFACT_DIR/$mode.log" >&2
    if [[ "$mode" == "explicit-exec" ]]; then explicit_state="failed"; else native_state="failed"; fi
    if [[ "$explicit_state" == "pending" ]]; then explicit_state="skipped"; fi
    if [[ "$native_state" == "pending" ]]; then native_state="skipped"; fi
    write_summary failed "$status"
    exit "$status"
  fi
  if ! validate_mode_artifact "$mode"; then
    printf '[codex-capability] mode=%s artifact validation failed log=%s\n' \
      "$mode" "$CCHP_SMOKE_ARTIFACT_DIR/$mode.log" >&2
    if [[ "$mode" == "explicit-exec" ]]; then explicit_state="failed"; else native_state="failed"; fi
    write_summary failed 1
    exit 1
  fi
  if [[ "$mode" == "explicit-exec" ]]; then explicit_state="passed"; else native_state="passed"; fi
  write_summary running
done

stage="completed"
completed=1
write_summary passed
printf '[codex-capability] all modes passed; artifacts=%s run_id=%s\n' "$CCHP_SMOKE_ARTIFACT_DIR" "$run_id"
