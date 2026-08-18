#!/usr/bin/env python3
import argparse
import errno
import json
import os
import signal
import sys


def read_stat(pid: int):
    try:
        with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as handle:
            value = handle.read()
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ESRCH):
            return None
        raise RuntimeError(f"cannot read /proc/{pid}/stat: {error}") from error
    suffix = value[value.rfind(")") + 2:].split()
    if len(suffix) < 20:
        raise RuntimeError(f"invalid /proc/{pid}/stat")
    return {
        "state": suffix[0],
        "process_group": int(suffix[2]),
        "session": int(suffix[3]),
        "start_ticks": suffix[19],
    }


def session_members(session_id: int):
    members = []
    try:
        entries = os.listdir("/proc")
    except OSError as error:
        raise RuntimeError(f"cannot enumerate /proc: {error}") from error
    for entry in entries:
        if not entry.isdigit() or entry == "0":
            continue
        pid = int(entry)
        stat = read_stat(pid)
        if not stat or stat["state"] == "Z" or stat["session"] != session_id:
            continue
        members.append((pid, stat["start_ticks"]))
    return members


UNREADABLE_ENVIRONMENT = object()


def read_environment(pid: int):
    try:
        with open(f"/proc/{pid}/environ", "rb") as handle:
            return set(handle.read().split(b"\0"))
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ESRCH):
            return None
        if error.errno in (errno.EACCES, errno.EPERM):
            return UNREADABLE_ENVIRONMENT
        raise RuntimeError(f"cannot read /proc/{pid}/environ: {error}") from error


def bound_pidfds(session_id: int, required_environment: set[bytes]):
    held = []
    unbound = 0
    for pid, expected_start in session_members(session_id):
        try:
            pidfd = os.pidfd_open(pid)
        except OSError as error:
            if error.errno in (errno.ESRCH, errno.EINVAL) and read_stat(pid) is None:
                continue
            raise RuntimeError(f"pidfd_open failed for {pid}: {error}") from error
        try:
            current = read_stat(pid)
            if (
                not current
                or current["state"] == "Z"
                or current["session"] != session_id
                or current["start_ticks"] != expected_start
            ):
                os.close(pidfd)
                continue
            environment = read_environment(pid)
            if environment is None:
                os.close(pidfd)
                continue
            if environment is UNREADABLE_ENVIRONMENT:
                unbound += 1
                os.close(pidfd)
                continue
            bound = required_environment.issubset(environment)
            if not bound:
                unbound += 1
            held.append((pid, pidfd, bound))
        except Exception:
            os.close(pidfd)
            raise
    return held, unbound


def resolve_signal(value: str):
    name = value.upper()
    if not name.startswith("SIG"):
        name = f"SIG{name}"
    candidate = getattr(signal, name, None)
    if not isinstance(candidate, signal.Signals):
        raise ValueError(f"unsupported signal: {value}")
    return candidate


def emit(status: str, members: int, detail: str = ""):
    payload = {"status": status, "members": members}
    if detail:
        payload["detail"] = detail
    print(json.dumps(payload, sort_keys=True))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", required=True, type=int)
    parser.add_argument("--leader-pid", required=True, type=int)
    parser.add_argument("--expected-start", required=True)
    parser.add_argument("--signal")
    parser.add_argument("--require-env", action="append", default=[])
    args = parser.parse_args()

    if args.session < 1 or args.leader_pid < 1:
        raise ValueError("session and leader pid must be positive")
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        emit("unproven", 0, "pidfd APIs are unavailable")
        return 2
    requested_signal = resolve_signal(args.signal) if args.signal else None
    required_environment = {value.encode("utf-8") for value in args.require_env}
    if not required_environment:
        emit("unproven", 0, "at least one environment binding is required")
        return 2

    leader_pidfd = None
    try:
        try:
            leader_pidfd = os.pidfd_open(args.leader_pid)
        except OSError as error:
            if error.errno in (errno.ESRCH, errno.EINVAL) and read_stat(args.leader_pid) is None:
                leader_pidfd = None
            else:
                emit("unproven", 0, f"pidfd_open failed for leader {args.leader_pid}: {error}")
                return 2
        leader = read_stat(args.leader_pid)
        if leader and (leader["start_ticks"] != args.expected_start or leader["session"] != args.session):
            emit("unproven", 0, "leader identity drifted")
            return 2
        leader_anchored = leader_pidfd is not None and leader is not None

        held, unbound = bound_pidfds(args.session, required_environment)
        if unbound and not leader_anchored:
            for _, pidfd, _ in held:
                os.close(pidfd)
            emit("unproven", 0, "live session members do not match the authenticated run binding")
            return 2
        if not held:
            if session_members(args.session):
                emit("unproven", 0, "session membership changed before identity binding")
                return 2
            emit("absent", 0)
            return 1

        try:
            if requested_signal is None:
                emit("present", len(held))
                return 0

            delivered = 0
            for pid, pidfd, _ in held:
                try:
                    signal.pidfd_send_signal(pidfd, requested_signal)
                    delivered += 1
                except ProcessLookupError:
                    continue
                except OSError as error:
                    emit("unproven", delivered, f"pidfd_send_signal failed for {pid}: {error}")
                    return 2
        finally:
            for _, pidfd, _ in held:
                os.close(pidfd)
        if delivered == 0:
            emit("unproven", 0, "all bound session members disappeared before signal delivery")
            return 2
        emit("signaled", delivered)
        return 0
    finally:
        if leader_pidfd is not None:
            os.close(leader_pidfd)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, ValueError) as error:
        emit("unproven", 0, str(error))
        sys.exit(2)
