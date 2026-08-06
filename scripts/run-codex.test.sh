#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run_scope_case() {
  local needs_write="$1" expected="$2" test_root
  test_root="$(mktemp -d)"
  trap 'rm -rf -- "$test_root"' RETURN
  mkdir -p "${test_root}/bin" "${test_root}/repo" "${test_root}/work"
  : > "${test_root}/prompt.md"
cat > "${test_root}/bin/bun" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == *src/codex/runtime.ts ]]; then
  env | sed 's/=.*//' | sort > "${BOT_WORKDIR:?}/runtime.env"
  printf '%s\n' "${CCHP_NEEDS_WRITE:-<unset>}" > "${BOT_WORKDIR:?}/runtime.scope"
  mkdir -p "${BOT_WORKDIR}/ctx/codex"
  printf '{"state":"SUCCEEDED"}\n' > "${BOT_WORKDIR}/ctx/codex/terminal.json"
fi
SH
  chmod +x "${test_root}/bin/bun"

  PATH="${test_root}/bin:/usr/bin:/bin" \
  HOME="${test_root}/home" \
  BOT_WORKDIR="${test_root}/work" \
  ENGINE_DIR="$ROOT" \
  REPO_DIR="${test_root}/repo" \
  BOT_PROMPT_FILE="${test_root}/prompt.md" \
  BOT_REPO="CCH-HQ/fixture" \
  CCHP_APP_CLIENT_ID="fixture-client" \
  CCHP_APP_PRIVATE_KEY="fixture-private-key" \
  CCHP_NEEDS_WRITE="$needs_write" \
  CCHP_BOT_PROVIDER_KEYS='{"gpt-cchp":"provider-sentinel"}' \
  CCHP_BOT_PROVIDERS='{"gpt-cchp":{"headers":{"Authorization":"header-sentinel"}}}' \
  CCHP_PK_GPT_CCHP="provider-sentinel" \
  GH_TOKEN="github-sentinel" \
  SEE_API_KEY="see-sentinel" \
  HEROUI_AUTH_TOKEN="heroui-sentinel" \
  bash "$ROOT/scripts/run-codex.sh"

  [[ "$(<"${test_root}/work/runtime.scope")" == "$expected" ]] || {
    printf 'scope mismatch: needs_write=%s expected=%s actual=%s\n' \
      "$needs_write" "$expected" "$(<"${test_root}/work/runtime.scope")" >&2
    return 1
  }
  local runtime_names
  runtime_names="$(<"${test_root}/work/runtime.env")"
  for required in CCHP_APP_CLIENT_ID CCHP_APP_PRIVATE_KEY GH_TOKEN HEROUI_AUTH_TOKEN; do
    [[ $'\n'"$runtime_names"$'\n' == *$'\n'"$required"$'\n'* ]] || {
      printf 'runtime did not receive required rotation input: %s\n' "$required" >&2
      return 1
    }
  done
  [[ $'\n'"$runtime_names"$'\n' != *$'\n'CCHP_GH_TOKEN_FILE$'\n'* ]] || {
    printf 'legacy token file capability leaked to runtime\n' >&2
    return 1
  }
}

run_restart_case() {
  local test_root
  test_root="$(mktemp -d)"
  trap 'rm -rf -- "$test_root"' RETURN
  mkdir -p "${test_root}/bin" "${test_root}/repo" "${test_root}/work"
  : > "${test_root}/prompt.md"
  cat > "${test_root}/bin/bun" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" != *src/codex/runtime.ts ]]; then exit 0; fi
count_file="${BOT_WORKDIR:?}/runtime.count"
count=0
[[ ! -f "$count_file" ]] || count="$(<"$count_file")"
count=$((count + 1))
printf '%s\n' "$count" > "$count_file"
printf '%s\n' "${BOT_RUN_ID:?}" >> "${BOT_WORKDIR}/runtime.run-ids"
mkdir -p "${BOT_WORKDIR}/ctx/codex"
if [[ "$count" -eq 1 ]]; then
  printf '{"schemaVersion":1,"runId":"%s","task":"manual","state":"ROOT_RUNNING","rootThreadId":"root","rootTurnId":"turn","restartAttempts":0,"updatedAt":"2026-08-05T00:00:00.000Z"}\n' \
    "$BOT_RUN_ID" > "${BOT_WORKDIR}/ctx/codex/run-manifest.json"
  exit 42
fi
printf '{"state":"SUCCEEDED"}\n' > "${BOT_WORKDIR}/ctx/codex/terminal.json"
SH
  chmod +x "${test_root}/bin/bun"

  PATH="${test_root}/bin:/usr/bin:/bin" \
  HOME="${test_root}/home" \
  BOT_WORKDIR="${test_root}/work" \
  ENGINE_DIR="$ROOT" \
  REPO_DIR="${test_root}/repo" \
  BOT_PROMPT_FILE="${test_root}/prompt.md" \
  BOT_REPO="CCH-HQ/fixture" \
  BOT_TASK="manual" \
  GH_TOKEN="fixture-token" \
  GITHUB_RUN_ID="123" \
  GITHUB_RUN_ATTEMPT="2" \
  bash "$ROOT/scripts/run-codex.sh"

  [[ "$(<"${test_root}/work/runtime.count")" == "2" ]] || {
    printf 'runtime was not restarted exactly once\n' >&2
    return 1
  }
  [[ "$(sort -u "${test_root}/work/runtime.run-ids" | wc -l)" == "1" ]] || {
    printf 'runtime restart changed BOT_RUN_ID\n' >&2
    return 1
  }
}

run_scope_case true true
run_scope_case false false
run_restart_case
printf 'run-codex token scope tests passed\n'
