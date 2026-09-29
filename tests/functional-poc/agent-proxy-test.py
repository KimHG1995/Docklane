import http.client
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class BackendHandler(BaseHTTPRequestHandler):
    requests = 0

    def do_POST(self):
        BackendHandler.requests += 1
        length = int(self.headers.get("content-length", "0"))
        if length:
            self.rfile.read(length)
        body = json.dumps(
            {
                "serviceId": "service-1",
                "version": 2,
                "targetSpecHash": "target",
                "targetForceUpdate": 0,
                "warnings": [],
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return


def wait_proxy(port):
    for _ in range(50):
        try:
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
            connection.request("GET", "/probe")
            response = connection.getresponse()
            response.read()
            connection.close()
            return
        except OSError:
            time.sleep(0.05)
    raise RuntimeError("proxy did not start")


def wait_listener(port):
    for _ in range(50):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return
        except OSError:
            time.sleep(0.05)
    raise RuntimeError("proxy listener did not start")


def post_image(port, image):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    body = json.dumps(
        {
            "expectedVersion": 1,
            "expectedSpecHash": "before",
            "targetSpecHash": "target",
            "image": image,
        }
    )
    try:
        connection.request(
            "POST",
            "/v1/services/service-1/image",
            body=body,
            headers={"Content-Type": "application/json"},
        )
        response = connection.getresponse()
        payload = response.read()
        return response.status, payload
    finally:
        connection.close()


class BrokenThenConflictHandler(BaseHTTPRequestHandler):
    requests = 0

    def do_POST(self):
        BrokenThenConflictHandler.requests += 1
        length = int(self.headers.get("content-length", "0"))
        if length:
            self.rfile.read(length)

        if BrokenThenConflictHandler.requests == 1:
            body = b'{"partial":'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body) + 32))
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return

        body = b'{"error":"conflict"}'
        self.send_response(409)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return


