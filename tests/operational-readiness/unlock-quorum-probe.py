#!/usr/bin/env python3
"""Opt-in disposable experiment, NOT single-backup recovery acceptance.

Compare a follower restart with quorum against the same restart with paused
peers. Restore peers only while the one bounded unlock is still in flight.
Raw command output stays in anonymous files; keys are never published.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
NAMES = tuple(f'docklane-or-manager-{i:02d}' for i in range(1, 4))
NETWORK = 'docklane-or-manager-net'
IMAGE = 'docker:28-dind@sha256:2a232a42256f70d78e3cc5d2b5d6b3276710a0de0596c145f627ecfae90282ac'
UNLOCK_SECONDS = 30
SNAPSHOT_SECONDS = 10
LOCAL_STATE_HELPER = '/usr/local/bin/docklane-local-swarm-status'
STATE_SOURCE = 'ping-swarm-header'
HEX_ID = re.compile(r'[a-f0-9]{64}\Z')


class ProbeError(RuntimeError):
    pass


def pending_evidence(state, stacks):
    """Classify normalized parser output, never publish arbitrary daemon fields."""
    unlock = {i for i, stack in enumerate(stacks) if stack.get('state') == 'chan receive' and any(
        f.get('function') == 'github.com/docker/docker/daemon/cluster.(*Cluster).UnlockSwarm'
        for f in stack.get('frames', []))}
    leader = {i for i, stack in enumerate(stacks) if stack.get('state') == 'select' and any(
        f.get('function') == 'github.com/moby/swarmkit/v2/manager/state/raft.WaitForLeader'
        for f in stack.get('frames', [])) and any(
        f.get('function') == 'github.com/moby/swarmkit/v2/manager.(*Manager).Run'
        for f in stack.get('frames', []))}
    if (state.get('LocalNodeState') != 'pending' or state.get('StateSource') != STATE_SOURCE
            or not unlock or not leader or unlock & leader):
        raise ProbeError('expected separate pending-unlock and leader-wait evidence was not established')
    # Ping reports local node state, not ControlAvailable. Manager startup is
    # witnessed independently by the selected WaitForLeader stack.
    return {'state': 'pending', 'control_available': None, 'state_source': STATE_SOURCE,
            'unlock_wait_observed': True, 'leader_wait_observed': True,
            'waits_in_separate_stacks': True}


def resume_pending_unlock(attempt, snapshot, resume_peers, publish):
    attempt.require_live(16)
    state, stacks = snapshot()
    evidence = pending_evidence(state, stacks)
    publish(evidence)
    # Diagnostics consume the SAME request budget. Never resume after expiry.
    attempt.require_live(10)
    resume_peers()
    attempt.finish()
    return {'status': 'quorum-restored-same-unlock', 'single_backup_acceptance': False}


class Docker:
    @staticmethod
    def raw(args, seconds=10, payload=None):
        with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            try:
                process = subprocess.Popen(['docker', *args], stdin=subprocess.PIPE,
                                           stdout=out, stderr=err, start_new_session=True)
            except OSError:
                raise ProbeError('Docker command could not start') from None
            try:
                process.communicate(input=payload, timeout=seconds)
            except BaseException:
                Docker.kill(process)
                raise
            if out.tell() > 2_000_000 or err.tell() > 2_000_000:
                raise ProbeError('Docker response exceeded diagnostic limit')
            out.seek(0)
            err.seek(0)
            return process.returncode, out.read().decode(errors='replace'), err.read().decode(errors='replace')

    @staticmethod
    def kill(process):
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.wait()

    def call(self, args, label, seconds=10):
        try:
            status, out, _ = self.raw(args, seconds)
        except subprocess.TimeoutExpired:
            raise ProbeError(f'{label}: command deadline exceeded') from None
        if status != 0:
            raise ProbeError(f'{label}: command failed (exit {status})')
        return out.strip()

    def absent(self, kind, name):
        args = (['inspect', '--type', 'container', name] if kind == 'container'
                else ['network', 'inspect', name])
        try:
            status, _, error = self.raw(args)
        except subprocess.TimeoutExpired:
            raise ProbeError('preflight inspect timed out') from None
        allowed = {f'Error: No such {kind}: {name}',
                   f'Error response from daemon: No such {kind}: {name}'}
        if kind == 'network':
            allowed.add(f'Error response from daemon: network {name} not found')
            allowed.add(f'Error: No such network: {name}')
        if status != 1 or error.strip() not in allowed:
            raise ProbeError(f'preflight cannot confirm absent {kind}')

    def inner(self, cid, args, label, seconds=5):
        return self.call(['exec', '-i', cid, 'timeout', '-s', 'KILL', str(seconds),
                          'docker', *args], label, seconds + 2)


class UnlockAttempt:
    def __init__(self, cid, key):
        self.started = time.monotonic()
        self.output = tempfile.TemporaryFile()
        self.process = None
        try:
            self.process = subprocess.Popen(
                ['docker', 'exec', '-i', cid, 'timeout', '-s', 'KILL',
                 str(UNLOCK_SECONDS), 'docker', 'swarm', 'unlock'],
                stdin=subprocess.PIPE, stdout=self.output, stderr=self.output,
                start_new_session=True)
            self.process.stdin.write((key + '\n').encode())
            self.process.stdin.close()
        except BaseException:
            self.close()
            raise ProbeError('unlock request could not start') from None

    def remaining(self):
        return UNLOCK_SECONDS - (time.monotonic() - self.started)

    def require_live(self, reserve):
        if self.process.poll() is not None or self.remaining() < reserve:
            raise ProbeError('unlock no longer live with sufficient budget; no peer resume or resend')

    def finish(self):
        try:
            status = self.process.wait(timeout=max(0.01, self.remaining() + 2))
        except subprocess.TimeoutExpired:
            raise ProbeError('unlock deadline exceeded; no resend') from None
        if status != 0:
            raise ProbeError(f'unlock failed (exit {status}); no resend')

    def close(self):
        if self.process is not None:
            Docker.kill(self.process)
            if self.process.stdin is not None:
                self.process.stdin.close()
        self.output.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class Probe:
    def __init__(self, log, docker=None):
        self.log = Path(log)
        self.own = self.log / 'ownership-trust-key'
        self.docker = docker or Docker()
        self.ids = {}
        self.network_id = None
        self.report = {'schema': 1, 'status': 'not-established',
                       'single_backup_acceptance': False, 'image': IMAGE}

    def publish(self, name, value):
        self.log.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode='w', dir=self.log, delete=False) as out:
            temporary = Path(out.name)
            json.dump(value, out, indent=2, sort_keys=True)
            out.write('\n')
        temporary.replace(self.log / name)

    def owned(self, name, seconds=10):
        cid = self.ids[name]
        if not HEX_ID.fullmatch(cid):
            raise ProbeError('invalid container ownership ID')
        value = json.loads(self.docker.call(
            ['inspect', '--type', 'container', '--format', '{{json .}}', cid], 'ownership', seconds))
        if (value.get('Id') != cid or value.get('Name') != '/' + name
                or value.get('HostConfig', {}).get('PidMode') not in ('', 'private')):
            raise ProbeError('container ownership or private PID namespace mismatch')
        return cid

    def cli(self, name, args, label, seconds=5):
        return self.docker.inner(self.owned(name), args, label, seconds)

    def wait(self, check, label, seconds=90):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                value = check()
                if value:
                    return value
            except ProbeError:
                pass
            time.sleep(1)
        raise ProbeError(label + ': readiness deadline exceeded')

    def topology(self):
        text = self.cli(NAMES[0], ['node', 'ls', '--format',
            '{{.Hostname}}|{{.Status}}|{{.Availability}}|{{.ManagerStatus}}'], 'topology')
        rows = [line.split('|') for line in text.splitlines()]
        expected = {f'manager-{i:02d}' for i in range(1, 4)}
        if (len(rows) != 3 or any(len(row) != 4 for row in rows)
                or {row[0] for row in rows} != expected
                or any(row[1:3] != ['Ready', 'Active'] for row in rows)
                or sum(row[3] == 'Leader' for row in rows) != 1
                or sum(row[3] == 'Reachable' for row in rows) != 2):
            return None
        return rows

    def locked(self, target):
        self.wait(lambda: self.cli(target, ['version', '--format', '{{.Server.Version}}'], 'daemon'), 'daemon')
        self.wait(lambda: self.cli(target, ['info', '--format', '{{.Swarm.LocalNodeState}}'], 'locked') == 'locked', 'locked')

    def snapshot(self, target):
        spec = importlib.util.spec_from_file_location('recovery_diagnostics', HERE / 'recovery-diagnostics.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        deadline = time.monotonic() + SNAPSHOT_SECONDS

        def budget():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProbeError('snapshot diagnostic budget exhausted')
            return min(4, remaining)

        # Ownership is still mandatory; unavailable Swarm state is not ownership.
        cid = self.owned(target, seconds=budget())

        def collect(args, label):
            return self.docker.call(
                ['exec', cid, 'timeout', '-s', 'KILL', '3', *args], label, budget())

        state, stacks = {}, []
        state_probe = 'unavailable'
        try:
            # /_ping -> Cluster.Status reads the node runner locally. /info also
            # queries Raft-backed cluster/nodes and can block without quorum.
            value = json.loads(collect([LOCAL_STATE_HELPER], 'local Swarm status'))
            if (isinstance(value, dict)
                    and value.get('LocalNodeState') in ('inactive', 'pending', 'error', 'locked', 'active/worker', 'active/manager')
                    and value.get('StateSource') == STATE_SOURCE):
                state = {key: value[key] for key in ('LocalNodeState', 'StateSource')}
                state_probe = 'collected'
            else:
                state_probe = 'invalid-shape'
        except ProbeError:
            pass  # A timed-out read must not prevent independent stack capture.
        except (ValueError, RecursionError):
            state_probe = 'invalid-json'

        stack_probe = 'signal-failed'
        try:
            collect(['sh', '-c', module.STACK_SIGNAL], 'stack signal')
        except ProbeError:
            pass  # Without a successful signal, do not consume a stale dump.
        else:
            stack_probe = 'unavailable'
            for attempt in range(3):
                if time.monotonic() >= deadline:
                    break
                try:
                    raw = collect(['sh', '-c', module.STACK_READ], 'stack read')
                    stacks = module.stack_summary(raw)
                    if stacks:
                        stack_probe = 'collected'
                        break
                except ProbeError:
                    pass
                if attempt < 2:
                    time.sleep(min(0.1, max(0, deadline - time.monotonic())))

        # Persist before the strict resume gate can reject unknown/partial data.
        # Only allowlisted state and the existing argument-free parser survive.
        self.report['snapshot'] = {
            'status': 'collected' if state and stacks else 'partial',
            'state': state.get('LocalNodeState', 'unknown'),
            'control_available': None,  # Not returned by the local ping endpoint.
            'state_source': state.get('StateSource'),
            'state_probe': state_probe, 'stack_probe': stack_probe,
            'budget_exhausted': time.monotonic() >= deadline,
            'stacks': stacks,
        }
        self.publish('unlock-quorum-probe.json', self.report)
        return state, stacks

    def require_local_host(self):
        if sys.platform != 'linux' or os.environ.get('DOCKLANE_OR_DISPOSABLE_HOST') != '1':
            raise ProbeError('requires explicit disposable Linux Docker host opt-in')
        if os.environ.get('DOCKER_CONTEXT'):
            raise ProbeError('Docker context override is not permitted for this disposable probe')
        endpoint = os.environ.get('DOCKER_HOST', '')
        if endpoint and not endpoint.startswith('unix://'):
            raise ProbeError('probe requires a local Unix Docker endpoint')
        if not endpoint:
            endpoint = self.docker.call(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], 'Docker endpoint')
            if not endpoint.startswith('unix://'):
                raise ProbeError('probe requires a local Unix Docker endpoint')

    def execute(self):
        self.require_local_host()
        helper = Path(os.environ.get('DOCKLANE_OR_LOCAL_STATE_HELPER', ''))
        if (not helper.is_absolute() or ':' in str(helper) or helper.is_symlink()
                or not helper.is_file() or not os.access(helper, os.X_OK)):
            raise ProbeError('build and provide an executable local Swarm status helper')
        if self.own.is_symlink():
            raise ProbeError('ownership directory must not be a symlink')
        if self.own.exists() and any(self.own.iterdir()):
            raise ProbeError('existing ownership must be cleaned up before starting another probe')
        if self.docker.call(['info', '--format', '{{.Swarm.LocalNodeState}}'], 'host preflight') != 'inactive':
            raise ProbeError('outer Docker host must not be a Swarm member')
        for name in NAMES:
            self.docker.absent('container', name)
        self.docker.absent('network', NETWORK)
        self.docker.call(['pull', IMAGE], 'pinned image pull', 120)
        self.own.mkdir(parents=True, exist_ok=True)
        nid = self.docker.call(['network', 'create', NETWORK], 'network create')
        if not HEX_ID.fullmatch(nid):
            raise ProbeError('invalid created network ID')
        self.network_id = nid
        (self.own / 'manager-network.network-id').write_text(nid + '\n')
        addresses = {}
        for i, name in enumerate(NAMES, 1):
            cid = self.docker.call(['create', '--privileged', '--name', name,
                '--hostname', f'manager-{i:02d}', '--network', NETWORK,
                '-e', 'DOCKER_TLS_CERTDIR=', IMAGE], 'container create', 30)
            if not HEX_ID.fullmatch(cid):
                raise ProbeError('invalid created container ID')
            self.ids[name] = cid
            (self.own / f'{name}.container-id').write_text(cid + '\n')
            self.docker.call(['start', self.owned(name)], 'container start')
            self.wait(lambda: self.cli(name, ['version', '--format', '{{.Server.Version}}'], 'daemon') == '28.5.2', 'pinned Engine')
            addresses[name] = self.docker.call(['inspect', '--format',
                '{{with index .NetworkSettings.Networks "' + NETWORK + '"}}{{.IPAddress}}{{end}}', cid], 'address')
        self.cli(NAMES[0], ['swarm', 'init', '--autolock', '--advertise-addr', addresses[NAMES[0]]], 'init', 30)
        key = self.cli(NAMES[0], ['swarm', 'unlock-key', '-q'], 'unlock key')
        if not re.fullmatch(r'SWMKEY-1-[A-Za-z0-9+/]{43}', key):
            raise ProbeError('unlock key encoding invalid')
        token = self.cli(NAMES[0], ['swarm', 'join-token', '-q', 'manager'], 'manager token')
        for name in NAMES[1:]:
            self.cli(name, ['swarm', 'join', '--token', token, '--advertise-addr',
                           addresses[name], addresses[NAMES[0]] + ':2377'], 'join', 30)
        rows = self.wait(self.topology, 'initial topology')
        target = 'docklane-or-' + next(row[0] for row in rows if row[3] == 'Reachable')
        peers = [name for name in NAMES if name != target]
        # Install before the restart/unlock experiment; never into the host.
        self.docker.call(['cp', str(helper), self.owned(target) + ':' + LOCAL_STATE_HELPER],
                         'install local Swarm status helper')
        cluster = self.cli(target, ['info', '--format', '{{.Swarm.Cluster.ID}}'], 'cluster identity')
        if not cluster:
            raise ProbeError('cluster identity missing')
        self.docker.call(['restart', self.owned(target)], 'baseline restart', 35)
        self.locked(target)
        with UnlockAttempt(self.owned(target), key) as attempt:
            attempt.finish()
        self.wait(self.topology, 'baseline topology')
        self.report.update(with_quorum_unlock='completed', engine_version='28.5.2')
        self.publish('unlock-quorum-probe.json', self.report)
        self.docker.call(['pause', *(self.owned(peer) for peer in peers)], 'pause existing peers')
        self.docker.call(['restart', self.owned(target)], 'isolated restart', 35)
        self.locked(target)
        peer_ids = [self.owned(peer) for peer in peers]
        with UnlockAttempt(self.owned(target), key) as attempt:
            time.sleep(3)
            outcome = resume_pending_unlock(
                attempt, lambda: self.snapshot(target),
                lambda: self.docker.call(['unpause', *peer_ids], 'resume existing peers', 8),
                lambda value: self.publish('unlock-quorum-pending.json', value))
            self.report['isolated_unlock_elapsed_seconds'] = round(time.monotonic() - attempt.started, 3)
            self.report['isolated_unlock_attempts'] = 1
        self.wait(self.topology, 'restored topology')
        if self.cli(target, ['info', '--format', '{{.Swarm.Cluster.ID}}'], 'restored cluster') != cluster:
            raise ProbeError('cluster identity changed')
        if self.cli(target, ['swarm', 'unlock-key', '-q'], 'unchanged unlock key') != key:
            raise ProbeError('autolock key changed')
        self.report.update(outcome, cluster_identity_preserved=True, unlock_key_preserved=True,
                           same_pending_unlock_completed=True, force_new_cluster_sent=False)

    def load_ownership(self):
        # For the workflow's always-cleanup step after interruption. Do not
        # discover by name or delete malformed/untrusted marker contents.
        if self.own.is_symlink():
            raise ProbeError('ownership directory must not be a symlink')
        self.ids = {}
        self.network_id = None
        for name, suffix in [*((name, 'container-id') for name in NAMES),
                             ('manager-network', 'network-id')]:
            marker = self.own / f'{name}.{suffix}'
            if marker.is_symlink():
                raise ProbeError('ownership marker must not be a symlink')
            if not marker.exists():
                continue
            with marker.open() as source:
                value = source.read(256).strip()
            if not HEX_ID.fullmatch(value):
                raise ProbeError('invalid ownership marker')
            if suffix == 'network-id':
                self.network_id = value
            else:
                self.ids[name] = value

    def cleanup(self):
        failed = False
        for name in reversed(NAMES):
            if name not in self.ids:
                continue
            try:
                self.docker.call(['rm', '-fv', self.owned(name)], 'owned container cleanup', 20)
                (self.own / f'{name}.container-id').unlink(missing_ok=True)
            except (ProbeError, OSError, ValueError):
                failed = True  # Preserve ID for an explicit cleanup retry.
        if self.network_id is not None:
            try:
                current = self.docker.call(['network', 'inspect', '--format', '{{.Id}}', self.network_id], 'network ownership')
                if current != self.network_id:
                    raise ProbeError('network ownership mismatch')
                self.docker.call(['network', 'rm', self.network_id], 'owned network cleanup')
                (self.own / 'manager-network.network-id').unlink(missing_ok=True)
            except (ProbeError, OSError, ValueError):
                failed = True
        return not failed


def main():
    os.umask(0o077)
    probe = Probe(os.environ.get('DOCKLANE_OR_LOG_DIR', '/tmp/docklane-unlock-quorum-probe'))
    if sys.argv[1:] == ['--cleanup-only']:
        if os.environ.get('DOCKLANE_OR_DISPOSABLE_HOST') != '1':
            return 1
        try:
            probe.require_local_host()
            probe.load_ownership()
            return 0 if probe.cleanup() else 1
        except (ProbeError, OSError, ValueError):
            print('[unlock-quorum-probe] cleanup incomplete; ownership preserved', file=sys.stderr)
            return 1
    if sys.argv[1:]:
        print('usage: unlock-quorum-probe.py [--cleanup-only]', file=sys.stderr)
        return 2

    def interrupted(*_):
        raise ProbeError('probe interrupted; no recovery continuation')

    signal.signal(signal.SIGTERM, interrupted)
    success = False
    try:
        probe.execute()
        success = True
    except ProbeError as error:
        probe.report.update(status='failed', failure=str(error))
    except (Exception, KeyboardInterrupt):
        # No traceback: third-party response/arguments can contain credentials.
        probe.report.update(status='failed', failure='probe interrupted or unexpected local error')
    finally:
        cleaned = probe.cleanup()
        probe.report['cleanup_completed'] = cleaned
        probe.publish('unlock-quorum-probe.json', probe.report)
    print('[unlock-quorum-probe] ' + probe.report['status'])
    return 0 if success and cleaned else 1


if __name__ == '__main__':
    sys.exit(main())
