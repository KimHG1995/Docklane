#!/usr/bin/env python3
"""One-shot Docker API inspect response barrier for disposable Swarm rejoin."""
import http.client
import json
import os
import re
import socket
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DIR = Path(os.environ["DOCKLANE_REJOIN_LOG_DIR"])
DOCKER_SOCKET = os.environ.get("DOCKLANE_REJOIN_DOCKER_SOCKET", "/var/run/docker.sock")
PORT = int(os.environ.get("DOCKLANE_REJOIN_PROXY_PORT", "12376"))
ARM = DIR / "docker-rejoin.arm"
HOLD = DIR / "docker-rejoin.held"
RELEASE = DIR / "docker-rejoin.release"
LOG = DIR / "docker-rejoin-proxy.jsonl"
SERVICE = os.environ["DOCKLANE_REJOIN_SERVICE_ID"]
MODE = os.environ.get("DOCKLANE_REJOIN_RACE_MODE", "preguard")
if MODE not in ("preguard", "postguard"):
    raise ValueError("unsupported rejoin race mode")
SERVICE_INSPECT = re.compile(r"^/v[0-9.]+/services/" + re.escape(SERVICE) + r"(?:\?.*)?$")
SERVICE_UPDATE = re.compile(r"^/v[0-9.]+/services/[^/]+/update(?:\?.*)?$")
HOP = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade",
       "proxy-authenticate", "proxy-authorization", "content-length"}

class DockerUnixConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(DOCKER_SOCKET)

def record(event, path):
    with LOG.open("a", encoding="utf-8") as out:
        out.write(json.dumps({"event": event, "path": path}, sort_keys=True) + "\n")

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        self.forward()

    def do_HEAD(self):
        self.forward()

    def do_POST(self):
        self.forward()

    def forward(self):
        if self.path == "/__docklane_rejoin_probe":
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        size = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(size) if size else None
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() not in HOP and k.lower() != "host"}
        # Docker Update arrives only after the Agent's final SwarmInspect.
        update_request = self.command == "POST" and SERVICE_UPDATE.match(self.path)
        if update_request and MODE == "postguard":
            record("docker_service_update_attempt", self.path)
            try:
                ARM.rename(DIR / "docker-rejoin.claimed")
            except FileNotFoundError:
                raise RuntimeError("unexpected extra Docker update")
            record("postguard_update_held", self.path)
            HOLD.write_text(self.path + "\n", encoding="utf-8")
            deadline = time.monotonic() + 45
            while not RELEASE.exists():
                if time.monotonic() > deadline:
                    raise TimeoutError("postguard release marker not received")
                time.sleep(0.05)
            record("postguard_update_released", self.path)
        conn = DockerUnixConnection("localhost", timeout=12)
        try:
            conn.request(self.command, self.path, body=body, headers=headers)
            response = conn.getresponse()
            payload = response.read()
            response_headers = response.getheaders()
            status = response.status
        finally:
            conn.close()

        if update_request and MODE == "preguard":
            record("docker_service_update_attempt", self.path)

        if MODE == "preguard" and self.command == "GET" and status == 200 and SERVICE_INSPECT.match(self.path):
            try:
                ARM.rename(DIR / "docker-rejoin.claimed")
            except FileNotFoundError:
                pass
            else:
                record("old_service_inspect_held", self.path)
                HOLD.write_text(self.path + "\n", encoding="utf-8")
                deadline = time.monotonic() + 45
                while not RELEASE.exists():
                    if time.monotonic() > deadline:
                        raise TimeoutError("rejoin release marker not received")
                    time.sleep(0.05)
                record("old_service_inspect_released", self.path)

        self.send_response(status)
        for key, value in response_headers:
            if key.lower() not in HOP:
                self.send_header(key, value)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD" and payload:
            self.wfile.write(payload)

    def log_message(self, *_args):
        return

if __name__ == "__main__":
    DIR.mkdir(parents=True, exist_ok=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
