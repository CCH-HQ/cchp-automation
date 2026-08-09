#!/usr/bin/env python3
import argparse
import ctypes
import hashlib
import hmac
import json
import os
import stat
import sys
import time
import uuid


AT_FDCWD = -100
RENAME_NOREPLACE = 1


def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def record_mac(value: dict[str, object], key: str) -> str:
    payload = {name: entry for name, entry in value.items() if name != "mac"}
    return hmac.new(bytes.fromhex(key), canonical(payload).encode(), hashlib.sha256).hexdigest()


def open_parent(path: str) -> tuple[int, str, list[int]]:
    absolute = os.path.abspath(path)
    parts = [part for part in absolute.split("/") if part]
    if not parts:
        raise RuntimeError("path must name a file")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    opened = [os.open("/", flags)]
    try:
        parent = opened[0]
        for part in parts[:-1]:
            parent = os.open(part, flags, dir_fd=parent)
            opened.append(parent)
        return parent, parts[-1], opened
    except Exception:
        for descriptor in reversed(opened):
            os.close(descriptor)
        raise


def rename_noreplace(parent_fd: int, source: str, target: str) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = libc.renameat2
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    if renameat2(parent_fd, source.encode(), parent_fd, target.encode(), RENAME_NOREPLACE) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), target)


def test_pause() -> None:
    pause = os.environ.get("CCHP_SECURE_UNLINK_TEST_PAUSE")
    resume = os.environ.get("CCHP_SECURE_UNLINK_TEST_RESUME")
    if not pause and not resume:
        return
    if os.environ.get("CCHP_SECURE_UNLINK_TESTING") != "1" or os.environ.get("GITHUB_ACTIONS") == "true" or not pause or not resume:
        raise RuntimeError("secure unlink test hook is disabled")
    with open(pause, "x", encoding="utf-8") as marker:
        marker.write("opened\n")
    deadline = time.monotonic() + 5
    while not os.path.exists(resume):
        if time.monotonic() >= deadline:
            raise RuntimeError("secure unlink test hook timed out")
        time.sleep(0.01)


def secure_unlink(path: str, expected_mac: str, key: str) -> None:
    if not os.path.isabs(path):
        raise RuntimeError("path must be absolute")
    if len(expected_mac) != 64 or any(character not in "0123456789abcdef" for character in expected_mac):
        raise RuntimeError("expected MAC is invalid")
    if len(key) != 64 or any(character not in "0123456789abcdef" for character in key):
        raise RuntimeError("HMAC key is invalid")
    parent_fd, name, opened = open_parent(path)
    descriptor = -1
    quarantine = f".{name}.cchp-remove-{uuid.uuid4().hex}"
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
        identity = os.fstat(descriptor)
        if not stat.S_ISREG(identity.st_mode) or identity.st_nlink != 1:
            raise RuntimeError("authenticated record must be a single-link regular file")
        with os.fdopen(os.dup(descriptor), "rb") as source:
            raw = source.read()
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise RuntimeError("authenticated record must be an object")
        actual_mac = value.get("mac")
        if actual_mac != expected_mac or not hmac.compare_digest(record_mac(value, key), expected_mac):
            raise RuntimeError("authenticated record MAC mismatch")
        test_pause()
        os.rename(name, quarantine, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        moved = os.stat(quarantine, dir_fd=parent_fd, follow_symlinks=False)
        if moved.st_dev != identity.st_dev or moved.st_ino != identity.st_ino:
            try:
                rename_noreplace(parent_fd, quarantine, name)
            except OSError:
                pass
            raise RuntimeError("directory entry changed after authenticated snapshot")
        os.unlink(quarantine, dir_fd=parent_fd)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        for parent in reversed(opened):
            os.close(parent)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", required=True)
    parser.add_argument("--expected-mac", required=True)
    arguments = parser.parse_args()
    secure_unlink(arguments.path, arguments.expected_mac, os.environ.get("CCHP_RECORD_HMAC_KEY", ""))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"secure-unlink: {error}", file=sys.stderr)
        raise SystemExit(2)
