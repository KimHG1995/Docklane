#!/usr/bin/env python3
"""Bounded, secret-minimizing evidence for disposable Swarm recovery failures.

This is NOT a recovery fix. Only an owned container ID is inspected/signalled.
Raw output stays in anonymous temporary files outside the artifact directory.
"""
from __future__ import annotations

from collections import Counter
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

CONTAINERS = {"docklane-or-trust-restore", "docklane-or-manager-01",
              "docklane-or-manager-02", "docklane-or-manager-03"}
HEX_ID = re.compile(r"[a-f0-9]{64}\Z")
NODE_ID = re.compile(r"[a-z0-9]{25}\Z")
DIGEST = re.compile(r"(?:docker@)?sha256:[a-f0-9]{64}\Z")
VERSION = re.compile(r"[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:-[a-z0-9.]+)?\Z")
STACK_FRAME = re.compile(r"^((?:github\.com/(?:docker/docker|moby/(?:moby|swarmkit)|docker/swarmkit)/|runtime\.|sync\.|internal/sync\.|go\.etcd\.io/)[A-Za-z0-9_./*()@+%-]+)\(")
STACK_LOCATION = re.compile(r"^\s+(?:/[^\s]+/)?([A-Za-z0-9_-]+\.go):([0-9]+)(?:\s|$)")
STACK_STATE = re.compile(
    r"^goroutine [0-9]+ \[([a-zA-Z][a-zA-Z .()]{0,95})"
    r"(?:, [0-9]+ minutes)?(?:, locked to thread)?\]:$"
)
EVENTS = {
    "certificate_renewal": "failed to renew the certificate",
    "connection_refused": "connection refused",
    "leader_unavailable": "no elected leader",
    "session_failure": "failed to select new session",
    "session_registration": "failed to register session",
    "raft_election": "starting a new election",
    "deadline_exceeded": "deadline exceeded",
}
# docker:dind uses docker-init as PID 1. Resolve the daemon's own PID file,
# validate its executable name, and signal only inside the owned container.
STACK_SIGNAL = '''set -eu
pid="$(cat /var/run/docker.pid)"
case "$pid" in ''|*[!0-9]*) exit 2 ;; esac
test "$pid" -gt 0
test "$(cat "/proc/$pid/comm")" = dockerd
kill -USR1 "$pid"
'''
STACK_READ = ('file="$(ls -1t /var/run/docker/goroutine-stacks-*.log 2>/dev/null | head -n 1)"; '
              'test -n "$file" && test -f "$file" && head -c 2000001 "$file"')


def address(value):
    if not isinstance(value, str):
        return None
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        return None


def manager_address(value):
    if not isinstance(value, str):
        return None
    host, sep, port = value.rpartition(":")
    parsed = address(host.strip("[]"))
    if sep and parsed and port.isdecimal() and 0 < int(port) < 65536:
        return f"[{parsed}]:{port}" if ":" in parsed else f"{parsed}:{port}"
    return None


def stack_summary(text):
    """Retain function/file/line and wait state, never argument dumps."""
    result, current, previous = [], None, None
    for line in text.splitlines():
        # Boundary detection must not depend on recognizing the wait state.
        # Drop unsupported/truncated headers and their frames rather than append
        # them to the previous goroutine. Never publish raw header metadata.
        if line.startswith("goroutine "):
            current, previous = None, None
            state = STACK_STATE.fullmatch(line)
            if state and len(result) < 256:
                current = {"state": state.group(1), "frames": []}
                result.append(current)
            continue
        match = STACK_FRAME.match(line)
        location = STACK_LOCATION.match(line)
        if match and current is not None and len(current["frames"]) < 40:
            previous = {"function": match.group(1)}
            current["frames"].append(previous)
        elif location and previous is not None:
            previous.update(file=location.group(1), line=int(location.group(2)))
            previous = None
        else:
            previous = None
    return [entry for entry in result if entry["frames"]]


