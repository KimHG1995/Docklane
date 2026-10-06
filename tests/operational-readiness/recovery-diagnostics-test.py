#!/usr/bin/env python3
"""Local regressions for bounded, secret-minimizing recovery evidence."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
COLLECTOR = HERE / "recovery-diagnostics.py"
NAME = "docklane-or-trust-restore"
CID = "a" * 64
SECRET = "SWMKEY-1-" + "X" * 43
TOKEN = "SWMTKN-1-" + "Y" * 70
STACK = '''goroutine 42 [chan receive]:
github.com/docker/docker/daemon/cluster.(*Cluster).UnlockSwarm(0x123456, {0xcafebabe, 0x33})
\t/go/src/github.com/docker/docker/daemon/cluster/swarm.go:123 +0xabc
runtime.chanrecv(0xcafebabe, 0x0, 0x1)
\t/usr/local/go/src/runtime/chan.go:99 +0xabc
'''

FAKE = r'''
import json, os, sys, time
from pathlib import Path
root = Path(os.environ["FAKE_ROOT"])
a = sys.argv[1:]
with (root / "calls").open("a") as f:
    f.write(json.dumps(a) + "\n")
if os.environ.get("PROBE_HANG") == "1":
    time.sleep(60)
if a[0] == "inspect":
    if os.environ.get("BAD_ID") == "1":
        print(json.dumps({"Id": "b" * 64})); sys.exit(0)
    print((root / "inspect.json").read_text())
elif a[0] == "image":
    print((root / "image.json").read_text())
elif a[0] == "logs":
    print((root / "daemon.log").read_text())
elif a[0] == "exec":
    inner = a[a.index("timeout") + 4:]
    if inner[:2] == ["docker", "version"]:
        print((root / "version.json").read_text())
    elif inner[:2] == ["docker", "info"]:
        print((root / "swarm.json").read_text())
    elif inner[:2] == ["sh", "-c"]:
        if 'kill -USR1 "$pid"' in inner[-1]:
            (root / "signal").touch()
        else:
            print((root / "stack.log").read_text())
    else:
        sys.exit(90)
else:
    sys.exit(91)
'''


class DiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="docklane-diag-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.log = self.root / "evidence"
        self.own = self.log / "ownership-trust-key"
        self.own.mkdir(parents=True)
        (self.own / f"{NAME}.container-id").write_text(CID + "\n")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        docker = self.bin / "docker"
        docker.write_text(f"#!{sys.executable} -S\n" + FAKE)
        docker.chmod(0o755)
        self.env = dict(PATH=f"{self.bin}:{os.environ['PATH']}", FAKE_ROOT=str(self.root))
        self.metadata = {
            "Id": CID, "Name": "/" + NAME, "Image": "sha256:" + "b" * 64,
            "HostConfig": {"PidMode": ""},
            "State": {"Status": "running", "OOMKilled": False, "Error": SECRET},
            "Config": {"Env": [SECRET, TOKEN]},
            "NetworkSettings": {"Networks": {"docklane-or-manager-net": {"IPAddress": "172.30.251.3"}}},
        }
        (self.root / "inspect.json").write_text(json.dumps(self.metadata))
        (self.root / "image.json").write_text(json.dumps({"Id": "sha256:" + "b" * 64, "RepoDigests": ["docker@sha256:" + "c" * 64], "Comment": SECRET}))
        (self.root / "version.json").write_text(json.dumps({"Version": "28.5.2", "ApiVersion": "1.51", "GitCommit": "abcdef1", "Secret": SECRET}))
        (self.root / "swarm.json").write_text(json.dumps({"LocalNodeState": "pending", "ControlAvailable": False, "NodeID": "n" * 25, "NodeAddr": "172.30.251.3", "RemoteManagers": [{"NodeID": "m" * 25, "Addr": "172.30.251.2:2377"}], "JoinTokens": {"Worker": TOKEN}}))
        (self.root / "daemon.log").write_text(f'failed to renew the certificate: connection refused {SECRET}\nno elected leader {TOKEN}\n-----BEGIN PRIVATE KEY-----\nprivate-data\n-----END PRIVATE KEY-----\n')
        (self.root / "stack.log").write_text(STACK + SECRET + "\n" + TOKEN + "\n")

    def module(self):
        self.assertTrue(COLLECTOR.exists(), "bounded diagnostics collector is missing")
        spec = importlib.util.spec_from_file_location("recovery_diagnostics", COLLECTOR)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def collect(self, **kw):
        module = self.module()
        with patch.dict(os.environ, self.env):
            return module.Collector(self.log, **kw).collect(NAME, "restore-unlock", 137)

    def calls(self):
        file = self.root / "calls"
        return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []

    def test_collects_version_identity_and_stack_without_raw_secrets(self):
        result = self.collect()
        self.assertEqual(result["original_exit"], 137)
        self.assertEqual(result["status"], "collected")
        self.assertEqual(result["version"]["Version"], "28.5.2")
        self.assertEqual(result["container"]["address"], "172.30.251.3")
        self.assertFalse(result["container"]["oom_killed"])
        self.assertTrue((self.root / "signal").exists())
        text = json.dumps(result)
        for expected in ("UnlockSwarm", "chan receive", "certificate_renewal"):
            self.assertIn(expected, text)
        for bad in (SECRET, TOKEN, "private-data", "0xcafebabe", "0x123456", "PRIVATE KEY"):
            self.assertNotIn(bad, text)
        file = self.log / "recovery-diagnostics-restore-unlock.json"
        self.assertEqual(json.loads(file.read_text()), result)

    def test_missing_or_malformed_ownership_never_signals(self):
        own = self.own / f"{NAME}.container-id"
        for value in (None, "short-id", "--help", "b" * 63):
            with self.subTest(value=value):
                own.unlink(missing_ok=True)
                if value is not None:
                    own.write_text(value)
                self.assertEqual(self.collect()["status"], "ownership-unverified")
                self.assertEqual(self.calls(), [])

    def test_identity_mismatch_never_runs_exec_or_signal(self):
        self.env["BAD_ID"] = "1"
        self.assertEqual(self.collect()["status"], "ownership-unverified")
        self.assertEqual(len(self.calls()), 1)
        self.assertFalse((self.root / "signal").exists())

    def test_hung_probe_is_bounded_and_partial_evidence_survives(self):
        self.env["PROBE_HANG"] = "1"
        before = time.monotonic()
        result = self.collect(probe_timeout=0.15, total_timeout=0.8)
        self.assertLess(time.monotonic() - before, 1.5)
        self.assertTrue(result["probes"]["container"]["timeout"])
        self.assertEqual(result["original_exit"], 137)
        self.assertTrue((self.log / "recovery-diagnostics-restore-unlock.json").exists())

    def test_no_raw_output_written_under_artifact_root(self):
        self.collect()
        for file in self.log.rglob("*"):
            if file.is_file():
                for secret in (SECRET, TOKEN, "private-data", "0xcafebabe"):
                    self.assertNotIn(secret, file.read_text())
        for call in self.calls():
            self.assertNotIn(SECRET, json.dumps(call))
            self.assertNotIn("--force-new-cluster", call)
            if call[0] == "exec":
                self.assertEqual(call[1], CID)
                self.assertEqual(call[2:5], ["timeout", "-s", "KILL"])

    def test_malformed_json_publishes_partial_not_raw_payload(self):
        (self.root / "version.json").write_text(SECRET + "{")
        result = self.collect()
        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["probes"]["version"]["parsed"])
        self.assertNotIn(SECRET, json.dumps(result))

    def test_wrong_nested_shapes_preserve_partial_evidence(self):
        self.metadata.update(State=[], NetworkSettings=[])
        (self.root / "inspect.json").write_text(json.dumps(self.metadata))
        (self.root / "swarm.json").write_text(json.dumps({"RemoteManagers": 7}))
        result = self.collect()
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["swarm"]["manager_addresses"], [])

    def test_stack_keeps_source_line_but_not_arguments(self):
        summary = self.module().stack_summary(STACK)
        self.assertEqual(summary[0]["frames"][0]["file"], "swarm.go")
        self.assertEqual(summary[0]["frames"][0]["line"], 123)
        self.assertNotIn("0x123456", json.dumps(summary))

    def test_output_phase_and_container_validated_before_docker(self):
        module = self.module()
        with patch.dict(os.environ, self.env):
            for container, phase in ((NAME, "../outside"), ("unowned-container", "restore-unlock")):
                with self.assertRaises(ValueError):
                    module.Collector(self.log).collect(container, phase, 137)
        self.assertEqual(self.calls(), [])

    def test_real_unlock_failure_collects_before_cleanup_without_continuation(self):
        source = (HERE / "trust-key-restore-v2.sh").read_text().split("\nfor name in ", 1)[0]
        functions = self.root / "functions.sh"
        functions.write_text(source)
        wrapper = self.bin / "python3"
        wrapper.write_text('#!/bin/sh\nprintf "diagnostics\\n" >> "$ORDER_FILE"\nexit 9\n')
        wrapper.chmod(0o755)
        order = self.root / "order"
        body = f'''source {shlex.quote(str(functions))}
ROOT={shlex.quote(str(HERE.parents[1]))}
export ORDER_FILE={shlex.quote(str(order))}
swarm_call(){{ return 137; }}
trap 'printf "cleanup\\n" >> "$ORDER_FILE"' EXIT
unlock "$RESTORE" synthetic restore-unlock
echo MUST-NOT-CONTINUE
'''
        result = subprocess.run(["bash", "-c", body], env=dict(os.environ, **self.env, DOCKLANE_OR_LOG_DIR=str(self.log)), capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("MUST-NOT-CONTINUE", result.stdout)
        self.assertIn("exit 137", result.stderr)
        self.assertEqual(order.read_text().splitlines(), ["diagnostics", "cleanup"])

    def test_workflow_requires_diagnostics_and_evidence_without_pr_acceptance(self):
        workflow = (HERE.parents[1] / ".github/workflows/operational-readiness-recovery-v2.yml").read_text()
        self.assertIn("recovery-diagnostics-test.py", workflow)
        self.assertNotIn("pull_request:", workflow)
        self.assertIn("if-no-files-found: error", workflow)
        self.assertIn("recovery-diagnostics.py", workflow)

    def test_signal_uses_validated_daemon_pid_not_dind_init(self):
        # Execute the actual sh guard. Only /proc and PID-file reads and kill
        # are test doubles; PID 1 deliberately reports docker-init.
        module = self.module()
        wrappers = '''cat(){
case "$1" in
/var/run/docker.pid) printf '%s' "$PID_FIXTURE" ;;
/proc/1/comm) printf 'docker-init' ;;
/proc/7/comm) printf '%s' "$COMM_FIXTURE" ;;
*) return 1 ;;
esac
}
kill(){ printf 'signal:%s:%s' "$1" "$2"; }
'''
        for pid, comm, valid in (("7", "dockerd", True), ("1", "dockerd", False), ("7", "unrelated", False), ("0", "dockerd", False), ("-7", "dockerd", False), ("7;echo BAD", "dockerd", False)):
            with self.subTest(pid=pid, comm=comm):
                result = subprocess.run(["sh", "-c", wrappers + module.STACK_SIGNAL], env=dict(os.environ, PID_FIXTURE=pid, COMM_FIXTURE=comm), capture_output=True, text=True, timeout=2)
                self.assertEqual(result.returncode == 0, valid)
                self.assertEqual(result.stdout, "signal:-USR1:7" if valid else "")

    def test_host_pid_namespace_never_signalled(self):
        self.metadata["HostConfig"]["PidMode"] = "host"
        (self.root / "inspect.json").write_text(json.dumps(self.metadata))
        self.assertEqual(self.collect()["status"], "ownership-unverified")
        self.assertFalse(any(call[0] == "exec" for call in self.calls()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
