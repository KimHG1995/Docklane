#!/usr/bin/env python3
"""Run the real static Go reader against a Unix HTTP server; no Docker required."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import socketserver
import subprocess
import tempfile
import threading
import time
import unittest

HERE = Path(__file__).resolve().parent
SOURCE = 'ping-swarm-header'


class LocalSwarmStatusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='docklane-ping-')
        cls.addClassCleanup(cls.tmp.cleanup)
        cls.root = Path(cls.tmp.name)
        cls.binary = cls.root / 'reader'
        env = dict(os.environ, CGO_ENABLED='0', GOTOOLCHAIN='local')
        subprocess.run(['go', 'build', '-o', str(cls.binary), str(HERE / 'local-swarm-status.go')],
                       env=env, check=True, timeout=120, capture_output=True)

    @contextmanager
    def server(self, response, delay=0):
        sock = self.root / 'daemon.sock'
        requests, errors = [], []
        done = threading.Event()

        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                self.request.settimeout(4)
                data = b''
                try:
                    while b'\r\n\r\n' not in data and len(data) < 8192:
                        part = self.request.recv(1024)
                        if not part:
                            break
                        data += part
                    requests.append(data)
                    done.wait(delay)
                    self.request.sendall(response)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # Expected when reader enforces its own deadline/header limit.
                except Exception as error:
                    errors.append(error)

        server = socketserver.UnixStreamServer(str(sock), Handler)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        thread.start()
        try:
            yield sock, requests
        finally:
            done.set()
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
            sock.unlink(missing_ok=True)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])

    def read(self, sock, extra=(), env=None):
        return subprocess.run([str(self.binary), '--socket', str(sock), *extra],
                              capture_output=True, text=True, timeout=6, env=env)

    def denied(self, response):
        with self.server(response) as (sock, requests):
            result = self.read(sock)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertNotIn('synthetic-secret', result.stderr)
        self.assertLessEqual(len(requests), 1)

    def test_all_documented_local_states_use_exactly_one_head_ping(self):
        for state in ('inactive', 'pending', 'error', 'locked', 'active/worker', 'active/manager'):
            with self.subTest(state=state):
                response = f'HTTP/1.1 200 OK\r\nSwarm: {state}\r\nContent-Length: 0\r\n\r\n'.encode()
                with self.server(response) as (sock, requests):
                    result = self.read(sock)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(result.stdout.strip(), 'missing local state response')
                self.assertEqual(json.loads(result.stdout), {'LocalNodeState': state, 'StateSource': SOURCE})
                self.assertEqual(len(requests), 1)
                self.assertTrue(requests[0].startswith(b'HEAD /_ping HTTP/1.1\r\n'))
                self.assertNotIn(b'/info', requests[0])

    def test_missing_header_is_unknown_not_inactive(self):
        self.denied(b'HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n')

    def test_duplicate_headers_even_with_same_value_are_rejected(self):
        for value in (b'pending', b'locked'):
            with self.subTest(value=value):
                self.denied(b'HTTP/1.1 200 OK\r\nSwarm: pending\r\nswarm: ' + value + b'\r\n\r\n')

    def test_unknown_empty_combined_and_untrusted_header_values_are_rejected(self):
        for value in ('', 'active', 'PENDING', 'pending, locked', 'SWMKEY-1-synthetic-secret'):
            with self.subTest(value=value):
                self.denied(f'HTTP/1.1 200 OK\r\nSwarm: {value}\r\n\r\n'.encode())

    def test_server_error_is_not_accepted_or_echoed(self):
        self.denied(b'HTTP/1.1 503 synthetic-secret\r\nSwarm: pending\r\n\r\nSWMKEY-1-synthetic-secret')

    def test_redirect_is_not_followed(self):
        self.denied(b'HTTP/1.1 302 Found\r\nLocation: http://example.invalid/secret\r\nSwarm: pending\r\n\r\n')

    def test_oversized_headers_are_rejected(self):
        self.denied(b'HTTP/1.1 200 OK\r\nSwarm: pending\r\nX-Padding: ' + b'a' * 12000 + b'\r\n\r\n')

    def test_malformed_http_is_rejected_without_raw_output(self):
        self.denied(b'not-http SWMKEY-1-synthetic-secret\r\n\r\n')

    def test_hung_ping_is_bounded_without_retry(self):
        with self.server(b'HTTP/1.1 200 OK\r\nSwarm: pending\r\n\r\n', delay=5) as (sock, requests):
            start = time.monotonic()
            result = self.read(sock)
            elapsed = time.monotonic() - start
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertLess(elapsed, 4)
        self.assertEqual(len(requests), 1)

    def test_missing_unix_socket_does_not_fall_back_to_docker_host(self):
        result = self.read(self.root / 'missing.sock', env=dict(os.environ, DOCKER_HOST='tcp://example.invalid:2375'))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')

    def test_proxy_and_docker_environment_do_not_redirect_the_unix_request(self):
        env = dict(os.environ, DOCKER_HOST='tcp://example.invalid:2375', DOCKER_CONTEXT='production',
                   HTTP_PROXY='http://example.invalid:8080', HTTPS_PROXY='http://example.invalid:8080',
                   ALL_PROXY='http://example.invalid:8080', NO_PROXY='')
        with self.server(b'HTTP/1.1 200 OK\r\nSwarm: pending\r\n\r\n') as (sock, requests):
            result = self.read(sock, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.strip(), 'missing local state response')
        self.assertEqual(json.loads(result.stdout)['LocalNodeState'], 'pending')
        self.assertEqual(len(requests), 1)

    def test_socket_override_is_a_path_not_an_endpoint(self):
        for path in ('tcp://example.invalid:2375', 'relative.sock'):
            with self.subTest(path=path):
                result = self.read(path)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, '')

    def test_extra_arguments_are_rejected(self):
        with self.server(b'HTTP/1.1 200 OK\r\nSwarm: pending\r\n\r\n') as (sock, requests):
            result = self.read(sock, extra=('unexpected',))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertEqual(requests, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
