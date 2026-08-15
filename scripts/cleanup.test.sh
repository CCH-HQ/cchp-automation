#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cleanup="$repo_root/scripts/cleanup.sh"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/cchp-cleanup-test.XXXXXX")"
trap 'rm -rf -- "$fixture"' EXIT
runner_temp="$fixture/runner"
mkdir -p -- "$runner_temp"
record_key="$(printf 'ab%.0s' {1..32})"
session_token="$(printf 'cd%.0s' {1..32})"

python3 "$repo_root/scripts/process-session-signal.test.py"

process_live() {
  local pid="$1" stat state
  [[ -r "/proc/${pid}/stat" ]] || return 1
  stat="$(<"/proc/${pid}/stat")" || return 1
  stat="${stat##*) }"
  read -r state _ <<<"$stat"
  [[ "$state" != "Z" ]]
}

authenticate_file() {
  local path="$1" json mac temporary
  json="$(<"$path")"
  mac="$(printf '%s' "$(jq -cS 'del(.mac)' <<<"$json")" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:${record_key}" | awk '{print $NF}')"
  temporary="${path}.authenticated"
  jq --arg mac "$mac" '. + {mac: $mac}' <<<"$json" >"$temporary"
  mv -f -- "$temporary" "$path"
}

prepare_context() {
  local workdir="$1"
  lifecycle_dir="$(mktemp -d -- "$runner_temp/lifecycle.XXXXXX")"
  identity_path="$lifecycle_dir/workdir-identity.json"
  cleanup_marker="$lifecycle_dir/cleanup-complete.json"
  process_file="$lifecycle_dir/codex-app-server-process.json"
  jq -n \
    --arg path "$workdir" \
    --argjson device "$(stat -Lc '%d' -- "$workdir")" \
    --argjson inode "$(stat -Lc '%i' -- "$workdir")" \
    '{schemaVersion: 1, path: $path, device: $device, inode: $inode, githubRunId: "123", githubRunAttempt: "2"}' \
    >"$identity_path"
  authenticate_file "$identity_path"
  chmod 600 "$identity_path"
}

run_cleanup() {
  env \
    ENGINE_DIR="$repo_root" \
    RUNNER_TEMP="$runner_temp" \
    GITHUB_RUN_ID=123 \
    GITHUB_RUN_ATTEMPT=2 \
    BOT_RUN_ID=run \
    BOT_WORKDIR="$1" \
    CCHP_PROCESS_RECORD_HMAC_KEY="$record_key" \
    CCHP_WORKDIR_IDENTITY_PATH="$identity_path" \
    CCHP_CLEANUP_COMPLETE_PATH="$cleanup_marker" \
    CCHP_CODEX_PID_FILE="$process_file" \
    bash "$cleanup"
}

workdir="$(mktemp -d -- "$runner_temp/cchp-bot.123.2.XXXXXX")"
victim="$fixture/victim"
mkdir -p -- "$workdir/readonly" "$victim"
printf 'keep\n' >"$victim/canary"
printf 'remove\n' >"$workdir/readonly/file"
chmod 500 "$workdir/readonly"
ln -s "$victim" "$workdir/link"
prepare_context "$workdir"
run_cleanup "$workdir"
[[ ! -e "$workdir" && -e "$victim/canary" ]]
run_cleanup "$workdir"

workdir="$(mktemp -d -- "$runner_temp/cchp-bot.123.2.XXXXXX")"
prepare_context "$workdir"
renamed="$runner_temp/renamed-workdir"
mv -- "$workdir" "$renamed"
run_cleanup "$workdir"
[[ ! -e "$renamed" ]]

workdir="$(mktemp -d -- "$runner_temp/cchp-bot.123.2.XXXXXX")"
prepare_context "$workdir"
rm -rf -- "$workdir"
set +e
run_cleanup "$workdir" >"$fixture/missing.log" 2>&1
status=$?
set -e
[[ "$status" -ne 0 ]]