def run_incomplete_response_regression(root):
    backend_port = free_port()
    proxy_port = free_port()
    backend = ThreadingHTTPServer(
        ("127.0.0.1", backend_port),
        BrokenThenConflictHandler,
    )
    thread = threading.Thread(target=backend.serve_forever, daemon=True)
    thread.start()

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        mutation_log = tmp_path / "mutations.jsonl"

        env = os.environ.copy()
        env.update(
            {
                "DOCKLANE_POC_AGENT_BACKEND_HOST": "127.0.0.1",
                "DOCKLANE_POC_AGENT_BACKEND_PORT": str(backend_port),
                "DOCKLANE_POC_AGENT_PROXY_PORT": str(proxy_port),
                "DOCKLANE_POC_AGENT_DROP_MARKER": str(tmp_path / "unused-drop"),
                "DOCKLANE_POC_AGENT_DROP_LOG": str(tmp_path / "drops.log"),
                "DOCKLANE_POC_AGENT_MUTATION_LOG": str(mutation_log),
            }
        )

        process = subprocess.Popen(
            [sys.executable, str(root / "tests/functional-poc/agent-proxy.py")],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            wait_proxy(proxy_port)
            image = "registry.example/api@sha256:" + ("b" * 64)

            first_failed = False
            try:
                post_image(proxy_port, image)
            except (
                http.client.IncompleteRead,
                http.client.RemoteDisconnected,
                ConnectionResetError,
                BrokenPipeError,
            ):
                first_failed = True
            if not first_failed:
                raise AssertionError("incomplete backend response was not surfaced")

            status, _ = post_image(proxy_port, image)
            if status != 409:
                raise AssertionError(f"second Agent request returned {status}")

            records = [
                json.loads(line)
                for line in mutation_log.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            forwarded = [
                record for record in records if record.get("event") == "forwarded"
            ]
            response_errors = [
                record
                for record in records
                if record.get("event") == "response_error"
            ]
            responses = [
                record for record in records if record.get("event") == "response"
            ]

            if len(forwarded) != 2:
                raise AssertionError(
                    f"incomplete response must still count both forwards: {records}"
                )
            if len(response_errors) != 1:
                raise AssertionError(
                    f"expected one response_error event: {records}"
                )
            if len(responses) != 1 or responses[0].get("backendStatus") != 409:
                raise AssertionError(
                    f"expected second response to record 409: {records}"
                )
            if BrokenThenConflictHandler.requests != 2:
                raise AssertionError(
                    "backend did not receive both mutation attempts"
                )
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
            backend.shutdown()
            backend.server_close()


def run_connect_failure_regression(root):
    backend_port = free_port()
    proxy_port = free_port()

    # Reserve and release backend_port so nothing is listening there.
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        mutation_log = tmp_path / "mutations.jsonl"

        env = os.environ.copy()
        env.update(
            {
                "DOCKLANE_POC_AGENT_BACKEND_HOST": "127.0.0.1",
                "DOCKLANE_POC_AGENT_BACKEND_PORT": str(backend_port),
                "DOCKLANE_POC_AGENT_PROXY_PORT": str(proxy_port),
                "DOCKLANE_POC_AGENT_DROP_MARKER": str(tmp_path / "unused-drop"),
                "DOCKLANE_POC_AGENT_DROP_LOG": str(tmp_path / "drops.log"),
                "DOCKLANE_POC_AGENT_MUTATION_LOG": str(mutation_log),
            }
        )

        process = subprocess.Popen(
            [sys.executable, str(root / "tests/functional-poc/agent-proxy.py")],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            wait_listener(proxy_port)
            image = "registry.example/api@sha256:" + ("c" * 64)

            failed = False
            try:
                post_image(proxy_port, image)
            except (
                http.client.RemoteDisconnected,
                ConnectionResetError,
                BrokenPipeError,
            ):
                failed = True

            if not failed:
                raise AssertionError("backend connect failure was not surfaced")

            if mutation_log.exists():
                records = [
                    json.loads(line)
                    for line in mutation_log.read_text(encoding="utf-8").splitlines()
                    if line.strip()
                ]
            else:
                records = []

            forwarded = [
                record for record in records if record.get("event") == "forwarded"
            ]
            if forwarded:
                raise AssertionError(
                    f"connect failure must not count as forwarded: {records}"
                )
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)


def main():
    root = Path(__file__).resolve().parents[2]
    backend_port = free_port()
    proxy_port = free_port()

    backend = ThreadingHTTPServer(("127.0.0.1", backend_port), BackendHandler)
    thread = threading.Thread(target=backend.serve_forever, daemon=True)
    thread.start()

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        marker = tmp_path / "drop"
        drop_log = tmp_path / "drops.log"
        mutation_log = tmp_path / "mutations.jsonl"
        marker.touch()

        env = os.environ.copy()
        env.update(
            {
                "DOCKLANE_POC_AGENT_BACKEND_HOST": "127.0.0.1",
                "DOCKLANE_POC_AGENT_BACKEND_PORT": str(backend_port),
                "DOCKLANE_POC_AGENT_PROXY_PORT": str(proxy_port),
                "DOCKLANE_POC_AGENT_DROP_MARKER": str(marker),
                "DOCKLANE_POC_AGENT_DROP_LOG": str(drop_log),
                "DOCKLANE_POC_AGENT_MUTATION_LOG": str(mutation_log),
            }
        )

        process = subprocess.Popen(
            [sys.executable, str(root / "tests/functional-poc/agent-proxy.py")],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            wait_proxy(proxy_port)

            image = "registry.example/api@sha256:" + ("a" * 64)
            dropped = False
            try:
                post_image(proxy_port, image)
            except (http.client.RemoteDisconnected, ConnectionResetError, BrokenPipeError):
                dropped = True

            if not dropped:
                raise AssertionError("first Agent response was not dropped")

            status, _ = post_image(proxy_port, image)
            if status != 200:
                raise AssertionError(f"second Agent request returned {status}")

            records = [
                json.loads(line)
                for line in mutation_log.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            forwarded = [
                record for record in records if record.get("event") == "forwarded"
            ]
            responses = [
                record for record in records if record.get("event") == "response"
            ]
            if len(forwarded) != 2:
                raise AssertionError(
                    f"expected 2 forwarded image mutations, got {len(forwarded)}"
                )
            if [record["dropped"] for record in forwarded] != [True, False]:
                raise AssertionError(f"unexpected drop flags: {forwarded}")
            if any(record.get("image") != image for record in forwarded):
                raise AssertionError(
                    f"image was not recorded correctly: {forwarded}"
                )
            if len(responses) != 2:
                raise AssertionError(f"expected 2 backend responses, got {responses}")
            if BackendHandler.requests != 2:
                raise AssertionError(
                    f"backend expected 2 mutation requests, got {BackendHandler.requests}"
                )

            drops = drop_log.read_text(encoding="utf-8").splitlines()
            if len(drops) != 1:
                raise AssertionError(f"expected 1 drop log line, got {len(drops)}")
            if marker.exists():
                raise AssertionError("one-shot drop marker was not consumed")
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
            backend.shutdown()
            backend.server_close()

    run_incomplete_response_regression(root)
    run_connect_failure_regression(root)
    print("Agent proxy mutation-count regressions: PASS")


if __name__ == "__main__":
    main()
