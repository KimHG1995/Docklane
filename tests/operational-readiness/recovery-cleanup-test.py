#!/usr/bin/env python3
"""Execute the real recovery cleanups with a deterministic Docker process double."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
CASES = (
    ("db-restore-cleanup.sh", "ownership-db-restore", "docklane-or-db-source.container-id", "container"),
    ("swarm-backup-restore-cleanup.sh", "ownership", "manager-01.container-id", "container"),
    ("swarm-backup-restore-cleanup.sh", "ownership", "manager-network.network-id", "network"),
    ("trust-key-restore-cleanup.sh", "ownership-trust-key", "docklane-or-trust-restore.container-id", "container"),
    ("trust-key-restore-cleanup.sh", "ownership-trust-key", "manager-network.network-id", "network"),
)
CID = "a" * 64
FAKE_DOCKER = r'''
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
root = Path(os.environ["FAKE_ROOT"])
with (root / "calls").open("a") as out:
    out.write(json.dumps(args) + "\n")
mode = os.environ["FAKE_MODE"]
kind = "network" if args[0] == "network" else "container"
identifier = args[-1]
if "inspect" in args:
    if mode == "error":
        print(os.environ["FAKE_ERROR"], file=sys.stderr)
        sys.exit(int(os.environ.get("FAKE_EXIT", "1")))
    if mode == "missing":
        print(f"Error response from daemon: network {identifier} not found" if kind == "network"
              else f"Error: No such container: {identifier}", file=sys.stderr)
        sys.exit(1)
    print("b" * 64 if mode == "mismatch" else identifier)
    sys.exit(0)
if "rm" in args:
    if mode in ("remove-error", "error", "mismatch"):
        print("Cannot connect to the Docker daemon", file=sys.stderr)
        sys.exit(1)
    if mode == "missing":
        print("Error response from daemon: resource not found", file=sys.stderr)
        sys.exit(1)
    (root / "removed").write_text(identifier)
    sys.exit(0)
sys.exit(90)
'''


class RecoveryCleanupTests(unittest.TestCase):
    def execute_case(self, case, mode="success", error="", status=1):
        script, ownership, filename, _ = case
        tmp = tempfile.TemporaryDirectory(prefix="docklane-cleanup-test-")
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        marker = root / "evidence" / ownership / filename
        marker.parent.mkdir(parents=True)
        marker.write_text(CID + "\n")
        binaries = root / "bin"
        binaries.mkdir()
        docker = binaries / "docker"
        docker.write_text(f"#!{sys.executable} -S\n" + FAKE_DOCKER)
        docker.chmod(0o755)
        env = dict(os.environ, PATH=f"{binaries}:{os.environ['PATH']}",
                   DOCKLANE_OR_LOG_DIR=str(root / "evidence"),
                   DOCKLANE_OR_PRIVATE_BACKUP_DIR="", FAKE_ROOT=str(root),
                   FAKE_MODE=mode, FAKE_ERROR=error, FAKE_EXIT=str(status))
        def run(**changes):
            return subprocess.run(["bash", str(HERE / script)], env=dict(env, **changes),
                                  capture_output=True, text=True, timeout=5)
        return root, marker, run

    def test_legacy_recovery_is_manual_only(self):
        workflow = (HERE.parents[1] / ".github/workflows/operational-readiness-trust-key-restore.yml").read_text()
        triggers = workflow.split("\non:", 1)[1].split("\nconcurrency:", 1)[0]
        self.assertIn("  workflow_dispatch:", triggers)
        self.assertNotIn("  push:", triggers)
        self.assertNotIn("  pull_request:", triggers)

    def test_inspect_errors_preserve_ownership_and_retry_after_recovery(self):
        errors = ("Cannot connect to the Docker daemon", "permission denied",
                  "context default not found", "Error response from daemon: internal server error", "")
        for case in CASES:
            for error in errors:
                with self.subTest(script=case[0], resource=case[3], error=error):
                    root, marker, run = self.execute_case(case, "error", error)
                    result = run()
                    self.assertNotEqual(result.returncode, 0, result.stdout)
                    self.assertTrue(marker.exists(), "uncertain inspect lost ownership")
                    calls = [json.loads(x) for x in (root / "calls").read_text().splitlines()]
                    self.assertFalse(any("rm" in call for call in calls))
                    self.assertEqual(run(FAKE_MODE="success").returncode, 0)
                    self.assertFalse(marker.exists())
                    self.assertEqual((root / "removed").read_text(), CID)

    def test_confirmed_missing_is_idempotent_and_never_removed(self):
        for case in CASES:
            with self.subTest(script=case[0], resource=case[3]):
                root, marker, run = self.execute_case(case, "missing")
                self.assertEqual(run().returncode, 0)
                self.assertFalse(marker.exists())
                calls = (root / "calls").read_text()
                self.assertNotIn('"rm"', calls)
                self.assertEqual(run().returncode, 0)
                self.assertEqual((root / "calls").read_text(), calls)

    def test_explicit_missing_message_variants(self):
        for case in CASES:
            messages = ([f"Error: No such container: {CID}",
                         f"Error response from daemon: No such container: {CID}",
                         f"Error: No such object: {CID}"] if case[3] == "container" else
                        [f"Error response from daemon: network {CID} not found",
                         f"Error: No such network: {CID}", f"Error: No such object: {CID}"])
            for error in messages:
                with self.subTest(script=case[0], resource=case[3], error=error):
                    root, marker, run = self.execute_case(case, "error", error)
                    self.assertEqual(run().returncode, 0)
                    self.assertFalse(marker.exists())
                    self.assertNotIn('"rm"', (root / "calls").read_text())

    def test_not_found_must_match_resource_id_and_exit_status(self):
        for case in CASES:
            expected = (f"Error: No such container: {CID}" if case[3] == "container" else
                        f"Error response from daemon: network {CID} not found")
            for error, status in ((expected.replace(CID, "b" * 64), 1),
                                  (expected + "\npermission denied", 1),
                                  (expected, 124), (expected, 137), (expected, 127)):
                with self.subTest(script=case[0], resource=case[3], error=error, status=status):
                    root, marker, run = self.execute_case(case, "error", error, status)
                    self.assertNotEqual(run().returncode, 0)
                    self.assertTrue(marker.exists())
                    self.assertFalse((root / "removed").exists())

    def test_id_mismatch_does_not_remove_another_resource(self):
        for case in CASES:
            with self.subTest(script=case[0], resource=case[3]):
                root, marker, run = self.execute_case(case, "mismatch")
                self.assertNotEqual(run().returncode, 0)
                self.assertTrue(marker.exists())
                self.assertNotIn('"rm"', (root / "calls").read_text())

    def test_remove_failure_remains_retryable(self):
        for case in CASES:
            with self.subTest(script=case[0], resource=case[3]):
                root, marker, run = self.execute_case(case, "remove-error")
                self.assertNotEqual(run().returncode, 0)
                self.assertTrue(marker.exists())
                self.assertEqual(run(FAKE_MODE="success").returncode, 0)
                self.assertFalse(marker.exists())
                self.assertEqual((root / "removed").read_text(), CID)

    def test_success_removes_only_the_recorded_id(self):
        for case in CASES:
            with self.subTest(script=case[0], resource=case[3]):
                root, marker, run = self.execute_case(case)
                self.assertEqual(run().returncode, 0)
                self.assertFalse(marker.exists())
                calls = [json.loads(x) for x in (root / "calls").read_text().splitlines()]
                self.assertTrue(calls)
                self.assertTrue(all(call[-1] == CID for call in calls))
                self.assertEqual((root / "removed").read_text(), CID)

    def test_private_backup_is_scrubbed_even_when_docker_inspect_fails(self):
        prefixes = {"db-restore-cleanup.sh": "docklane-db-backup-private-",
                    "swarm-backup-restore-cleanup.sh": "docklane-swarm-backup-private-",
                    "trust-key-restore-cleanup.sh": "docklane-trust-backup-private-"}
        for case in (CASES[0], CASES[1], CASES[3]):
            with self.subTest(script=case[0]):
                root, marker, run = self.execute_case(case, "error", "Cannot connect to Docker")
                backup = root / (prefixes[case[0]] + "synthetic")
                backup.mkdir()
                (backup / "synthetic-key").write_text("not-a-real-secret")
                self.assertNotEqual(run(DOCKLANE_OR_PRIVATE_BACKUP_DIR=str(backup)).returncode, 0)
                self.assertTrue(marker.exists())
                self.assertFalse(backup.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
