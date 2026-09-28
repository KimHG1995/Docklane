import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = os.environ.get("APP_VERSION", "unknown")
HEALTH_STATUS = int(os.environ.get("HEALTH_STATUS", "200"))


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(HEALTH_STATUS)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            body = "ok" if HEALTH_STATUS == 200 else "broken"
            self.wfile.write((body + "\n").encode())
            return

        if self.path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write((VERSION + "\n").encode())
            return

        self.send_response(404)
        self.end_headers()

    def log_message(self, format, *args):
        return


ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