workdir="$(mktemp -d -- "$runner_temp/cchp-bot.123.2.XXXXXX")"
prepare_context "$workdir"
renamed="$runner_temp/forged-marker-workdir"
mv -- "$workdir" "$renamed"
jq -n --arg identity "$(sha256sum -- "$identity_path" | cut -d' ' -f1)" \
  '{schemaVersion: 1, workdirIdentitySha256: $identity, githubRunId: "123", githubRunAttempt: "2", mac: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}' \
  >"$cleanup_marker"
run_cleanup "$workdir" >"$fixture/forged-marker.log" 2>&1
[[ ! -e "$renamed" ]]

runner_link="$fixture/runner-link"
ln -s "$runner_temp" "$runner_link"
workdir="$(mktemp -d -- "$runner_temp/cchp-bot.123.2.XXXXXX")"
prepare_context "$workdir"
RUNNER_TEMP="$runner_link" run_cleanup "$workdir"
[[ ! -e "$workdir" ]]

failure_bin="$fixture/failure-bin"
mkdir -p -- "$failure_bin"
printf '#!/usr/bin/env bash\nexit 73\n' >"$failure_bin/python3"
chmod +x "$failure_bin/python3"
workdir="$(mktemp -d -- "$runner_temp/cchp-bot.123.2.XXXXXX")"
printf 'keep\n' >"$workdir/canary"
prepare_context "$workdir"
set +e
PATH="$failure_bin:/usr/bin:/bin" run_cleanup "$workdir" >"$fixture/rm-failure.log" 2>&1
status=$?
set -e
[[ "$status" -ne 0 && -e "$workdir/canary" ]]
rm -rf -- "$workdir"

success_bin="$fixture/success-bin"
mkdir -p -- "$success_bin"
printf '#!/usr/bin/env bash\nexit 0\n' >"$success_bin/python3"
chmod +x "$success_bin/python3"
workdir="$(mktemp -d -- "$runner_temp/cchp-bot.123.2.XXXXXX")"
prepare_context "$workdir"
set +e
PATH="$success_bin:/usr/bin:/bin" run_cleanup "$workdir" >"$fixture/residual.log" 2>&1
status=$?
set -e
[[ "$status" -ne 0 && -d "$workdir" ]]
rm -rf -- "$workdir"

expect_rejected() {
  local candidate="$1" canary="$2"
  set +e
  run_cleanup "$candidate" >"$fixture/rejected.log" 2>&1
  local status=$?
  set -e
  [[ "$status" -ne 0 && -e "$canary" ]]
}

workdir="$(mktemp -d -- "$runner_temp/cchp-bot.123.2.XXXXXX")"
prepare_context "$workdir"
printf 'keep\n' >"$runner_temp/canary"
expect_rejected "$runner_temp" "$runner_temp/canary"
rm -rf -- "$workdir"

workdir="$(mktemp -d -- "$runner_temp/cchp-bot.123.2.XXXXXX")"
prepare_context "$workdir"
set +e
run_cleanup relative >"$fixture/relative.log" 2>&1
status=$?
set -e
[[ "$status" -ne 0 ]]
rm -rf -- "$workdir"

symlink_target="$fixture/symlink-target"
symlink_path="$runner_temp/cchp-bot.123.2.SYM123"
mkdir -p -- "$symlink_target"
printf 'keep\n' >"$symlink_target/canary"
ln -s "$symlink_target" "$symlink_path"
workdir="$(mktemp -d -- "$runner_temp/cchp-bot.123.2.XXXXXX")"
prepare_context "$workdir"
expect_rejected "$symlink_path" "$symlink_target/canary"
rm -rf -- "$workdir"

