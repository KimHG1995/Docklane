#!/usr/bin/env python3
"""Offline quorum rebuild on an owned, stopped disposable restoration copy only."""
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
RESTORE = 'docklane-or-trust-restore'
HEX_ID = re.compile(r'[a-f0-9]{64}\Z')


class RecoveryError(RuntimeError):
    pass


def read_record(path, limit=1024):
    if path.is_symlink() or not path.is_file():
        raise RecoveryError('recovery evidence missing or unsafe')
    with path.open() as source:
        text = source.read(limit + 1)
    if len(text) > limit:
        raise RecoveryError('recovery evidence too large')
    return text.strip()


def validate_restore(docker, log, rid, ca):
    if not HEX_ID.fullmatch(rid) or not HEX_ID.fullmatch(ca):
        raise RecoveryError('full restore ID and root CA fingerprint required')
    own = log / 'ownership-trust-key'
    if own.is_symlink() or read_record(own / (RESTORE + '.container-id')) != rid:
        raise RecoveryError('restore ownership mismatch')
    originals = read_record(log / 'original-managers.ids').splitlines()
    if (len(originals) != 3 or len(set(originals)) != 3 or rid in originals
            or any(not HEX_ID.fullmatch(value) for value in originals)):
        raise RecoveryError('three original full manager IDs required')
    # Nonexistence must be confirmed by the strict Docker adapter, not inferred
    # from an inaccessible daemon, name reuse or a failed read.
    for original in originals:
        if docker.inspect_resource('container', original) is not None:
            raise RecoveryError('an original manager still exists')
    value = docker.inspect_resource('container', rid)
    if not isinstance(value, dict):
        raise RecoveryError('restored container unavailable')
    state, host = value.get('State', {}), value.get('HostConfig', {})
    if (value.get('Id') != rid or value.get('Name') != '/' + RESTORE
            or not isinstance(host, dict) or host.get('PidMode') not in ('', 'private')
            or not isinstance(state, dict) or state.get('Running') is not False
            or state.get('Paused') is not False or state.get('Restarting') is not False
            or state.get('Dead') is not False
            or not isinstance(value.get('Image'), str)
            or re.fullmatch(r'sha256:[a-f0-9]{64}', value['Image']) is None):
        raise RecoveryError('restore must be the owned stopped private container')
    return value['Image']


def load_backend():
    spec = importlib.util.spec_from_file_location('cold_ownership_backend', HERE / 'unlock-quorum-probe.py')
    backend = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(backend)
    return backend


def main():
    os.umask(0o077)
    backend = load_backend()
    log = Path(os.environ.get('DOCKLANE_OR_LOG_DIR', '/tmp/docklane-operational-readiness'))
    owner = backend.Probe(log / 'offline-helper')
    docker = owner.docker
    result = {'status': 'not-established', 'single_backup_acceptance': False}
    began = False
    try:
        owner.require_local_host()
        if sys.argv[1:] == ['--cleanup-only']:
            return 0 if owner.cleanup() else 1
        if len(sys.argv) != 3:
            raise RecoveryError('expected restore ID and CA fingerprint')
        helper = Path(os.environ.get('DOCKLANE_OR_COLD_HELPER', ''))
        if (not helper.is_absolute() or helper.is_symlink() or not helper.is_file()
                or not os.access(helper, os.X_OK) or any(char in str(helper) for char in ',:\n')):
            raise RecoveryError('validated static recovery helper required')
        if owner.own.is_symlink() or owner.own.exists() and any(owner.own.iterdir()):
            raise RecoveryError('previous helper ownership requires cleanup-only')
        key = sys.stdin.buffer.read(257)
        if len(key) > 256 or re.fullmatch(rb'SWMKEY-1-[A-Za-z0-9+/]{43}\n?', key) is None:
            raise RecoveryError('invalid key input')
        rid, ca = sys.argv[1:]
        image = validate_restore(docker, log, rid, ca)
        # Reuse a now-free allowed name, NOT the original manager ID, image state
        # or network. Only the stopped restore volume is mounted into this helper.
        name = backend.NAMES[0]
        docker.absent('container', name)
        began = True
        cid = owner.create_owned(name, [
            'create', '-i', '--name', name, '--hostname', 'offline-quorum-helper',
            '--network', 'none', '--read-only', '--cap-drop', 'ALL',
            '--tmpfs', '/tmp:rw,nosuid,noexec', '--volumes-from', rid,
            '--mount', f'type=bind,src={helper},dst=/docklane-offline-helper,readonly',
            '-e', 'DOCKLANE_OR_DISPOSABLE_HOST=1', '--entrypoint', 'timeout', image,
            '-s', 'KILL', '40', '/docklane-offline-helper', '--disposable-copy',
            '--state-dir', '/var/lib/docker/swarm', '--root-ca-sha256', ca,
        ], 'create isolated recovery helper', 10)
        # No retry if the create/start/response is ambiguous. The helper also has
        # its own independent inner deadline and uses stdin, never argv, for key.
        status, output, diagnostic = docker.raw(['start', '-a', '-i', cid], seconds=45, payload=key)
        result['helper_exit'] = status
        result['helper_phases'] = [line.removeprefix('[cold-recovery] phase=') for line in diagnostic.splitlines()
                                   if re.fullmatch(r'\[cold-recovery\] phase=node-(new|start|wait|ready|stop)', line)][:8]
        if status != 0:
            raise RecoveryError('offline helper did not complete')
        response = json.loads(output)
        if (not isinstance(response, dict) or response.get('status') != 'offline-quorum-rebuilt'
                or response.get('root_ca_preserved') is not True
                or response.get('single_backup_acceptance') is not False):
            raise RecoveryError('offline helper result invalid')
        state = docker.inspect_resource('container', cid)
        if (state is None or state.get('State', {}).get('Running') is not False
                or state.get('State', {}).get('ExitCode') != 0):
            raise RecoveryError('offline helper exit not confirmed')
        result.update(status='offline-quorum-rebuilt', root_ca_preserved=True,
                      originals_absent=True, restore_was_stopped=True)
    except Exception:
        # Upstream stdout, stderr and exception details are intentionally excluded.
        result['status'] = 'failed'
    finally:
        if sys.argv[1:] != ['--cleanup-only']:
            cleaned = owner.cleanup() if began else True
            result['cleanup_completed'] = cleaned
            owner.publish('offline-rebuild.json', result)
    if result['status'] != 'offline-quorum-rebuilt' or not result.get('cleanup_completed'):
        print('[offline-quorum-rebuild] failed; no continuation', file=sys.stderr)
        return 1
    print('[offline-quorum-rebuild] complete; normal Docker validation still required')
    return 0


if __name__ == '__main__':
    sys.exit(main())
