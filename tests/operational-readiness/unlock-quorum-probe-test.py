#!/usr/bin/env python3
"""Deterministic policy/process tests; Docker is always a test double."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('unlock_quorum_probe', HERE / 'unlock-quorum-probe.py')
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)
STACKS = [
    {'state': 'chan receive', 'frames': [{'function': 'github.com/docker/docker/daemon/cluster.(*Cluster).UnlockSwarm', 'file': 'swarm.go', 'line': 350}]},
    {'state': 'select', 'frames': [{'function': 'github.com/moby/swarmkit/v2/manager/state/raft.WaitForLeader', 'file': 'util.go', 'line': 52}]},
]
STATE = {'LocalNodeState': 'pending', 'ControlAvailable': True}


class UnlockQuorumPolicyTests(unittest.TestCase):
    def fixture(self):
        events = []
        attempt = Mock()
        attempt.require_live.side_effect = lambda *args: events.append('guard')
        attempt.finish.side_effect = lambda: events.append('finish')
        snapshot = Mock(side_effect=lambda: (events.append('snapshot'), (STATE, STACKS))[1])
        resume = Mock(side_effect=lambda: events.append('resume'))
        publish = Mock(side_effect=lambda value: events.append('publish'))
        return events, attempt, snapshot, resume, publish

    def test_same_live_attempt_completes_only_after_evidence_and_peer_resume(self):
        events, attempt, snapshot, resume, publish = self.fixture()
        result = PROBE.resume_pending_unlock(attempt, snapshot, resume, publish)
        self.assertEqual(events, ['guard', 'snapshot', 'publish', 'guard', 'resume', 'finish'])
        self.assertEqual(result, {'status': 'quorum-restored-same-unlock', 'single_backup_acceptance': False})
        attempt.finish.assert_called_once_with()
        resume.assert_called_once_with()

    def test_expired_attempt_does_not_collect_or_resume(self):
        _, attempt, snapshot, resume, publish = self.fixture()
        attempt.require_live.side_effect = PROBE.ProbeError('expired')
        with self.assertRaises(PROBE.ProbeError):
            PROBE.resume_pending_unlock(attempt, snapshot, resume, publish)
        snapshot.assert_not_called()
        resume.assert_not_called()
        attempt.finish.assert_not_called()

    def test_expiry_during_diagnostics_never_resumes_peers(self):
        _, attempt, snapshot, resume, publish = self.fixture()
        attempt.require_live.side_effect = [None, PROBE.ProbeError('expired')]
        with self.assertRaises(PROBE.ProbeError):
            PROBE.resume_pending_unlock(attempt, snapshot, resume, publish)
        publish.assert_called_once()
        resume.assert_not_called()
        attempt.finish.assert_not_called()

    def test_unrelated_or_merged_stacks_do_not_authorize_resume(self):
        for state, stacks in ((dict(STATE, LocalNodeState='active'), STACKS),
                              (dict(STATE, ControlAvailable=False), STACKS),
                              (STATE, STACKS[:1]), (STATE, []),
                              (STATE, [{'state': 'select', 'frames': STACKS[0]['frames'] + STACKS[1]['frames']}])):
            with self.subTest(state=state, stacks=stacks):
                _, attempt, snapshot, resume, publish = self.fixture()
                snapshot.side_effect = None
                snapshot.return_value = (state, stacks)
                with self.assertRaises(PROBE.ProbeError):
                    PROBE.resume_pending_unlock(attempt, snapshot, resume, publish)
                resume.assert_not_called()
                attempt.finish.assert_not_called()

    def test_resume_error_never_finishes_or_retries_unlock(self):
        _, attempt, snapshot, resume, publish = self.fixture()
        resume.side_effect = PROBE.ProbeError('peer failed')
        with self.assertRaises(PROBE.ProbeError):
            PROBE.resume_pending_unlock(attempt, snapshot, resume, publish)
        resume.assert_called_once_with()
        attempt.finish.assert_not_called()

    def test_unlock_failure_after_resume_is_not_success(self):
        _, attempt, snapshot, resume, publish = self.fixture()
        attempt.finish.side_effect = PROBE.ProbeError('unlock failed')
        with self.assertRaises(PROBE.ProbeError):
            PROBE.resume_pending_unlock(attempt, snapshot, resume, publish)
        resume.assert_called_once_with()
        attempt.finish.assert_called_once_with()

    def test_evidence_omits_raw_secrets(self):
        value = PROBE.pending_evidence(dict(STATE, Error='SWMKEY-1-secret', RemoteManagers=['SWMTKN-1-secret']), STACKS)
        self.assertEqual(value, {'state': 'pending', 'control_available': True,
                                 'unlock_wait_observed': True, 'leader_wait_observed': True,
                                 'waits_in_separate_stacks': True})
        self.assertNotIn('SWM', str(value))


class ProbeRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_missing_opt_in_never_contacts_docker(self):
        docker = Mock()
        with patch.dict(os.environ, {'DOCKLANE_OR_DISPOSABLE_HOST': ''}):
            with self.assertRaisesRegex(PROBE.ProbeError, 'opt-in'):
                PROBE.Probe(self.root, docker).execute()
        self.assertEqual(docker.mock_calls, [])

    def test_remote_docker_endpoint_is_rejected_before_contact(self):
        docker = Mock()
        with patch.dict(os.environ, {'DOCKLANE_OR_DISPOSABLE_HOST': '1', 'DOCKER_HOST': 'tcp://production:2375', 'DOCKER_CONTEXT': ''}):
            with self.assertRaisesRegex(PROBE.ProbeError, 'local Unix'):
                PROBE.Probe(self.root, docker).execute()
        self.assertEqual(docker.mock_calls, [])

    def test_context_override_is_rejected_before_contact(self):
        docker = Mock()
        with patch.dict(os.environ, {'DOCKLANE_OR_DISPOSABLE_HOST': '1', 'DOCKER_HOST': 'unix:///var/run/docker.sock', 'DOCKER_CONTEXT': 'production'}):
            with self.assertRaisesRegex(PROBE.ProbeError, 'context override'):
                PROBE.Probe(self.root, docker).execute()
        self.assertEqual(docker.mock_calls, [])

    def test_cleanup_only_checks_context_before_loading_markers(self):
        with patch.dict(os.environ, {'DOCKLANE_OR_DISPOSABLE_HOST': '1', 'DOCKER_HOST': 'unix:///var/run/docker.sock', 'DOCKER_CONTEXT': 'production'}), \
                patch.object(PROBE.sys, 'argv', ['probe', '--cleanup-only']), \
                patch.object(PROBE.Probe, 'load_ownership') as load, \
                patch.object(PROBE.Probe, 'cleanup') as cleanup:
            self.assertEqual(PROBE.main(), 1)
            load.assert_not_called()
            cleanup.assert_not_called()

    def test_live_guard_checks_exit_and_remaining_budget(self):
        attempt = object.__new__(PROBE.UnlockAttempt)
        attempt.process = Mock()
        attempt.started = 0
        for exited, elapsed in ((137, 3), (0, 3), (None, 21), (None, 31)):
            with self.subTest(exited=exited, elapsed=elapsed), patch.object(PROBE.time, 'monotonic', return_value=elapsed):
                attempt.process.poll.return_value = exited
                with self.assertRaises(PROBE.ProbeError):
                    attempt.require_live(10)
        attempt.process.poll.return_value = None
        with patch.object(PROBE.time, 'monotonic', return_value=5):
            attempt.require_live(10)

    def test_workflow_remains_probe_only_with_always_cleanup(self):
        text = (HERE.parents[1] / '.github/workflows/operational-readiness-unlock-quorum.yml').read_text()
        self.assertNotIn('pull_request:', text)
        self.assertIn("DOCKLANE_OR_DISPOSABLE_HOST: '1'", text)
        self.assertIn('timeout-minutes: 10', text)
        self.assertIn('--cleanup-only', text)
        self.assertEqual(text.count('if: always()'), 2)
        self.assertNotIn('trust-key-restore-v2.sh', text)
        self.assertIn('if-no-files-found: error', text)

    def test_ownership_mismatch_preserves_marker_and_never_removes(self):
        for change in ({'Id': 'b' * 64}, {'Name': '/different'}, {'HostConfig': {'PidMode': 'host'}}):
            with self.subTest(change=change):
                docker = Mock()
                name, cid = PROBE.NAMES[0], 'a' * 64
                value = dict(Id=cid, Name='/' + name, HostConfig={'PidMode': ''})
                value.update(change)
                docker.call.return_value = json.dumps(value)
                probe = PROBE.Probe(self.root, docker)
                probe.own.mkdir(exist_ok=True)
                marker = probe.own / f'{name}.container-id'
                marker.write_text(cid)
                probe.ids[name] = cid
                self.assertFalse(probe.cleanup())
                self.assertEqual(marker.read_text(), cid)
                self.assertEqual(len(docker.call.call_args_list), 1)
                self.assertEqual(docker.call.call_args.args[0][0], 'inspect')

    def test_cleanup_remove_failure_retains_id_for_retry(self):
        docker = Mock()
        name, cid = PROBE.NAMES[0], 'a' * 64
        meta = json.dumps({'Id': cid, 'Name': '/' + name, 'HostConfig': {'PidMode': ''}})
        docker.call.side_effect = [meta, PROBE.ProbeError('failed'), meta, cid]
        probe = PROBE.Probe(self.root, docker)
        probe.own.mkdir()
        marker = probe.own / f'{name}.container-id'
        marker.write_text(cid)
        probe.ids[name] = cid
        self.assertFalse(probe.cleanup())
        self.assertTrue(marker.exists())
        self.assertTrue(probe.cleanup())
        self.assertFalse(marker.exists())
        for call in docker.call.call_args_list:
            self.assertIn(cid, call.args[0])
            self.assertNotIn(name, call.args[0])

    def test_not_found_requires_exact_target_and_status(self):
        docker = PROBE.Docker()
        for kind, name in (('container', PROBE.NAMES[0]), ('network', PROBE.NETWORK)):
            for status, error, expected in (
                (1, f'Error: No such {kind}: {name}\n', True),
                (1, f'Error: No such {kind}: different', False),
                (137, f'Error: No such {kind}: {name}', False),
                (1, 'Cannot connect to the Docker daemon', False),
                (1, f'Error: No such {kind}: {name}\npermission denied', False),
                (0, '', False),
            ):
                with self.subTest(kind=kind, status=status, error=error), patch.object(docker, 'raw', return_value=(status, '', error)):
                    if expected:
                        docker.absent(kind, name)
                    else:
                        with self.assertRaises(PROBE.ProbeError):
                            docker.absent(kind, name)

    def stub_docker(self, code):
        executable = self.root / 'docker'
        executable.write_text('#!/usr/bin/python3\nimport json,os,sys\nfrom pathlib import Path\n'
                              'Path(os.environ["ARGS"]).write_text(json.dumps(sys.argv[1:]))\n'
                              'Path(os.environ["INPUT"]).write_text(sys.stdin.read())\n'
                              'print("SWMKEY-1-synthetic-secret", file=sys.stderr)\n'
                              f'sys.exit({code})\n')
        executable.chmod(0o755)
        return {'PATH': str(self.root), 'ARGS': str(self.root / 'args.json'), 'INPUT': str(self.root / 'input.txt')}

    def test_unlock_key_uses_stdin_and_process_is_reaped(self):
        with patch.dict(os.environ, self.stub_docker(0)):
            with PROBE.UnlockAttempt('a' * 64, 'SWMKEY-1-synthetic-key') as attempt:
                attempt.finish()
            self.assertEqual(attempt.process.poll(), 0)
        args = json.loads((self.root / 'args.json').read_text())
        self.assertEqual(args, ['exec', '-i', 'a' * 64, 'timeout', '-s', 'KILL', '30', 'docker', 'swarm', 'unlock'])
        self.assertNotIn('SWMKEY', str(args))
        self.assertEqual((self.root / 'input.txt').read_text(), 'SWMKEY-1-synthetic-key\n')

    def test_failed_unlock_hides_stderr_without_relaunch(self):
        with patch.dict(os.environ, self.stub_docker(137)):
            with PROBE.UnlockAttempt('a' * 64, 'synthetic-key') as attempt:
                with self.assertRaisesRegex(PROBE.ProbeError, 'exit 137') as error:
                    attempt.finish()
            self.assertNotIn('synthetic-secret', str(error.exception))
            self.assertEqual(attempt.process.poll(), 137)

    def test_hung_unlock_outer_process_is_killed_without_resend(self):
        env = self.stub_docker(0)
        executable = self.root / 'docker'
        executable.write_text(executable.read_text().replace('sys.exit(0)', 'import time; time.sleep(30)'))
        with patch.dict(os.environ, env), patch.object(PROBE, 'UNLOCK_SECONDS', 0.01):
            with PROBE.UnlockAttempt('a' * 64, 'synthetic-key') as attempt:
                with self.assertRaisesRegex(PROBE.ProbeError, 'deadline exceeded'):
                    attempt.finish()
            self.assertIsNotNone(attempt.process.poll())
            self.assertNotEqual(attempt.process.returncode, 0)

    def test_full_orchestration_preserves_ownership_and_separate_acceptance(self):
        names = PROBE.NAMES
        ids = {name: char * 64 for name, char in zip(names, 'abc')}
        events = []
        key = 'SWMKEY-1-' + 'A' * 43

        class FakeDocker:
            def absent(self, kind, name):
                events.append(('absent', kind, name))

            def call(self, args, label, seconds=10):
                events.append(tuple(args))
                if args[0] == 'context':
                    return 'unix:///var/run/docker.sock'
                if args[0] == 'info':
                    return 'inactive'
                if args[:2] in (['network', 'create'], ['network', 'inspect']):
                    return 'd' * 64
                if args[0] == 'create':
                    return ids[args[args.index('--name') + 1]]
                if args[0] == 'inspect':
                    name = next(name for name in names if ids[name] == args[-1])
                    if '{{json .}}' in args:
                        return json.dumps({'Id': ids[name], 'Name': '/' + name, 'HostConfig': {'PidMode': ''}})
                    return '172.30.0.' + str(names.index(name) + 2)
                if args[0] in ('pause', 'unpause', 'restart', 'start', 'rm'):
                    values = [arg for arg in args[1:] if not arg.startswith('-')]
                    if not all(arg in ids.values() for arg in values):
                        raise AssertionError('mutation without owned full IDs')
                return ''

            def inner(self, cid, args, label, seconds=5):
                events.append(('inner', cid, *args))
                if args[0] == 'version':
                    return '28.5.2'
                if args[:2] == ['node', 'ls']:
                    return 'manager-01|Ready|Active|Leader\nmanager-02|Ready|Active|Reachable\nmanager-03|Ready|Active|Reachable'
                if args[:2] == ['swarm', 'unlock-key']:
                    return key
                if args[:2] == ['swarm', 'join-token']:
                    return 'synthetic-manager-token'
                if args[0] == 'info':
                    return 'locked' if 'LocalNodeState' in args[-1] else 'cluster-a'
                return ''

        attempt = Mock()
        attempt.started = 0
        context = Mock()
        context.__enter__ = Mock(return_value=attempt)
        context.__exit__ = Mock(return_value=False)
        probe = PROBE.Probe(self.root, FakeDocker())
        with patch.dict(os.environ, {'DOCKLANE_OR_DISPOSABLE_HOST': '1', 'DOCKER_HOST': '', 'DOCKER_CONTEXT': ''}), \
                patch.object(PROBE.time, 'sleep'), patch.object(PROBE, 'UnlockAttempt', return_value=context) as factory, \
                patch.object(probe, 'snapshot', return_value=(STATE, STACKS)):
            probe.execute()
            self.assertEqual(factory.call_count, 2)  # One control, ONE isolated request.
            self.assertEqual(attempt.finish.call_count, 2)
            self.assertEqual(probe.report['isolated_unlock_attempts'], 1)
            self.assertFalse(probe.report['single_backup_acceptance'])
            self.assertTrue(probe.report['same_pending_unlock_completed'])
            self.assertTrue(probe.cleanup())
        self.assertEqual(sum(event[0] == 'pause' for event in events), 1)
        self.assertEqual(sum(event[0] == 'unpause' for event in events), 1)
        self.assertNotIn('--force-new-cluster', str(events))
        self.assertNotIn('--autolock=false', str(events))
        self.assertEqual(list(probe.own.iterdir()), [])

    def test_load_ownership_rejects_malformed_markers(self):
        probe = PROBE.Probe(self.root, Mock())
        probe.own.mkdir()
        marker = probe.own / f'{PROBE.NAMES[0]}.container-id'
        marker.write_text('a' * 64 + '\n')
        probe.load_ownership()
        self.assertEqual(probe.ids, {PROBE.NAMES[0]: 'a' * 64})
        marker.write_text('not-a-full-id')
        with self.assertRaises(PROBE.ProbeError):
            probe.load_ownership()
        self.assertTrue(marker.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
