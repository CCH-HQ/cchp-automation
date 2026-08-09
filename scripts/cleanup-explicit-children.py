#!/usr/bin/env python3
"""Stop detached explicit Codex child groups before deleting their run evidence."""

from __future__ import annotations

import argparse
import errno
import hashlib
import hmac
import json
import os
import signal
import stat
import sys
import time
from pathlib import Path


MAX_ARTIFACT_BYTES = 1_048_576


class CleanupError(RuntimeError):
    pass


def canonical(value: object) -> str:
    if value is None or isinstance(value, (bool, int, float, str)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(canonical(entry) for entry in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            json.dumps(str(key), ensure_ascii=False, separators=(",", ":")) + ":" + canonical(entry)
            for key, entry in sorted(value.items())
        ) + "}"
    raise CleanupError("explicit child artifact contains an unsupported value")


def validate_hmac_key() -> str:
    key = os.environ.get("CCHP_PROCESS_RECORD_HMAC_KEY", "")
    if len(key) != 64 or any(character not in "0123456789abcdef" for character in key):
        raise CleanupError("explicit child cleanup requires a valid process record HMAC key")
    return key


def has_valid_mac(artifact: dict[str, object], key: str) -> bool:
    mac = artifact.get("mac")
    if not isinstance(mac, str) or len(mac) != 64 or any(character not in "0123456789abcdef" for character in mac):
        return False
    payload = {name: value for name, value in artifact.items() if name != "mac"}
    expected = hmac.new(bytes.fromhex(key), canonical(payload).encode("utf-8"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(mac, expected)


def process_snapshot(pid: int) -> tuple[str, str, str] | None:
    try:
        value = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ESRCH):
            return None
        raise CleanupError(f"cannot inspect process {pid}: {error}") from error
    suffix = value[value.rfind(")") + 2 :].split()
    if len(suffix) < 20:
        raise CleanupError(f"process {pid} has an invalid stat record")
    return suffix[0], suffix[2], suffix[19]


def process_environment(pid: int) -> set[bytes]:
    try:
        return set(Path(f"/proc/{pid}/environ").read_bytes().split(b"\0"))
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ESRCH):
            return set()
        raise CleanupError(f"cannot inspect process {pid} environment: {error}") from error


def process_group_members(pgid: int) -> list[tuple[int, str, str]]:
    members: list[tuple[int, str, str]] = []
    for entry in os.scandir("/proc"):
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        snapshot = process_snapshot(pid)
        if snapshot is None:
            continue
        state, process_group, start_ticks = snapshot
        if process_group == str(pgid):
            members.append((pid, state, start_ticks))
    return members


def group_has_live_work(pgid: int) -> bool:
    return any(state != "Z" for _, state, _ in process_group_members(pgid))


def has_run_binding(pid: int, workdir: str, run_id: str) -> bool:
    environment = process_environment(pid)
    return {
        f"BOT_WORKDIR={workdir}".encode(),
        f"BOT_RUN_ID={run_id}".encode(),
        b"CCHP_EXPLICIT_AGENT_DEPTH=1",
    }.issubset(environment)


def assert_group_binding(pgid: int, workdir: str, run_id: str) -> None:
    members = [(pid, state) for pid, state, _ in process_group_members(pgid) if state != "Z"]
    if not members:
        return
    if not any(has_run_binding(pid, workdir, run_id) for pid, _ in members):
        raise CleanupError(f"process group {pgid} is not bound to this explicit child run")


def signal_group(pgid: int, sig: signal.Signals, workdir: str, run_id: str) -> None:
    if not group_has_live_work(pgid):
        return
    assert_group_binding(pgid, workdir, run_id)
    try:
        os.killpg(pgid, sig)
    except ProcessLookupError:
        return
    except OSError as error:
        raise CleanupError(f"cannot signal process group {pgid}: {error}") from error


def wait_group(pgid: int, iterations: int, delay: float) -> bool:
    for _ in range(iterations):
        if not group_has_live_work(pgid):
            return True
        time.sleep(delay)
    return not group_has_live_work(pgid)


def stop_group(pgid: int, workdir: str, run_id: str) -> None:
    for sig, iterations in ((signal.SIGINT, 100), (signal.SIGTERM, 100), (signal.SIGKILL, 200)):
        signal_group(pgid, sig, workdir, run_id)
        if wait_group(pgid, iterations, 0.05):
            return
    raise CleanupError(f"explicit child process group {pgid} did not stop after SIGKILL")


def read_artifact(directory_fd: int, name: str) -> dict[str, object]:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(name, flags, dir_fd=directory_fd)
    except OSError as error:
        raise CleanupError(f"cannot safely open explicit child artifact {name}: {error}") from error
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_uid != os.geteuid():
            raise CleanupError(f"explicit child artifact {name} is not an owned single-link regular file")
        chunks: list[bytes] = []
        size = 0
        while True:
            chunk = os.read(fd, 65_536)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_ARTIFACT_BYTES:
                raise CleanupError(f"explicit child artifact {name} exceeds the size limit")
            chunks.append(chunk)
        value = json.loads(b"".join(chunks))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CleanupError(f"explicit child artifact {name} is invalid: {error}") from error
    finally:
        os.close(fd)
    if not isinstance(value, dict):
        raise CleanupError(f"explicit child artifact {name} must be an object")
    return value


def checkpointed_group(artifact: dict[str, object], name: str, run_id: str, boot_id: str, hmac_key: str) -> int | None:
    if (
        artifact.get("schemaVersion") != 5
        or artifact.get("mode") != "explicit_child"
        or artifact.get("kind") != "explicit_child_running"
        or artifact.get("runId") != run_id
        or artifact.get("parentRunId") != run_id
    ):
        raise CleanupError(f"explicit child artifact {name} has invalid run identity")
    if not has_valid_mac(artifact, hmac_key):
        raise CleanupError(f"explicit child artifact {name} has an invalid mac")
    launch_state = artifact.get("launchState")
    identity = artifact.get("processIdentity")
    if launch_state in ("idle", "prepared") and identity is None:
        return None
    if launch_state != "checkpointed" or not isinstance(identity, dict):
        raise CleanupError(f"explicit child artifact {name} has invalid launch ownership")
    pid = identity.get("pid")
    pgid = artifact.get("processGroupId")
    start_ticks = identity.get("startTicks")
    recorded_boot = identity.get("bootId")
    if (
        not isinstance(pid, int)
        or isinstance(pid, bool)
        or pid < 1
        or pgid != pid
        or artifact.get("pid") != pid
        or not isinstance(start_ticks, str)
        or not start_ticks
        or not isinstance(recorded_boot, str)
        or not recorded_boot
    ):
        raise CleanupError(f"explicit child artifact {name} has invalid process identity")
    if recorded_boot != boot_id:
        return None
    snapshot = process_snapshot(pid)
    if snapshot is not None and snapshot[0] != "Z":
        _, current_pgid, current_start = snapshot
        if current_pgid != str(pgid) or current_start != start_ticks:
            raise CleanupError(f"explicit child artifact {name} process identity drifted")
    return pgid


def cleanup(workdir: str, expected_workdir: str, run_id: str) -> int:
    result_root = os.path.join(workdir, "ctx", "child-results")
    if not os.path.exists(result_root):
        return 0
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        directory_fd = os.open(result_root, flags)
    except OSError as error:
        raise CleanupError(f"cannot safely open explicit child result directory: {error}") from error
    try:
        metadata = os.fstat(directory_fd)
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.geteuid():
            raise CleanupError("explicit child result directory is not an owned directory")
        names = sorted(name for name in os.listdir(directory_fd) if name.endswith(".running.json"))
        hmac_key = validate_hmac_key() if names else ""
        boot_id = Path("/proc/sys/kernel/random/boot_id").read_text(encoding="utf-8").strip()
        groups: set[int] = set()
        for name in names:
            artifact = read_artifact(directory_fd, name)
            pgid = checkpointed_group(artifact, name, run_id, boot_id, hmac_key)
            if pgid is not None:
                groups.add(pgid)
        for pgid in sorted(groups):
            assert_group_binding(pgid, expected_workdir, run_id)
            stop_group(pgid, expected_workdir, run_id)
        return len(groups)
    finally:
        os.close(directory_fd)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workdir", required=True)
    parser.add_argument("--expected-workdir", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    if not os.path.isabs(args.workdir) or not os.path.isabs(args.expected_workdir) or not args.run_id:
        raise CleanupError("workdir bindings must be absolute and run id must be non-empty")
    stopped = cleanup(os.path.realpath(args.workdir), args.expected_workdir, args.run_id)
    print(f"[cleanup-explicit-children] verified {stopped} detached process group(s)")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CleanupError as error:
        print(f"[cleanup-explicit-children] {error}", file=sys.stderr)
        raise SystemExit(2)
