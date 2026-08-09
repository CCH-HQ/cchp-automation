#!/usr/bin/env python3
import argparse
import errno
import os
import stat
import sys


def same_inode(value: os.stat_result, device: int, inode: int) -> bool:
    return value.st_dev == device and value.st_ino == inode


def locate_inode(parent_fd: int, device: int, inode: int) -> str:
    matches: list[str] = []
    for name in os.listdir(parent_fd):
        try:
            value = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            continue
        if same_inode(value, device, inode):
            matches.append(name)
    if len(matches) != 1:
        raise RuntimeError("verified directory identity disappeared or became ambiguous")
    return matches[0]


def remove_directory(parent_fd: int, name: str, expected_device: int, expected_inode: int) -> None:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptor = os.open(name, flags, dir_fd=parent_fd)
    try:
        identity = os.fstat(descriptor)
        if not stat.S_ISDIR(identity.st_mode) or not same_inode(identity, expected_device, expected_inode):
            raise RuntimeError("directory identity changed before fd-bound removal")
        os.fchmod(descriptor, 0o700)
        for child in os.listdir(descriptor):
            try:
                child_stat = os.stat(child, dir_fd=descriptor, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if stat.S_ISDIR(child_stat.st_mode):
                try:
                    remove_directory(descriptor, child, child_stat.st_dev, child_stat.st_ino)
                except OSError as error:
                    if error.errno not in (errno.ENOTDIR, errno.ELOOP, errno.ENOENT):
                        raise
                    try:
                        os.unlink(child, dir_fd=descriptor)
                    except FileNotFoundError:
                        pass
            else:
                try:
                    os.unlink(child, dir_fd=descriptor)
                except FileNotFoundError:
                    pass
        current_name = locate_inode(parent_fd, expected_device, expected_inode)
        os.rmdir(current_name, dir_fd=parent_fd)
    finally:
        os.close(descriptor)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", required=True)
    parser.add_argument("--runner-root", required=True)
    parser.add_argument("--device", required=True, type=int)
    parser.add_argument("--inode", required=True, type=int)
    arguments = parser.parse_args()

    runner_root = os.path.realpath(arguments.runner_root)
    target = os.path.abspath(arguments.path)
    if os.path.dirname(target) != runner_root:
        raise RuntimeError("cleanup target must be a direct child of RUNNER_TEMP")
    parent_fd = os.open(runner_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        remove_directory(parent_fd, os.path.basename(target), arguments.device, arguments.inode)
    finally:
        os.close(parent_fd)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"secure-remove-tree: {error}", file=sys.stderr)
        raise SystemExit(2)
