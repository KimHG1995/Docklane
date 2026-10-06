#!/usr/bin/env python3
"""Exercise the real main/ownership paths. Only the Docker boundary is doubled."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('cleanup_scope_probe', HERE / 'unlock-quorum-probe.py')
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)


class DockerDouble:
    def __init__(self):
        self.calls = []
        self.resources = {}
        self.lose_create = False

    def call(self, args, label, seconds=10):
        self.calls.append(list(args))
        if args[0] == 'context':
            return 'unix:///var/run/docker.sock'
        if args[0] == 'create':
            rid = 'b' * 64
            labels = dict(args[i + 1].split('=', 1) for i, value in enumerate(args) if value == '--label')
            name = args[args.index('--name') + 1]
            self.resources[rid] = {'Id': rid, 'Name': '/' + name,
                                   'HostConfig': {'PidMode': ''}, 'Config': {'Labels': labels}}
            if self.lose_create:
                raise PROBE.ProbeError('create response lost')
            return rid
        if args[:2] == ['container', 'ls']:
            return '\n'.join(self.resources)
        if args[0] == 'rm':
            self.resources.pop(args[-1], None)
            return args[-1]
        raise AssertionError(f'unexpected Docker request: {args}')

    def inspect_resource(self, kind, rid):
        self.calls.append(['inspect_resource', kind, rid])
        return self.resources.get(rid)


class CleanupScopeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.docker = DockerDouble()
        self.helper = self.root / 'reader'
        self.helper.write_bytes(b'fixture only; never executed')
        self.helper.chmod(0o700)
        self.env = {'DOCKLANE_OR_DISPOSABLE_HOST': '1', 'DOCKER_HOST': 'unix:///var/run/docker.sock',
                    'DOCKER_CONTEXT': '', 'DOCKLANE_OR_LOG_DIR': str(self.root),
                    'DOCKLANE_OR_LOCAL_STATE_HELPER': str(self.helper)}
        self.own = self.root / 'ownership-trust-key'
        previous_signal = signal.getsignal(signal.SIGTERM)
        self.addCleanup(signal.signal, signal.SIGTERM, previous_signal)

    def seed_previous(self, journal=False):
        self.own.mkdir(exist_ok=True)
        name, rid = PROBE.NAMES[0], 'a' * 64
        (self.own / f'{name}.container-id').write_text(rid + '\n')
        value = {'Id': rid, 'Name': '/' + name, 'HostConfig': {'PidMode': ''}}
        if journal:
            run = 'e' * 32
            (self.own / 'creation.json').write_text(json.dumps(
                {'schema': 1, 'run_id': run, 'resources': {name: rid}}))
            value['Config'] = {'Labels': {PROBE.RUN_LABEL: run, PROBE.RESOURCE_LABEL: name}}
        self.docker.resources[rid] = value
        return {path.name: path.read_bytes() for path in self.own.iterdir()}

    def invoke(self, env=None, args=(), execute=None):
        with patch.dict(os.environ, self.env | (env or {})), \
                patch.object(PROBE.sys, 'argv', ['probe', *args]), \
                patch.object(PROBE, 'Docker', return_value=self.docker), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            if execute is None:
                return PROBE.main()
            with patch.object(PROBE.Probe, 'execute', execute):
                return PROBE.main()

    def assert_previous_preserved(self, before):
        self.assertEqual(self.docker.calls, [], 'rejected preflight contacted Docker during cleanup')
        self.assertIn('a' * 64, self.docker.resources)
        self.assertEqual({p.name: p.read_bytes() for p in self.own.iterdir()}, before)
        report = json.loads((self.root / 'unlock-quorum-probe.json').read_text())
        self.assertIsNot(report['cleanup_completed'], True)

    def test_missing_opt_in_does_not_cleanup_previous_ownership(self):
        before = self.seed_previous()
        self.assertEqual(self.invoke({'DOCKLANE_OR_DISPOSABLE_HOST': ''}), 1)
        self.assert_previous_preserved(before)

    def test_remote_endpoint_does_not_cleanup_previous_ownership(self):
        before = self.seed_previous(journal=True)
        self.assertEqual(self.invoke({'DOCKER_HOST': 'tcp://production:2375'}), 1)
        self.assert_previous_preserved(before)

    def test_context_override_does_not_cleanup_previous_ownership(self):
        before = self.seed_previous(journal=True)
        self.assertEqual(self.invoke({'DOCKER_CONTEXT': 'production'}), 1)
        self.assert_previous_preserved(before)

    def test_valid_host_but_existing_ownership_is_not_implicit_cleanup(self):
        before = self.seed_previous(journal=True)
        self.assertEqual(self.invoke(), 1)
        self.assert_previous_preserved(before)

    def test_missing_helper_does_not_cleanup_previous_ownership(self):
        before = self.seed_previous()
        self.assertEqual(self.invoke({'DOCKLANE_OR_LOCAL_STATE_HELPER': str(self.root / 'missing')}), 1)
        self.assert_previous_preserved(before)

    def test_explicit_cleanup_only_can_remove_previous_ownership(self):
        self.seed_previous(journal=True)
        self.assertEqual(self.invoke(args=('--cleanup-only',)), 0)
        self.assertEqual(self.docker.resources, {})
        self.assertEqual(list(self.own.iterdir()), [])

    def create(self, probe):
        probe.require_local_host()
        return probe.create_owned(PROBE.NAMES[0], ['create', '--name', PROBE.NAMES[0], 'fixture'], 'create')

    def test_failed_current_run_still_cleans_its_own_created_resource(self):
        def execute(probe):
            self.create(probe)
            raise PROBE.ProbeError('later failure')
        self.assertEqual(self.invoke(execute=execute), 1)
        self.assertEqual(self.docker.resources, {})
        self.assertEqual(list(self.own.iterdir()), [])
        self.assertTrue(json.loads((self.root / 'unlock-quorum-probe.json').read_text())['cleanup_completed'])

    def test_current_lost_create_response_is_reconciled_without_resend(self):
        self.docker.lose_create = True
        self.assertEqual(self.invoke(execute=lambda probe: self.create(probe)), 1)
        self.assertEqual(self.docker.resources, {})
        self.assertEqual(sum(call[0] == 'create' for call in self.docker.calls), 1)
        self.assertTrue(any(call[:2] == ['container', 'ls'] for call in self.docker.calls))

    def test_host_is_rechecked_before_automatic_cleanup(self):
        def execute(probe):
            self.create(probe)
            self.docker.calls.clear()
            os.environ['DOCKER_HOST'] = 'tcp://production:2375'
            raise PROBE.ProbeError('later failure')
        self.assertEqual(self.invoke(execute=execute), 1)
        self.assertEqual(self.docker.calls, [])
        self.assertIn('b' * 64, self.docker.resources)
        self.assertTrue((self.own / 'creation.json').exists())

    def test_replaced_journal_cannot_authorize_automatic_cleanup(self):
        def execute(probe):
            self.create(probe)
            journal = self.own / 'creation.json'
            record = json.loads(journal.read_text())
            record['run_id'] = 'f' * 32
            journal.write_text(json.dumps(record))
            self.docker.resources['b' * 64]['Config']['Labels'][PROBE.RUN_LABEL] = 'f' * 32
            self.docker.calls.clear()
            raise PROBE.ProbeError('replaced run')
        self.assertEqual(self.invoke(execute=execute), 1)
        self.assertEqual(self.docker.calls, [])
        self.assertIn('b' * 64, self.docker.resources)

    def test_legacy_marker_injected_into_current_run_is_not_deleted(self):
        def execute(probe):
            self.create(probe)
            rid, name = 'c' * 64, PROBE.NAMES[2]
            (self.own / f'{name}.container-id').write_text(rid)
            self.docker.resources[rid] = {'Id': rid, 'Name': '/' + name, 'HostConfig': {'PidMode': ''}}
            self.docker.calls.clear()
            raise PROBE.ProbeError('mixed ownership')
        self.assertEqual(self.invoke(execute=execute), 1)
        self.assertEqual(self.docker.calls, [])
        self.assertEqual(len(self.docker.resources), 2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
