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
node - "$directory" "$run_id" <<'NODE'
const fs = require("node:fs")
const path = require("node:path")
const [directory, runId] = process.argv.slice(2)
for (const [name, mode] of [["capability-explicit-exec.json", "explicit-exec"], ["capability-native-v2.json", "native-v2"]]) {
  const value = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"))
  if (value.schema_version !== 1 || value.status !== "passed" || value.run_id !== runId || value.collaborationMode !== mode) throw new Error(`capability mode ${mode} is not a passed current-run artifact`)
  const workspace = value.workspace_write
  if (!workspace || workspace.status !== "passed" || workspace.thread_completed !== true ||
      workspace.apply_patch !== "passed" || workspace.ordinary_repo_write !== "passed" ||
      workspace.git_metadata_protected !== "passed" || workspace.agents_metadata_protected !== "passed" ||
      workspace.enforcement !== "direct") throw new Error(`capability mode ${mode} is missing workspace-write evidence`)
}
fs.writeFileSync(path.join(directory, "summary.json"), JSON.stringify({
  schema_version: 1,
  run_id: runId,
  stage: "completed",
  status: "passed",
  modes: { "explicit-exec": "passed", "native-v2": "passed" },
  workspace_write: { "explicit-exec": "passed", "native-v2": "passed" },
}) + "\n")
NODE