# A live, unrelated group must not become an ownership fallback when the
# authenticated session leader and every member of that session are absent.
(
  source "$repo_root/scripts/process-group.sh"
  ENGINE_DIR="$repo_root"
  CCHP_PROCESS_PID=2147483646
  CCHP_PROCESS_PGID="$(ps -o pgid= -p $$ | tr -d ' ')"
  CCHP_PROCESS_START=missing
  CCHP_PROCESS_SESSION_TOKEN="$session_token"
  status=0
  groups="$(cchp_session_process_groups)" || status=$?
  [[ "$status" == "1" && -z "$groups" ]]
)

if command -v setsid >/dev/null 2>&1; then
  setsid env CCHP_PROCESS_SESSION_TOKEN="$session_token" bash -c 'exec -a codex-app-server sleep 300' &
  identity_pid=$!
  setsid sleep 300 &
  unrelated_pid=$!
  sleep 0.1
  identity_stat="$(<"/proc/${identity_pid}/stat")"
  identity_stat="${identity_stat##*) }"
  read -r -a identity_fields <<<"$identity_stat"
  workdir="$(mktemp -d -- "$runner_temp/cchp-bot.123.2.XXXXXX")"
  prepare_context "$workdir"
  printf 'preserve\n' > "$workdir/canary"
  jq -n \
    --argjson pid "$identity_pid" --arg start "${identity_fields[19]}" --arg boot "$(<"/proc/sys/kernel/random/boot_id")" \
    --arg home "$workdir/codex-home" --arg session "$session_token" \
    '{schemaVersion: 3, pid: $pid, pgid: $pid, startTicks: $start, bootId: $boot, sessionToken: $session, codexHome: $home, runId: "run", githubRunId: "123", githubRunAttempt: "2", mac: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}' \
    >"$process_file"
  set +e
  run_cleanup "$workdir" >"$fixture/forged-consistent-record.log" 2>&1
  status=$?
  set -e
  [[ "$status" -ne 0 && -f "$process_file" && -f "$workdir/canary" ]]
  kill -0 "$identity_pid"
  rm -rf -- "$workdir"

  workdir="$(mktemp -d -- "$runner_temp/cchp-bot.123.2.XXXXXX")"
  prepare_context "$workdir"
  printf 'retry\n' > "$workdir/canary"
  jq -n \
    --argjson pid "$identity_pid" --argjson pgid "$unrelated_pid" \
    --arg start "${identity_fields[19]}" --arg boot "$(<"/proc/sys/kernel/random/boot_id")" \
    --arg home "$workdir/codex-home" --arg session "$session_token" \
    '{schemaVersion: 3, pid: $pid, pgid: $pgid, startTicks: $start, bootId: $boot, sessionToken: $session, codexHome: $home, runId: "run", githubRunId: "123", githubRunAttempt: "2"}' \
    >"$process_file"
  authenticate_file "$process_file"
  set +e
  run_cleanup "$workdir" >"$fixture/pgid-mismatch.log" 2>&1
  status=$?
  set -e
  [[ "$status" -ne 0 && -f "$process_file" && -f "$workdir/canary" ]]
  kill -0 "$identity_pid"
  kill -0 "$unrelated_pid"
  jq --argjson pgid "$identity_pid" '.pgid = $pgid' "$process_file" > "$process_file.retry"
  mv -f -- "$process_file.retry" "$process_file"
  authenticate_file "$process_file"
  run_cleanup "$workdir"
  [[ ! -e "$workdir" && ! -e "$process_file" ]]
  ! process_live "$identity_pid"
  kill -0 "$unrelated_pid"
  kill -KILL "$unrelated_pid" 2>/dev/null || true
  wait "$identity_pid" "$unrelated_pid" 2>/dev/null || true

  session_child_file="$fixture/session-child.pid"
  setsid env CCHP_PROCESS_SESSION_TOKEN="$session_token" bash -c '
    python3 -c "import os, time; os.setpgrp(); time.sleep(30)" &
    printf "%s\n" "$!" > "$1"
    exec -a codex-app-server sleep 30
  ' _ "$session_child_file" &
  session_leader_pid=$!
  while [[ ! -s "$session_child_file" ]]; do sleep 0.01; done
  session_child_pid="$(<"$session_child_file")"
  session_stat="$(<"/proc/${session_leader_pid}/stat")"
  session_stat="${session_stat##*) }"
  read -r -a session_fields <<<"$session_stat"
  workdir="$(mktemp -d -- "$runner_temp/cchp-bot.123.2.XXXXXX")"
  prepare_context "$workdir"
  jq -n \
    --argjson pid "$session_leader_pid" --arg start "${session_fields[19]}" --arg boot "$(<"/proc/sys/kernel/random/boot_id")" \
    --arg home "$workdir/codex-home" --arg session "$session_token" \
    '{schemaVersion: 3, pid: $pid, pgid: $pid, startTicks: $start, bootId: $boot, sessionToken: $session, codexHome: $home, runId: "run", githubRunId: "123", githubRunAttempt: "2"}' \
    >"$process_file"
  authenticate_file "$process_file"
  run_cleanup "$workdir"
  [[ ! -e "$workdir" && ! -e "$process_file" ]]
  ! process_live "$session_leader_pid"
  ! process_live "$session_child_pid"
  wait "$session_leader_pid" 2>/dev/null || true

  workdir="$(mktemp -d -- "$runner_temp/cchp-bot.123.2.XXXXXX")"
  prepare_context "$workdir"
  mkdir -p -- "$workdir/ctx/child-results"
  setsid env BOT_WORKDIR="$workdir" BOT_RUN_ID=run CCHP_EXPLICIT_AGENT_DEPTH=1 \
    bash -c 'exec -a codex-explicit-child sleep 30' &
  explicit_pid=$!
  sleep 0.1
  explicit_stat="$(<"/proc/${explicit_pid}/stat")"
  explicit_stat="${explicit_stat##*) }"
  read -r -a explicit_fields <<<"$explicit_stat"
  jq -n \
    --argjson pid "$explicit_pid" --arg start "${explicit_fields[19]}" --arg boot "$(<"/proc/sys/kernel/random/boot_id")" \
    '{schemaVersion: 5, mode: "explicit_child", kind: "explicit_child_running", runId: "run", parentRunId: "run", childId: "child", pid: $pid, processGroupId: $pid, processIdentity: {pid: $pid, startTicks: $start, bootId: $boot}, launchState: "checkpointed"}' \
    >"$workdir/ctx/child-results/child.running.json"
  authenticate_file "$workdir/ctx/child-results/child.running.json"
  run_cleanup "$workdir"
  wait "$explicit_pid" 2>/dev/null || true
  ! kill -0 "$explicit_pid" 2>/dev/null
  [[ ! -e "$workdir" ]]

  workdir="$(mktemp -d -- "$runner_temp/cchp-bot.123.2.XXXXXX")"
  prepare_context "$workdir"
  mkdir -p -- "$workdir/ctx/child-results"
  setsid sleep 30 &
  foreign_pid=$!
  sleep 0.1
  foreign_stat="$(<"/proc/${foreign_pid}/stat")"
  foreign_stat="${foreign_stat##*) }"
  read -r -a foreign_fields <<<"$foreign_stat"
  jq -n \
    --argjson pid "$foreign_pid" --arg start "${foreign_fields[19]}" --arg boot "$(<"/proc/sys/kernel/random/boot_id")" \
    '{schemaVersion: 5, mode: "explicit_child", kind: "explicit_child_running", runId: "run", parentRunId: "run", childId: "forged", pid: $pid, processGroupId: $pid, processIdentity: {pid: $pid, startTicks: $start, bootId: $boot}, launchState: "checkpointed"}' \
    >"$workdir/ctx/child-results/forged.running.json"
  authenticate_file "$workdir/ctx/child-results/forged.running.json"
  jq '.childId = "tampered"' "$workdir/ctx/child-results/forged.running.json" \
    >"$workdir/ctx/child-results/forged.running.json.tampered"
  mv -f -- "$workdir/ctx/child-results/forged.running.json.tampered" \
    "$workdir/ctx/child-results/forged.running.json"
  set +e
  run_cleanup "$workdir" >"$fixture/forged-explicit-child.log" 2>&1
  status=$?
  set -e
  [[ "$status" -ne 0 && -d "$workdir" ]]
  kill -0 "$foreign_pid"
  kill -KILL "$foreign_pid" 2>/dev/null || true
  wait "$foreign_pid" 2>/dev/null || true
  rm -rf -- "$workdir"

  release="$fixture/release-leader"
  descendant_path="$fixture/leader-descendant.pid"
  setsid env CCHP_PROCESS_SESSION_TOKEN="$session_token" bash -c 'bash -c '\''trap "" INT TERM; while :; do sleep 1; done'\'' & echo $! >"$1"; while [[ ! -e "$2" ]]; do sleep 0.02; done' _ "$descendant_path" "$release" &
  leader_pid=$!
  while [[ ! -s "$descendant_path" ]]; do sleep 0.02; done
  leader_stat="$(<"/proc/${leader_pid}/stat")"
  leader_stat="${leader_stat##*) }"
  read -r -a leader_fields <<<"$leader_stat"
  workdir="$(mktemp -d -- "$runner_temp/cchp-bot.123.2.XXXXXX")"
  prepare_context "$workdir"
  jq -n \
    --argjson pid "$leader_pid" --arg start "${leader_fields[19]}" --arg boot "$(<"/proc/sys/kernel/random/boot_id")" \
    --arg home "$workdir/codex-home" --arg session "$session_token" \
    '{schemaVersion: 3, pid: $pid, pgid: $pid, startTicks: $start, bootId: $boot, sessionToken: $session, codexHome: $home, runId: "run", githubRunId: "123", githubRunAttempt: "2"}' \
    >"$process_file"
  authenticate_file "$process_file"
  touch "$release"
  wait "$leader_pid"
  descendant_pid="$(<"$descendant_path")"
  run_cleanup "$workdir"
  for _ in {1..100}; do process_live "$descendant_pid" || break; sleep 0.05; done
  ! process_live "$descendant_pid"
  [[ ! -e "$process_file" ]]