class Collector:
    def __init__(self, log: Path, probe_timeout: float = 4, total_timeout: float = 35):
        if not 0 < probe_timeout <= 4 or not 0 < total_timeout <= 35:
            raise ValueError("diagnostic budgets must be positive and bounded")
        self.log = Path(log)
        self.probe_timeout = probe_timeout
        self.deadline = time.monotonic() + total_timeout
        self.probes = {}

    def probe(self, name, args):
        remaining = self.deadline - time.monotonic()
        item = {"exit": None, "timeout": False, "truncated": False}
        self.probes[name] = item
        if remaining <= 0:
            item["timeout"] = True
            return ""
        with tempfile.TemporaryFile() as output:
            try:
                process = subprocess.Popen(["docker", *args], stdin=subprocess.DEVNULL,
                                           stdout=output, stderr=output, start_new_session=True)
            except OSError:
                item["exit"] = 127
                return ""
            try:
                process.wait(timeout=min(self.probe_timeout, remaining))
            except subprocess.TimeoutExpired:
                item["timeout"] = True
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
            item["exit"] = process.returncode
            item["truncated"] = output.tell() > 2_000_000
            output.seek(0)
            return output.read(2_000_000).decode("utf-8", errors="replace")

    def object(self, name, args):
        text = self.probe(name, args)
        self.probes[name]["parsed"] = False
        if self.probes[name]["exit"] != 0 or self.probes[name]["truncated"]:
            return {}
        try:
            value = json.loads(text)
        except (ValueError, RecursionError):
            return {}
        if not isinstance(value, dict):
            return {}
        self.probes[name]["parsed"] = True
        return value

    def publish(self, result):
        result["probes"] = self.probes
        self.log.mkdir(parents=True, exist_ok=True)
        destination = self.log / f'recovery-diagnostics-{result["phase"]}.json'
        with tempfile.NamedTemporaryFile(mode="w", dir=self.log, prefix=".diagnostics-", delete=False) as file:
            temporary = Path(file.name)
            json.dump(result, file, indent=2, sort_keys=True)
            file.write("\n")
        try:
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
        return result

    def collect(self, container: str, phase: str, original_exit: int):
        if container not in CONTAINERS or not re.fullmatch(r"[a-z][a-z0-9-]{0,60}", phase):
            raise ValueError("unsupported diagnostic target or phase")
        if not isinstance(original_exit, int) or not 1 <= original_exit <= 255:
            raise ValueError("diagnostics require a failed operation")
        result = {"schema": 1, "phase": phase, "original_exit": original_exit,
                  "status": "ownership-unverified", "acceptance": "not-established"}
        ownership = self.log / "ownership-trust-key" / f"{container}.container-id"
        try:
            if ownership.is_symlink():
                return self.publish(result)
            with ownership.open() as file:
                cid = file.read(256).strip()
        except (OSError, UnicodeError):
            return self.publish(result)
        if not HEX_ID.fullmatch(cid):
            return self.publish(result)
        metadata = self.object("container", ["inspect", "--type", "container", "--format", "{{json .}}", cid])
        if metadata.get("Id") != cid or metadata.get("Name") != "/" + container:
            return self.publish(result)
        # Never signal in the host PID namespace even if an unexpected container
        # happens to match the ownership record. Default private PID mode is "".
        host = metadata.get("HostConfig", {})
        if not isinstance(host, dict) or host.get("PidMode") not in ("", "private"):
            return self.publish(result)
        state, settings = metadata.get("State", {}), metadata.get("NetworkSettings", {})
        self.probes["container"]["shape_valid"] = isinstance(state, dict) and isinstance(settings, dict)
        state = state if isinstance(state, dict) else {}
        settings = settings if isinstance(settings, dict) else {}
        networks = settings.get("Networks", {})
        networks = networks if isinstance(networks, dict) else {}
        network = networks.get("docklane-or-manager-net", {})
        network = network if isinstance(network, dict) else {}
        result["container"] = {"id": cid, "address": address(network.get("IPAddress")),
            "oom_killed": state.get("OOMKilled") if isinstance(state.get("OOMKilled"), bool) else None}
        image_id = metadata.get("Image", "")
        if isinstance(image_id, str) and DIGEST.fullmatch(image_id):
            image = self.object("image", ["image", "inspect", "--format", "{{json .}}", image_id])
            digests = image.get("RepoDigests") or []
            self.probes["image"]["shape_valid"] = isinstance(digests, list)
            digests = digests if isinstance(digests, list) else []
            result["image"] = {"id": image_id, "digests": [d for d in digests if isinstance(d, str) and DIGEST.fullmatch(d)]}
        inner = ["exec", cid, "timeout", "-s", "KILL", "3"]
        version = self.object("version", [*inner, "docker", "version", "--format", "{{json .Server}}"])
        result["version"] = {key: value for key in ("Version", "ApiVersion")
                             if isinstance(value := version.get(key), str) and VERSION.fullmatch(value)}
        self.probes["version"]["shape_valid"] = "Version" in result["version"]
        commit = version.get("GitCommit")
        if isinstance(commit, str) and re.fullmatch(r"[a-f0-9]{7,40}", commit):
            result["version"]["GitCommit"] = commit
        swarm = self.object("swarm", [*inner, "docker", "info", "--format", "{{json .Swarm}}"])
        managers = swarm.get("RemoteManagers") or []
        self.probes["swarm"]["shape_valid"] = isinstance(managers, list)
        managers = managers if isinstance(managers, list) else []
        result["swarm"] = {
            "node_id": swarm.get("NodeID") if isinstance(swarm.get("NodeID"), str) and NODE_ID.fullmatch(swarm["NodeID"]) else None,
            "address": address(swarm.get("NodeAddr")),
            "state": swarm.get("LocalNodeState") if swarm.get("LocalNodeState") in ("inactive", "pending", "active", "error", "locked") else None,
            "control_available": swarm.get("ControlAvailable") if isinstance(swarm.get("ControlAvailable"), bool) else None,
            "manager_addresses": [a for m in managers if isinstance(m, dict) and (a := manager_address(m.get("Addr"))) is not None]}
        self.probe("stack_signal", [*inner, "sh", "-c", STACK_SIGNAL])
        stack = ""
        for attempt in range(3):
            if time.monotonic() >= self.deadline:
                break
            stack = self.probe(f"stack_{attempt}", [*inner, "sh", "-c", STACK_READ])
            if stack_summary(stack):
                break
            time.sleep(min(0.2, max(0, self.deadline - time.monotonic())))
        result["stacks"] = stack_summary(stack)
        logs = self.probe("daemon_logs", ["logs", "--since", "5m", "--tail", "300", cid])
        result["daemon_events"] = dict(Counter(category for line in logs.lower().splitlines()
                                              for category, phrase in EVENTS.items() if phrase in line))
        if not result["stacks"]:
            result["stacks"] = stack_summary(logs)
        result["status"] = "collected" if result["stacks"] and all(
            p["exit"] == 0 and not p["timeout"] and not p["truncated"]
            and p.get("parsed", True) and p.get("shape_valid", True)
            for p in self.probes.values()) else "partial"
        return self.publish(result)


def main():
    try:
        if len(sys.argv) != 4:
            raise ValueError("expected container, phase, operation exit")
        result = Collector(Path(os.environ["DOCKLANE_OR_LOG_DIR"])).collect(sys.argv[1], sys.argv[2], int(sys.argv[3]))
        print("[recovery-diagnostics] " + result["status"])
        return 0 if result["status"] == "collected" else 2
    except (KeyError, ValueError, OSError, TypeError):
        print("[recovery-diagnostics] unavailable", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
