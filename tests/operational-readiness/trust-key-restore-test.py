#!/usr/bin/env python3
"""Deterministic recovery-harness regressions; no Docker daemon is required.

Execute the real Bash function definitions and negative-key block from v2.
The Docker process boundary is a test double; its inner timeout uses BusyBox
when installed and otherwise the host timeout. These are NOT Swarm acceptance.
"""
from __future__ import annotations

import base64
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "trust-key-restore-v2.sh"

# Only synthetic data. A canonical final U exercises ignored base64 pad bits.
KEY = "SWMKEY-1-" + base64.b64encode(bytes(range(31)) + b"\x05").decode().rstrip("=")

# Error strings match Moby v28.0.4 daemon/cluster/errors.go, not invented messages.
FAKE_DOCKER = r'''
import json
import os
from pathlib import Path
import sys
import time

args = sys.argv[1:]
root = Path(os.environ["FAKE_ROOT"])
with (root / "calls.jsonl").open("a") as f:
    f.write(json.dumps(args) + "\n")
if args[0] == "exec":
    args = args[1:]
    if args[0] == "-i":
        args = args[1:]
    args = args[1:]  # test container name
    if args[0] == "timeout":
        if Path(os.environ["TEST_TIMEOUT"]).name == "busybox":
            os.execv(os.environ["TEST_TIMEOUT"], ["busybox", *args])
        os.execv(os.environ["TEST_TIMEOUT"], [os.environ["TEST_TIMEOUT"], *args[1:]])
    assert args[0] == "docker", args
    os.execv(sys.argv[0], [sys.argv[0], *args[1:]])

mode = os.environ.get("FAKE_MODE", "invalid-key")
if args[0] == "info":
    if mode == "info-error":
        print("Cannot connect to Docker daemon", file=sys.stderr)
        sys.exit(1)
    print("active" if mode == "active" or (root / "unlocked").exists() else "locked")
    sys.exit(0)
if args[:2] == ["node", "ls"]:
    errors = {"read-timeout": 124, "read-killed": 137, "read-missing": 127,
              "read-error": 1, "read-wrong-status": 2}
    if mode == "read-success":
        print("unexpected-node")
        sys.exit(0)
    if mode in errors:
        print("Cannot connect to Docker daemon" if mode == "read-error" else
              "Swarm is encrypted and needs to be unlocked", file=sys.stderr)
        sys.exit(errors[mode])
    print('Swarm is encrypted and needs to be unlocked before it can be used.', file=sys.stderr)
    sys.exit(1)
if args[:2] == ["swarm", "unlock"]:
    key = sys.stdin.read()
    (root / "received-key").write_text(key)
    if mode == "unlock-hang":
        (root / "inner.pid").write_text(str(os.getpid()))
        time.sleep(60)
        sys.exit(0)
    errors = {"unlock-timeout": 124, "unlock-killed": 137, "unlock-missing": 127,
              "unlock-error": 1, "unlock-wrong-status": 2}
    if mode in errors:
        print("Cannot connect to Docker daemon" if mode == "unlock-error" else
              "swarm could not be unlocked: invalid key provided", file=sys.stderr)
        sys.exit(errors[mode])
    if mode == "unlock-success":
        (root / "unlocked").touch()
        sys.exit(0)
    if mode == "invalid-but-unlocked":
        (root / "unlocked").touch()
    print("Error response from daemon: swarm could not be unlocked: invalid key provided", file=sys.stderr)
    sys.exit(1)
print("unexpected fake Docker call", args, file=sys.stderr)
sys.exit(90)
'''


class RecoveryHarnessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="docklane-recovery-regression-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.log = self.root / "evidence"
        self.log.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.source = SOURCE.read_text()
        boundary = "\nfor name in "
        self.assertEqual(self.source.count(boundary), 1)
        self.functions = self.root / "functions.sh"
        self.functions.write_text(self.source.split(boundary, 1)[0])
        docker = self.bin / "docker"
        docker.write_text(f"#!{sys.executable} -S\n" + FAKE_DOCKER)
        docker.chmod(0o755)
        self.timeout = shutil.which("busybox") or shutil.which("timeout")
        self.assertIsNotNone(self.timeout, "A timeout executable is required")

    def run_bash(self, body: str, mode: str = "invalid-key", limit: float = 4) -> subprocess.CompletedProcess:
        env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}",
                   DOCKLANE_OR_LOG_DIR=str(self.log), FAKE_ROOT=str(self.root),
                   TEST_TIMEOUT=str(self.timeout), FAKE_MODE=mode,
                   DOCKLANE_OR_RECOVERY_CALL_TIMEOUT_SECONDS="1", TEST_KEY=KEY)
        command = f"source {shlex.quote(str(self.functions))}\n{body}\n"
        process = subprocess.Popen(["bash", "-c", command], env=env,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, start_new_session=True)
        try:
            stdout, stderr = process.communicate(timeout=limit)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
            self.fail("real harness function exceeded its bounded execution budget")
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        return subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)

    def negative_block(self) -> str:
        # Test the actual executable block, not a separately reimplemented check.
        start = self.source.index('\nBAD_KEY=')
        end = self.source.index('\noffline_restore_quorum "$RID"', start)
        return 'KEY1="$TEST_KEY"\n' + self.source[start:end]

    def test_bad_key_changes_decoded_bytes(self) -> None:
        assignment = re.search(r'^BAD_KEY=.*\n(?:if \[\[.*\n)?', self.source, re.MULTILINE)
        self.assertIsNotNone(assignment)
        result = self.run_bash('KEY1="$TEST_KEY"\n' + assignment.group(0) + '\nprintf "%s" "$BAD_KEY"')
        self.assertEqual(result.returncode, 0, result.stderr)
        original = base64.b64decode(KEY.removeprefix("SWMKEY-1-") + "=")
        changed = base64.b64decode(result.stdout.removeprefix("SWMKEY-1-") + "=", validate=True)
        self.assertEqual(len(changed), 32)
        self.assertNotEqual(original, changed, "different text is not necessarily a different unlock key")

    def test_locked_state_requires_docker_evidence(self) -> None:
        for mode in ("active", "info-error", "read-timeout", "read-killed", "read-missing", "read-error", "read-success", "read-wrong-status"):
            with self.subTest(mode=mode):
                result = self.run_bash('assert_locked "$RESTORE" locked-check', mode)
                self.assertNotEqual(result.returncode, 0, f"{mode} was incorrectly accepted as locked")

    def test_confirmed_locked_state_is_accepted(self) -> None:
        result = self.run_bash('assert_locked "$RESTORE" locked-check')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_invalid_key_check_rejects_unrelated_failures(self) -> None:
        for mode in ("unlock-timeout", "unlock-killed", "unlock-missing", "unlock-error", "unlock-wrong-status", "unlock-success", "invalid-but-unlocked"):
            with self.subTest(mode=mode):
                (self.root / "unlocked").unlink(missing_ok=True)
                result = self.run_bash(self.negative_block(), mode)
                self.assertNotEqual(result.returncode, 0, f"{mode} was incorrectly accepted as invalid-key rejection")

    def test_confirmed_invalid_key_is_accepted_and_remains_locked(self) -> None:
        result = self.run_bash(self.negative_block())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / "unlocked").exists())

    def test_unlock_hang_is_bounded_without_continuation(self) -> None:
        before = time.monotonic()
        result = self.run_bash('unlock "$RESTORE" "$TEST_KEY" restore-unlock\necho MUST-NOT-CONTINUE', "unlock-hang")
        self.assertLess(time.monotonic() - before, 4)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("MUST-NOT-CONTINUE", result.stdout)
        self.assertIn("restore-unlock", result.stderr)
        status = (self.log / "restore-unlock-status.txt").read_text()
        self.assertIn("status=failed", status)
        calls = (self.root / "calls.jsonl").read_text()
        self.assertNotIn("force-new-cluster", calls)
        self.assertEqual(calls.count('["swarm", "unlock"]'), 1)
        self.assertIn('["exec", "-i",', calls)
        self.assertIn('"timeout", "-s", "KILL", "1", "docker"', calls)

    def test_valid_unlock_records_phase_without_key_leak(self) -> None:
        result = self.run_bash('unlock "$RESTORE" "$TEST_KEY" source-unlock', "unlock-success")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "received-key").read_text(), KEY + "\n")
        self.assertTrue((self.log / "source-unlock-status.txt").exists(), "unlock phase evidence is missing")
        self.assertIn("status=completed", (self.log / "source-unlock-status.txt").read_text())
        for output in (result.stdout, result.stderr, (self.root / "calls.jsonl").read_text()):
            self.assertNotIn(KEY, output)
        for file in self.log.iterdir():
            self.assertNotIn(KEY, file.read_text())

    def test_all_nested_docker_cli_calls_use_bounded_wrapper(self) -> None:
        naked = [line for line in self.source.splitlines()
                 if re.search(r'docker exec .*\bdocker (version|info|node|swarm)\b', line)]
        self.assertEqual(naked, [], "unbounded inner Docker CLI remains")


if __name__ == "__main__":
    unittest.main(verbosity=2)