fi

secure_record="$runner_temp/secure-record.json"
secure_original="$runner_temp/secure-record.original.json"
secure_pause="$fixture/secure-unlink.pause"
secure_resume="$fixture/secure-unlink.resume"
jq -n '{schemaVersion: 2, runId: "original"}' > "$secure_record"
authenticate_file "$secure_record"
secure_mac="$(jq -er '.mac' "$secure_record")"
set +e
CCHP_RECORD_HMAC_KEY="$record_key" \
CCHP_SECURE_UNLINK_TESTING=1 \
CCHP_SECURE_UNLINK_TEST_PAUSE="$secure_pause" \
CCHP_SECURE_UNLINK_TEST_RESUME="$secure_resume" \
GITHUB_ACTIONS=false \
  python3 "$repo_root/scripts/secure-unlink.py" --path "$secure_record" --expected-mac "$secure_mac" \
  > "$fixture/secure-unlink.log" 2>&1 &
secure_unlink_pid=$!
set -e
for _ in {1..100}; do [[ -e "$secure_pause" ]] && break; sleep 0.01; done
[[ -e "$secure_pause" ]]
mv -- "$secure_record" "$secure_original"
jq -n '{schemaVersion: 2, runId: "replacement"}' > "$secure_record"
authenticate_file "$secure_record"
replacement_bytes="$(<"$secure_record")"
touch "$secure_resume"
set +e
wait "$secure_unlink_pid"
secure_unlink_status=$?
set -e
[[ "$secure_unlink_status" -ne 0 ]]
[[ -f "$secure_record" && "$(<"$secure_record")" == "$replacement_bytes" ]]
[[ -f "$secure_original" ]]

printf '[cleanup-test] passed\n'
