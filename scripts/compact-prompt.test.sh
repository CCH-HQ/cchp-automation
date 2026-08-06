#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

protocol="${ENGINE_ROOT}/codex/prompts-ultra-protocol.md"
catalog="${ENGINE_ROOT}/codex/review/reference-library/catalog.json"
system_prompt="${ENGINE_ROOT}/codex/system-prompt.md"
[[ -f "$protocol" && -f "$catalog" && -f "$system_prompt" ]]
grep -Fq 'agents.spawn_agent' "$protocol"
grep -Fq 'agents.wait_agent' "$protocol"
grep -Fq 'agents.followup_task' "$protocol"
grep -Fq 'agents.interrupt_agent' "$protocol"
grep -Fq 'Three complete fresh gap-sweep rounds' "$protocol"
jq -e '
  .statistics.unique_entries == 242 and
  .statistics.total_origins == 249 and
  .statistics.deduplicated_origins == 7 and
  (.sources | map(.imported_files) == [45,152,62])
' "$catalog" >/dev/null

small="${test_root}/small"
mkdir -p "$small"
printf '%s\n' 'TASK: compact prompt small fixture' > "$small/prompt.md"
BOT_WORKDIR="$small" BOT_PROMPT_FILE="$small/prompt.md" bash "$SCRIPT_DIR/compact-prompt.sh"
grep -Fq 'TASK: compact prompt small fixture' "$small/prompt.md"
[[ ! -e "$small/ctx/prompt-full.md" ]]

large="${test_root}/large"
mkdir -p "$large"
{
  printf '%s\n' 'TASK: compact prompt large fixture'
  head -c 13000 /dev/zero | tr '\0' x
  printf '\n'
} > "$large/prompt.md"
BOT_WORKDIR="$large" BOT_PROMPT_FILE="$large/prompt.md" bash "$SCRIPT_DIR/compact-prompt.sh"
[[ -f "$large/ctx/prompt-full.md" ]]
grep -Fq "${large}/ctx/prompt-full.md" "$large/prompt.md"
grep -Fq 'TASK: compact prompt large fixture' "$large/ctx/prompt-full.md"

printf 'compact prompt and Codex review asset tests passed\n'
