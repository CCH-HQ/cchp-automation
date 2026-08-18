#!/usr/bin/env python3
import errno
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch


HELPER = Path(__file__).with_name("process-session-signal.py")
SPEC = importlib.util.spec_from_file_location("process_session_signal", HELPER)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load process-session-signal.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ProcessSessionSignalTest(unittest.TestCase):
    def test_session_scan_propagates_unreadable_stat(self):
        with (
            patch.object(MODULE.os, "listdir", return_value=["123"]),
            patch.object(MODULE, "read_stat", side_effect=RuntimeError("simulated EACCES")),
        ):
            with self.assertRaisesRegex(RuntimeError, "simulated EACCES"):
                MODULE.session_members(123)

    def test_bound_pidfds_rejects_unbound_session_member(self):
        current = {"state": "S", "session": 123, "start_ticks": "45"}
        with (
            patch.object(MODULE, "session_members", return_value=[(123, "45")]),
            patch.object(MODULE.os, "pidfd_open", return_value=9),
            patch.object(MODULE, "read_stat", return_value=current),
            patch.object(MODULE, "read_environment", return_value={b"OTHER=value"}),
            patch.object(MODULE.os, "close") as close,
        ):
            held, unbound = MODULE.bound_pidfds(123, {b"RUN=expected"})
        self.assertEqual(held, [(123, 9, False)])
        self.assertEqual(unbound, 1)
        close.assert_not_called()

    def test_bound_pidfds_retains_matching_member_identity(self):
        current = {"state": "S", "session": 123, "start_ticks": "45"}
        with (
            patch.object(MODULE, "session_members", return_value=[(123, "45")]),
            patch.object(MODULE.os, "pidfd_open", return_value=9),
            patch.object(MODULE, "read_stat", return_value=current),
            patch.object(MODULE, "read_environment", return_value={b"RUN=expected"}),
        ):
            held, unbound = MODULE.bound_pidfds(123, {b"RUN=expected"})
        self.assertEqual(held, [(123, 9, True)])
        self.assertEqual(unbound, 0)

    def test_mixed_bound_and_unbound_members_are_reported(self):
        snapshots = {
            123: {"state": "S", "session": 123, "start_ticks": "45"},
            124: {"state": "S", "session": 123, "start_ticks": "46"},
        }
        environments = {123: {b"RUN=expected"}, 124: {b"OTHER=value"}}
        with (
            patch.object(MODULE, "session_members", return_value=[(123, "45"), (124, "46")]),
            patch.object(MODULE.os, "pidfd_open", side_effect=[9, 10]),
            patch.object(MODULE, "read_stat", side_effect=lambda pid: snapshots[pid]),
            patch.object(MODULE, "read_environment", side_effect=lambda pid: environments[pid]),
            patch.object(MODULE.os, "close") as close,
        ):
            held, unbound = MODULE.bound_pidfds(123, {b"RUN=expected"})
        self.assertEqual(held, [(123, 9, True), (124, 10, False)])
        self.assertEqual(unbound, 1)
        close.assert_not_called()

    def test_bound_pidfds_counts_unreadable_environ_as_unbound(self):
        current = {"state": "S", "session": 123, "start_ticks": "45"}
        with (
            patch.object(MODULE, "session_members", return_value=[(123, "45")]),
            patch.object(MODULE.os, "pidfd_open", return_value=9),
            patch.object(MODULE, "read_stat", return_value=current),
            patch.object(MODULE, "read_environment", return_value=MODULE.UNREADABLE_ENVIRONMENT),
            patch.object(MODULE.os, "close") as close,
        ):
            held, unbound = MODULE.bound_pidfds(123, {b"RUN=expected"})
        self.assertEqual(held, [])
        self.assertEqual(unbound, 1)
        close.assert_called_once_with(9)

    def test_read_environment_treats_eacces_as_unreadable(self):
        failure = OSError(errno.EACCES, "simulated dumpable process")
        with patch("builtins.open", side_effect=failure):
            self.assertIs(MODULE.read_environment(123), MODULE.UNREADABLE_ENVIRONMENT)

    def test_pidfd_einval_is_absent_only_when_proc_identity_disappeared(self):
        failure = OSError(errno.EINVAL, "simulated reaped process")
        with (
            patch.object(MODULE, "session_members", return_value=[(123, "45")]),
            patch.object(MODULE.os, "pidfd_open", side_effect=failure),
            patch.object(MODULE, "read_stat", return_value=None),
        ):
            self.assertEqual(MODULE.bound_pidfds(123, {b"RUN=expected"}), ([], 0))

    def test_pidfd_einval_with_live_proc_identity_fails_closed(self):
        failure = OSError(errno.EINVAL, "simulated live process")
        current = {"state": "S", "session": 123, "start_ticks": "45"}
        with (
            patch.object(MODULE, "session_members", return_value=[(123, "45")]),
            patch.object(MODULE.os, "pidfd_open", side_effect=failure),
            patch.object(MODULE, "read_stat", return_value=current),
        ):
            with self.assertRaisesRegex(RuntimeError, "pidfd_open failed"):
                MODULE.bound_pidfds(123, {b"RUN=expected"})


if __name__ == "__main__":
    unittest.main()
