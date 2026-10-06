#!/usr/bin/env python3
"""Exercise the real snapshot, parser and resume gate; only Docker is simulated."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('unlock_quorum_snapshot', HERE / 'unlock-quorum-probe.py')
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)
CID = 'a' * 64
TARGET = PROBE.NAMES[0]
STATE = {'LocalNodeState': 'pending', 'StateSource': 'ping-swarm-header'}
RAW_STACK = '''goroutine 1 [chan receive]:
github.com/docker/docker/daemon/cluster.(*Cluster).UnlockSwarm(0xcafebabe, SWMKEY-1-secret)
    /go/src/swarm.go:350 +0xabc

goroutine 2 [select]:
github.com/moby/swarmkit/v2/manager/state/raft.WaitForLeader(SWMTKN-1-secret)
    /go/src/util.go:52 +0xabc
github.com/moby/swarmkit/v2/manager.(*Manager).Run(0xcafebabe)
    /go/src/manager.go:609 +0xabc
-----BEGIN PRIVATE KEY-----
private-content
'''


class SnapshotDocker(PROBE.Docker):
    def __init__(self, state=None, state_exit=0, signal_exit=0, reads=None, metadata=None):
        self.state = json.dumps(STATE) if state is None else state
        self.state_exit = state_exit
        self.signal_exit = signal_exit
        self.reads = [(0, RAW_STACK)] if reads is None else list(reads)
        self.metadata = metadata or {'Id': CID, 'Name': '/' + TARGET, 'HostConfig': {'PidMode': ''}}
        self.calls = []
        self.clock = None
        self.delays = {}

    def raw(self, args, seconds=10, payload=None):
        if args[0] == 'inspect':
            label, result = 'ownership', (0, json.dumps(self.metadata), '')
        elif 'info' in args or '/usr/local/bin/docklane-local-swarm-status' in args:
            label, result = 'state', (self.state_exit, self.state, 'SWMKEY-1-secret')
        elif 'kill -USR1' in args[-1]:
            label, result = 'signal', (self.signal_exit, '', 'SWMKEY-1-secret')
        else:
            if 'goroutine-stacks-' not in args[-1]:
                raise AssertionError(f'unexpected Docker call: {args}')
            label = 'read'
            code, text = self.reads.pop(0) if len(self.reads) > 1 else self.reads[0]
            result = (code, text, 'SWMTKN-1-secret')
        self.calls.append((label, seconds, args))
        if self.clock is not None:
            delay = self.delays.get(label, 0)
            self.clock[0] += min(seconds, delay)
            if delay >= seconds:
                raise subprocess.TimeoutExpired(['docker', 'synthetic-secret'], seconds)
        return result


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def probe(self, docker):
        result = PROBE.Probe(self.root, docker)
        result.ids[TARGET] = CID
        return result

    def saved(self):
        path = self.root / 'unlock-quorum-probe.json'
        self.assertTrue(path.exists(), 'snapshot evidence was not persisted before the resume gate')
        value = json.loads(path.read_text())
        self.assertIn('snapshot', value, 'partial evidence disappeared from the final report')
        return value

    def snapshot(self, probe):
        # Convert the original early abort into a focused regression assertion.
        try:
            return probe.snapshot(TARGET)
        except (PROBE.ProbeError, ValueError, RecursionError) as error:
            self.fail(f'snapshot lost independently collectable evidence: {error}')

    def test_local_state_timeout_keeps_separate_stacks_but_cannot_resume(self):
        docker = SnapshotDocker(state_exit=137)
        probe = self.probe(docker)
        state, stacks = self.snapshot(probe)
        self.assertEqual(state, {})  # Failed command stdout cannot authorize resume.
        self.assertEqual(len(stacks), 2)
        self.assertEqual([call[0] for call in docker.calls], ['ownership', 'state', 'signal', 'read'])
        evidence = self.saved()['snapshot']
        self.assertEqual(evidence['status'], 'partial')
        self.assertEqual(evidence['state'], 'unknown')
        self.assertIsNone(evidence['control_available'])
        self.assertEqual(evidence['state_probe'], 'unavailable')
        self.assertEqual(evidence['stack_probe'], 'collected')
        self.assertEqual(evidence['stacks'], stacks)
        attempt, resume = Mock(), Mock()
        with self.assertRaises(PROBE.ProbeError):
            PROBE.resume_pending_unlock(attempt, lambda: (state, stacks), resume, Mock())
        resume.assert_not_called()
        attempt.finish.assert_not_called()

    def test_malformed_or_incomplete_state_keeps_stack_evidence(self):
        for raw in ('not json SWMKEY-1-secret', 'null', '[]', '"text"', '{}',
                    '{"LocalNodeState":"pending"}',
                    '{"LocalNodeState":[],"ControlAvailable":true}',
                    '{"LocalNodeState":"pending","ControlAvailable":"true"}',
                    '{"LocalNodeState":"unexpected","ControlAvailable":true}',
                    '[' * 2000 + ']' * 2000):
            with self.subTest(raw=raw[:80]):
                state, stacks = self.snapshot(self.probe(SnapshotDocker(state=raw)))
                self.assertEqual(state, {})
                self.assertEqual(len(stacks), 2)
                self.assertEqual(self.saved()['snapshot']['status'], 'partial')

    def test_valid_snapshot_preserves_strict_resume_path_and_omits_secrets(self):
        probe = self.probe(SnapshotDocker(state=json.dumps(dict(STATE, Error='SWMKEY-1-secret'))))
        state, stacks = self.snapshot(probe)
        self.assertEqual(state, STATE)
        self.assertEqual(self.saved()['snapshot']['status'], 'collected')
        self.assertEqual(stacks[0]['frames'][0]['file'], 'swarm.go')
        self.assertEqual(stacks[1]['frames'][0]['line'], 52)
        serialized = json.dumps(self.saved())
        for secret in ('SWMKEY-', 'SWMTKN-', 'PRIVATE KEY', '0xcafebabe', '/go/src'):
            self.assertNotIn(secret, serialized)
        attempt, resume = Mock(), Mock()
        value = PROBE.resume_pending_unlock(attempt, lambda: (state, stacks), resume, Mock())
        self.assertFalse(value['single_backup_acceptance'])
        resume.assert_called_once_with()
        attempt.finish.assert_called_once_with()

    def test_signal_failure_does_not_read_a_stale_stack(self):
        docker = SnapshotDocker(signal_exit=1)
        state, stacks = self.snapshot(self.probe(docker))
        self.assertEqual(state, STATE)
        self.assertEqual(stacks, [])
        self.assertEqual([call[0] for call in docker.calls], ['ownership', 'state', 'signal'])
        self.assertEqual(self.saved()['snapshot']['stack_probe'], 'signal-failed')
        self.assertEqual(self.saved()['snapshot']['status'], 'partial')

    def test_empty_or_failed_reads_preserve_state_and_stop_after_three_attempts(self):
        for read in ((1, RAW_STACK), (0, ''), (0, 'goroutine malformed [select]:')):
            with self.subTest(read=read):
                docker = SnapshotDocker(reads=[read])
                with patch.object(PROBE.time, 'sleep'):
                    state, stacks = self.snapshot(self.probe(docker))
                self.assertEqual(state, STATE)
                self.assertEqual(stacks, [])
                self.assertEqual(sum(call[0] == 'read' for call in docker.calls), 3)
                self.assertEqual(self.saved()['snapshot']['status'], 'partial')

    def test_snapshot_commands_share_a_deadline_instead_of_renewing_timeouts(self):
        clock = [0]
        docker = SnapshotDocker()
        docker.clock = clock
        docker.delays = {'state': 20, 'signal': 1, 'read': 20}
        with patch.object(PROBE.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(PROBE.time, 'sleep', side_effect=lambda value: clock.__setitem__(0, clock[0] + value)):
            self.snapshot(self.probe(docker))
        self.assertLessEqual(clock[0], 10.001)
        self.assertTrue(all(0 < seconds <= 4 for _, seconds, _ in docker.calls))
        self.assertEqual(self.saved()['snapshot']['status'], 'partial')
        self.assertEqual(self.saved()['snapshot']['stacks'], [])

    def test_expired_unlock_after_snapshot_never_resumes_and_retains_evidence(self):
        probe = self.probe(SnapshotDocker())
        attempt = object.__new__(PROBE.UnlockAttempt)
        attempt.started = 0
        attempt.process = Mock()
        attempt.process.poll.return_value = None
        resume = Mock()
        clock = [0]

        def snapshot():
            result = probe.snapshot(TARGET)
            clock[0] = 21  # Less than the unchanged ten-second resume reserve.
            return result

        with patch.object(PROBE.time, 'monotonic', side_effect=lambda: clock[0]):
            with self.assertRaisesRegex(PROBE.ProbeError, 'budget'):
                PROBE.resume_pending_unlock(attempt, snapshot, resume, Mock())
        resume.assert_not_called()
        self.assertEqual(len(self.saved()['snapshot']['stacks']), 2)
        self.assertFalse(self.saved()['single_backup_acceptance'])

    def test_ownership_failure_never_queries_state_or_signals(self):
        docker = SnapshotDocker(metadata={'Id': CID, 'Name': '/wrong', 'HostConfig': {'PidMode': ''}})
        with self.assertRaises(PROBE.ProbeError):
            self.probe(docker).snapshot(TARGET)
        self.assertEqual([call[0] for call in docker.calls], ['ownership'])

    def test_transient_read_failure_can_collect_without_repeating_unlock(self):
        docker = SnapshotDocker(reads=[(1, ''), (0, RAW_STACK)])
        with patch.object(PROBE.time, 'sleep'):
            state, stacks = self.snapshot(self.probe(docker))
        self.assertEqual(state, STATE)
        self.assertEqual(PROBE.pending_evidence(state, stacks)['waits_in_separate_stacks'], True)
        self.assertEqual(sum(call[0] == 'read' for call in docker.calls), 2)
        self.assertEqual(self.saved()['snapshot']['stack_probe'], 'collected')
        for _, _, args in docker.calls:
            self.assertNotIn('unlock', args)
            self.assertNotIn('unpause', args)

    def test_main_failure_retains_snapshot_and_runs_cleanup(self):
        probe = self.probe(SnapshotDocker(state_exit=137))
        attempt, resume = Mock(), Mock()

        def execute():
            PROBE.resume_pending_unlock(attempt, lambda: probe.snapshot(TARGET), resume, Mock())

        with patch.object(PROBE, 'Probe', return_value=probe), \
                patch.object(probe, 'execute', side_effect=execute), \
                patch.object(probe, 'cleanup', return_value=True) as cleanup, \
                patch.object(PROBE.sys, 'argv', ['probe']), patch.object(PROBE.signal, 'signal'), \
                patch.object(PROBE.os, 'umask'):
            self.assertEqual(PROBE.main(), 1)
        cleanup.assert_called_once_with()
        resume.assert_not_called()
        self.assertEqual(self.saved()['status'], 'failed')
        self.assertTrue(self.saved()['cleanup_completed'])
        self.assertEqual(len(self.saved()['snapshot']['stacks']), 2)


    def test_snapshot_uses_local_ping_instead_of_quorum_info(self):
        docker = SnapshotDocker()
        state, stacks = self.snapshot(self.probe(docker))
        self.assertEqual(state, STATE)
        self.assertEqual(PROBE.pending_evidence(state, stacks)['state_source'], 'ping-swarm-header')
        self.assertIsNone(self.saved()['snapshot']['control_available'])
        calls = [args for _, _, args in docker.calls]
        self.assertTrue(any('/usr/local/bin/docklane-local-swarm-status' in args for args in calls))
        self.assertTrue(all('info' not in args for args in calls))

    def test_info_shaped_state_cannot_authorize_peer_resume(self):
        _, stacks = self.snapshot(self.probe(SnapshotDocker()))
        old_state = {'LocalNodeState': 'pending', 'ControlAvailable': True}
        resume = Mock()
        with self.assertRaises(PROBE.ProbeError):
            PROBE.resume_pending_unlock(Mock(), lambda: (old_state, stacks), resume, Mock())
        resume.assert_not_called()

    def test_nonpending_state_or_wrong_provenance_is_never_approved(self):
        _, stacks = self.snapshot(self.probe(SnapshotDocker()))
        for state in ({}, dict(STATE, StateSource='info'), dict(STATE, StateSource=''),
                      *(dict(STATE, LocalNodeState=value) for value in
                        ('inactive', 'error', 'locked', 'active/worker', 'active/manager', 'unknown'))):
            with self.subTest(state=state):
                resume = Mock()
                with self.assertRaises(PROBE.ProbeError):
                    PROBE.resume_pending_unlock(Mock(), lambda: (state, stacks), resume, Mock())
                resume.assert_not_called()

    def test_function_names_without_wait_states_do_not_authorize_resume(self):
        state, stacks = self.snapshot(self.probe(SnapshotDocker()))
        for index in (0, 1):
            changed = json.loads(json.dumps(stacks))
            changed[index]['state'] = 'running'
            with self.subTest(index=index), self.assertRaises(PROBE.ProbeError):
                PROBE.pending_evidence(state, changed)


    def test_leader_wait_without_manager_run_is_not_enough(self):
        state, stacks = self.snapshot(self.probe(SnapshotDocker()))
        stacks[1]['frames'] = stacks[1]['frames'][:1]
        with self.assertRaises(PROBE.ProbeError):
            PROBE.pending_evidence(state, stacks)


if __name__ == '__main__':
    unittest.main(verbosity=2)
