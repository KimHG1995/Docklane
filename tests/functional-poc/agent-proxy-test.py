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
            if len(records) != 2:
                raise AssertionError(f"expected 2 forwarded image mutations, got {len(records)}")
            if [record["dropped"] for record in records] != [True, False]:
                raise AssertionError(f"unexpected drop flags: {records}")
            if any(record.get("image") != image for record in records):
                raise AssertionError(f"image was not recorded correctly: {records}")
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

    print("Agent proxy mutation-count regression: PASS")


if __name__ == "__main__":
    main()
