#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
directory="${CCHP_CAPABILITY_ARTIFACT_DIR:?}"
run_id="${CCHP_ARTIFACT_RUN_ID:?}"
[[ ! -e "$directory" && ! -L "$directory" ]] || { printf '[capability-gate] artifact directory already exists\n' >&2; exit 1; }
mkdir -p "$directory"
for mode in explicit-exec native-v2; do
  CCHP_SMOKE_MODE="$mode" CCHP_SMOKE_ARTIFACT_DIR="$directory" CCHP_ARTIFACT_RUN_ID="$run_id" bun "$root/scripts/codex-capability-smoke.ts"
done
bun - "$directory" "$run_id" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const [directory, runId] = process.argv.slice(2)
for (const [name, mode] of [["capability-explicit-exec.json", "explicit-exec"], ["capability-native-v2.json", "native-v2"]]) {
  const value = JSON.parse(readFileSync(join(directory, name), "utf8"))
  if (value.schema_version !== 2 || value.status !== "passed" || value.run_id !== runId || value.collaborationMode !== mode) throw new Error(`capability mode ${mode} is not a passed current-run artifact`)
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
      workspace.configured_enforcement !== "direct") throw new Error(`capability mode ${mode} is missing workspace-write evidence`)
}
writeFileSync(join(directory, "summary.json"), JSON.stringify({
  schema_version: 2,
  run_id: runId,
  stage: "completed",
  status: "passed",
  modes: { "explicit-exec": "passed", "native-v2": "passed" },
  workspace_write: { "explicit-exec": "passed", "native-v2": "passed" },
}) + "\n")
NODE
