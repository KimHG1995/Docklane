import http.client
import json
import os
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BACKEND_HOST = os.environ.get("DOCKLANE_POC_AGENT_BACKEND_HOST", "127.0.0.1")
BACKEND_PORT = int(os.environ.get("DOCKLANE_POC_AGENT_BACKEND_PORT", "9443"))
DROP_MARKER = Path(
    os.environ.get(
        "DOCKLANE_POC_AGENT_DROP_MARKER",
        "/tmp/docklane-poc/drop-agent-image-response",
    )
)
DROP_LOG = Path(
    os.environ.get(
        "DOCKLANE_POC_AGENT_DROP_LOG",
        "/tmp/docklane-poc/agent-proxy-drops.log",
    )
)
MUTATION_LOG = Path(
    os.environ.get(
        "DOCKLANE_POC_AGENT_MUTATION_LOG",
        "/tmp/docklane-poc/agent-image-mutations.jsonl",
    )
)

HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}


class ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        self._proxy()

    def do_POST(self):
        self._proxy()

    def _proxy(self):
        content_length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(content_length) if content_length else None

        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in HOP_BY_HOP and key.lower() != "host"
        }

        connection = http.client.HTTPConnection(
            BACKEND_HOST,
            BACKEND_PORT,
            timeout=10,
        )
        try:
            connection.request(
                self.command,
                self.path,
                body=body,
                headers=headers,
            )
            response = connection.getresponse()
            response_body = response.read()
            response_headers = response.getheaders()
        finally:
            connection.close()

        is_image_mutation = (
            self.command == "POST"
            and self.path.startswith("/v1/services/")
            and self.path.endswith("/image")
        )
        should_drop = is_image_mutation and DROP_MARKER.exists()

        if is_image_mutation:
            mutation = {
                "method": self.command,
                "path": self.path,
                "backendStatus": response.status,
                "dropped": should_drop,
            }
            if body:
                try:
                    parsed_body = json.loads(body)
                    if isinstance(parsed_body, dict):
                        mutation["image"] = parsed_body.get("image")
                        mutation["expectedVersion"] = parsed_body.get(
                            "expectedVersion"
                        )
                        mutation["targetSpecHash"] = parsed_body.get(
                            "targetSpecHash"
                        )
                except (json.JSONDecodeError, UnicodeDecodeError):
                    mutation["bodyParseError"] = True

            MUTATION_LOG.parent.mkdir(parents=True, exist_ok=True)
            with MUTATION_LOG.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(mutation, sort_keys=True) + "\n")

        if should_drop:
            DROP_MARKER.unlink(missing_ok=True)
            DROP_LOG.parent.mkdir(parents=True, exist_ok=True)
            with DROP_LOG.open("a", encoding="utf-8") as handle:
                handle.write(
                    f"{self.command} {self.path} backend_status={response.status}\n"
                )

            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.connection.close()
            self.close_connection = True
            return

        self.send_response(response.status)
        for key, value in response_headers:
            if key.lower() in HOP_BY_HOP:
                continue
            if key.lower() == "content-length":
                continue
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(response_body)))
        self.end_headers()
        if response_body:
            self.wfile.write(response_body)

    def log_message(self, format, *args):
        return


ThreadingHTTPServer(("127.0.0.1", 9555), ProxyHandler).serve_forever()
