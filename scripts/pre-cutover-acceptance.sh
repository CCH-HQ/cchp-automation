#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
run_id="${CCHP_ARTIFACT_RUN_ID:-local-$$}"
[[ "$run_id" =~ ^[A-Za-z0-9._-]+$ ]] || { printf '[pre-cutover] invalid artifact run id\n' >&2; exit 2; }
out="${CCHP_ACCEPTANCE_ARTIFACT_DIR:-${root}/artifacts/pre-cutover/${run_id}}"
case "/$out/" in *'/../'*|*'/./'*) printf '[pre-cutover] unsafe artifact directory\n' >&2; exit 2;; esac
if [[ "$out" == /* ]]; then
  artifact_input="$out"
else
  artifact_input="$root/$out"
fi
artifact_parent="$root/artifacts"
artifact_base="$artifact_parent/pre-cutover"
[[ ! -L "$artifact_parent" && ! -L "$artifact_base" && ! -L "$artifact_input" ]] || { printf '[pre-cutover] unsafe artifact directory\n' >&2; exit 2; }
[[ "$(realpath -m -- "$artifact_parent")" == "$artifact_parent" ]] || { printf '[pre-cutover] unsafe artifact directory\n' >&2; exit 2; }
[[ "$(realpath -m -- "$artifact_base")" == "$artifact_base" ]] || { printf '[pre-cutover] unsafe artifact directory\n' >&2; exit 2; }
out="$(realpath -m -- "$artifact_input")"
[[ "$out" == "$artifact_base/$run_id" ]] || { printf '[pre-cutover] artifact directory must be the run-owned acceptance path\n' >&2; exit 2; }
[[ ! -e "$out" && ! -L "$out" ]] || { printf '[pre-cutover] artifact directory already exists; use a new run id\n' >&2; exit 2; }
mkdir -p -- "$out"

tests=(
  src/codex/caller-contract.test.ts
  src/codex/providers.test.ts
  src/codex/provider-bridge.test.ts
  src/codex/production-provider-e2e.test.ts
  src/codex/capability.test.ts
  src/codex/config.test.ts
  src/codex/instructions.test.ts
  src/codex/runtime.test.ts
  src/codex/exec-adapter.test.ts
  src/codex/child-adapter.test.ts
  src/codex/agents-mcp-server.test.ts
  src/codex/explicit-lifecycle.test.ts
  src/codex/supervisor.test.ts
  src/codex/usage.test.ts
  src/codex/app-server.test.ts
  src/codex/git-http-proxy.test.ts
  src/codex/permissions.test.ts
  src/codex/events.test.ts
  src/codex/deadlines.test.ts
  src/codex/progress.test.ts
  src/codex/graph.test.ts
  src/codex/provenance.test.ts
  src/codex/run-manifest.test.ts
  src/codex/run-lock.test.ts
  src/codex/artifacts.test.ts
  src/codex/review-runner.test.ts
  src/codex/jsonl.test.ts
  src/codex/file-snapshot.test.ts
  src/codex/durable-file.test.ts
  src/codex/workflow-runtime-snapshot.test.ts
  src/codex/finalize-workflow-progress.test.ts
  src/codex/lifecycle-artifact.test.ts
  src/codex/workflow-finalization.test.ts
  src/codex/workflow-lifecycle-contract.test.ts
  src/codex/prepared-review-finalization-e2e.test.ts
  src/codex/review-admission.test.ts
  src/review/finalize.test.ts
  src/mcp/server.test.ts
  src/mcp/github-broker.test.ts
  src/mcp/see-server.test.ts
  src/github/app-token.test.ts
  src/github/token-rotation.test.ts
  src/route/acceptance-matrix.test.ts
  scripts/codex-capability-smoke.test.ts
  scripts/verify-codex-sigstore.test.ts
  scripts/external-scan-github.test.ts
)

{
  printf 'Pre-cutover acceptance matrix\n'
  printf 'Run ID: %s\n' "$run_id"
  printf 'Codex mode: native-v2 + explicit-exec\n'
  printf 'Caller ABI: 7 inputs, 5 secrets, 6 variables\n'
  printf 'Provider bridge: Responses + Chat + Anthropic\n'
  printf 'Routes: same-repo, fork, review-only, GitHub-write/read-only, manual, dispatch\n'
  printf 'Tests:\n'
  printf '  %s\n' "${tests[@]}"
} >"$out/matrix.txt"

stage="initializing"
tests_state="pending"
typecheck_state="pending"
prepare_state="pending"
run_state="pending"
cleanup_state="pending"
completed=0

write_summary() {
  local status="$1" exit_code="${2:-}"
  local tmp="$out/.summary.$$.tmp"
  {
    printf '{\n'
    printf '  "schema_version": 1,\n'
    printf '  "run_id": "%s",\n' "$run_id"
    printf '  "status": "%s",\n' "$status"
    printf '  "stage": "%s",\n' "$stage"
    if [[ -n "$exit_code" ]]; then printf '  "exit_code": %s,\n' "$exit_code"; fi
    printf '  "phases": {"tests": "%s", "typecheck": "%s", "prepare_codex_env": "%s", "run_codex": "%s", "cleanup": "%s"},\n' "$tests_state" "$typecheck_state" "$prepare_state" "$run_state" "$cleanup_state"
    printf '  "caller_abi_unchanged": %s,\n' "$([[ "$status" == "passed" ]] && printf true || printf false)"
    printf '  "collaboration_modes": ["native-v2", "explicit-exec"],\n'
    printf '  "provider_formats": ["openai-responses", "openai-compatible", "anthropic"]\n'
    printf '}\n'
  } >"$tmp"
  mv "$tmp" "$out/summary.json"
}

skip_pending() {
  if [[ "$tests_state" == "pending" ]]; then tests_state="skipped"; fi
  if [[ "$typecheck_state" == "pending" ]]; then typecheck_state="skipped"; fi
  if [[ "$prepare_state" == "pending" ]]; then prepare_state="skipped"; fi
  if [[ "$run_state" == "pending" ]]; then run_state="skipped"; fi
  if [[ "$cleanup_state" == "pending" ]]; then cleanup_state="skipped"; fi
}

on_exit() {
  local code=$?
  if [[ "$completed" -ne 1 ]]; then
    skip_pending
    write_summary failed "$code"
  fi
}
trap on_exit EXIT
write_summary running

run_phase() {
  local phase="$1" logfile="$2"
  shift 2
  stage="$phase"
  case "$phase" in
    tests) tests_state="running" ;;
    typecheck) typecheck_state="running" ;;
    prepare_codex_env) prepare_state="running" ;;
      run_codex) run_state="running" ;;
      cleanup) cleanup_state="running" ;;
  esac
  write_summary running
  set +e
  "$@" 2>&1 | tee "$logfile"
  local status=${PIPESTATUS[0]}
  set -e
  if [[ "$status" -ne 0 ]]; then
    case "$phase" in
      tests) tests_state="failed" ;;
      typecheck) typecheck_state="failed" ;;
      prepare_codex_env) prepare_state="failed" ;;
      run_codex) run_state="failed" ;;
      cleanup) cleanup_state="failed" ;;
    esac
    skip_pending
    write_summary failed "$status"
    exit "$status"
  fi
  case "$phase" in
    tests) tests_state="passed" ;;
    typecheck) typecheck_state="passed" ;;
    prepare_codex_env) prepare_state="passed" ;;
    run_codex) run_state="passed" ;;
    cleanup) cleanup_state="passed" ;;
  esac
  write_summary running
}

run_phase tests "$out/tests.txt" bun test "${tests[@]}"
run_phase typecheck "$out/typecheck.txt" bun run typecheck
run_phase prepare_codex_env "$out/prepare-codex-env.txt" bash "$root/scripts/prepare-codex-env.test.sh"
run_phase run_codex "$out/run-codex.txt" bash "$root/scripts/run-codex.test.sh"
run_phase cleanup "$out/cleanup.txt" bash "$root/scripts/cleanup.test.sh"

stage="completed"
completed=1
write_summary passed
printf '[pre-cutover] acceptance matrix passed; artifacts=%s run_id=%s\n' "$out" "$run_id"
