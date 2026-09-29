import http.client
import json
import os
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BACKEND_HOST = os.environ.get("DOCKLANE_POC_AGENT_BACKEND_HOST", "127.0.0.1")
BACKEND_PORT = int(os.environ.get("DOCKLANE_POC_AGENT_BACKEND_PORT", "9443"))
PROXY_HOST = os.environ.get("DOCKLANE_POC_AGENT_PROXY_HOST", "127.0.0.1")
PROXY_PORT = int(os.environ.get("DOCKLANE_POC_AGENT_PROXY_PORT", "9555"))
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

        is_image_mutation = (
            self.command == "POST"
            and self.path.startswith("/v1/services/")
            and self.path.endswith("/image")
        )
        should_drop = is_image_mutation and DROP_MARKER.exists()

        mutation_context = None
        if is_image_mutation:
            mutation_context = {
                "method": self.command,
                "path": self.path,
                "dropped": should_drop,
            }
            if body:
                try:
                    parsed_body = json.loads(body)
                    if isinstance(parsed_body, dict):
                        mutation_context["image"] = parsed_body.get("image")
                        mutation_context["expectedVersion"] = parsed_body.get(
                            "expectedVersion"
                        )
                        mutation_context["targetSpecHash"] = parsed_body.get(
                            "targetSpecHash"
                        )
                except (json.JSONDecodeError, UnicodeDecodeError):
                    mutation_context["bodyParseError"] = True

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
            if mutation_context is not None:
                self._log_mutation_event("forwarded", mutation_context)

            response = connection.getresponse()
            try:
                response_body = response.read()
                response_headers = response.getheaders()
            except Exception as error:
                if mutation_context is not None:
                    self._log_mutation_event(
                        "response_error",
                        mutation_context,
                        error=repr(error),
                    )
                raise

            if mutation_context is not None:
                self._log_mutation_event(
                    "response",
                    mutation_context,
                    backend_status=response.status,
                )
        finally:
            connection.close()

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

    def _log_mutation_event(
        self,
        event,
        context,
        backend_status=None,
        error=None,
    ):
        record = dict(context)
        record["event"] = event
        if backend_status is not None:
            record["backendStatus"] = backend_status
        if error is not None:
            record["error"] = error

        MUTATION_LOG.parent.mkdir(parents=True, exist_ok=True)
        with MUTATION_LOG.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, sort_keys=True) + "\n")

    def log_message(self, format, *args):
        return


if __name__ == "__main__":
    ThreadingHTTPServer((PROXY_HOST, PROXY_PORT), ProxyHandler).serve_forever()
