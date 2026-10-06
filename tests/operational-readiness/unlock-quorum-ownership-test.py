#!/usr/bin/env python3
"""Exercise real probe/CLI timeouts against a persistent, isolated fake Docker."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('ownership_probe', HERE / 'unlock-quorum-probe.py')
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)
RUN_LABEL = 'io.docklane.quorum-probe.run'
RESOURCE_LABEL = 'io.docklane.quorum-probe.resource'
CID, NID = 'a' * 64, 'd' * 64

# Mutations persist before their stdout is lost. Every CLI command is a real
# child process, with the probe's original timeout, kill and reap machinery.
ENGINE = r'''
import json, os, sys, time
from pathlib import Path
args = sys.argv[1:]
path = Path(os.environ['FAKE_ENGINE'])
state = json.loads(path.read_text())
state['calls'].append(args)
def save(): path.write_text(json.dumps(state))
def finish(out='', error='', status=0):
    save()
    print(out, end='' if not out else '\n')
    if error: print(error, file=sys.stderr)
    sys.exit(status)
def missing(kind, key): finish(error=f'Error: No such {kind}: {key}', status=1)
def labels():
    return dict(args[i + 1].split('=', 1) for i in range(len(args)-1) if args[i] == '--label')
def fault(operation):
    if state.get('fault') == operation and not state.get('fired'):
        state['fired'] = True
        save()
        time.sleep(30)
if args[0] == 'info': finish('inactive')
if args[0] == 'pull': finish()
if args[0] == 'context': finish('unix:///var/run/docker.sock')
if args[0] == 'inspect' or args[:2] == ['network', 'inspect']:
    kind = 'container' if args[0] == 'inspect' else 'network'
    key = args[-1]
    override = state.get('inspect_error')
    if override:
        finish(error=override['text'].replace('{id}', key), status=override['status'])
    item = next((x for x in state['resources'].values() if x['kind'] == kind and (x['Id'] == key or x['Name'].lstrip('/') == key)), None)
    if item is None: missing(kind, key)
    finish(item['Id'] if '{{.Id}}' in args else json.dumps(item))
if args[:2] in (['container', 'ls'], ['network', 'ls']):
    if state.get('list_error'): finish(error='daemon unavailable', status=1)
    filters = [args[i+1].removeprefix('label=') for i in range(len(args)-1) if args[i] == '--filter']
    items = [x for x in state['resources'].values() if x['kind'] == args[0]]
    for f in filters:
        k, v = f.split('=', 1)
        items = [x for x in items if (x.get('Config', {}).get('Labels') if x['kind'] == 'container' else x.get('Labels', {})).get(k) == v]
    finish('\n'.join(x['Id'] for x in items))
if args[:2] == ['network', 'create'] or args[0] == 'create':
    kind = 'container' if args[0] == 'create' else 'network'
    name = args[args.index('--name') + 1] if kind == 'container' else args[-1]
    rid = 'a' * 64 if kind == 'container' else 'd' * 64
    lab = labels()
    intent_path = Path(os.environ['DOCKLANE_OR_LOG_DIR']) / 'ownership-trust-key' / 'creation.json'
    journal = json.loads(intent_path.read_text()) if intent_path.exists() else None
    state.setdefault('creation_records', []).append({'kind': kind, 'name': name, 'labels': lab, 'journal': journal})
    if not state.get('omit_creation'):
        state['resources'][rid] = {'kind': kind, 'Id': rid, 'Name': ('/' if kind == 'container' else '') + name,
                                  'Config': {'Labels': lab}, 'Labels': lab, 'HostConfig': {'PidMode': ''}}
    fault('create-' + kind)
    finish(rid)
if args[0] == 'rm' or args[:2] == ['network', 'rm']:
    kind = 'container' if args[0] == 'rm' else 'network'
    rid = args[-1]
    if rid not in state['resources']: missing(kind, rid)
    if kind == 'network' and any(x['kind'] == 'container' for x in state['resources'].values()):
        finish(error='network has active endpoints', status=1)
    state['resources'].pop(rid)
    fault('remove-' + kind)
    finish(rid)
finish(error='unexpected Docker operation', status=2)
'''


class FastFaultDocker(PROBE.Docker):
    @staticmethod
    def raw(args, seconds=10, payload=None):
        mutating = args[0] in ('create', 'rm') or args[:2] in (['network', 'create'], ['network', 'rm'])
        return PROBE.Docker.raw(args, min(seconds, 0.5 if mutating else 3), payload)


class OwnershipTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='docklane-owned-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.engine = self.root / 'engine.json'
        self.engine.write_text(json.dumps({'resources': {}, 'calls': []}))
        executable = self.root / 'docker'
        executable.write_text('#!' + sys.executable + ' -S\n' + ENGINE)
        executable.chmod(0o755)
        helper = self.root / 'helper'
        helper.write_text('#!/bin/sh\nexit 0\n')
        helper.chmod(0o755)
        self.log = self.root / 'log'
        env = {'PATH': str(self.root) + os.pathsep + os.environ.get('PATH', ''),
               'FAKE_ENGINE': str(self.engine), 'DOCKLANE_OR_LOG_DIR': str(self.log),
               'DOCKLANE_OR_DISPOSABLE_HOST': '1', 'DOCKER_HOST': 'unix:///var/run/docker.sock',
               'DOCKER_CONTEXT': '', 'DOCKLANE_OR_LOCAL_STATE_HELPER': str(helper)}
        self.patch = patch.dict(os.environ, env)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.probe = PROBE.Probe(self.log, FastFaultDocker())

    def state(self):
        return json.loads(self.engine.read_text())

    def change(self, **values):
        state = self.state()
        state.update(values)
        self.engine.write_text(json.dumps(state))

    def create_loss(self, kind, omit=False):
        self.change(fault='create-' + kind, omit_creation=omit)
        with self.assertRaisesRegex(PROBE.ProbeError, 'deadline exceeded'):
            self.probe.execute()
        return self.state()

    def marker(self, kind):
        name = PROBE.NAMES[0] if kind == 'container' else 'manager-network'
        return self.probe.own / (name + ('.container-id' if kind == 'container' else '.network-id'))

    def seed_legacy(self, kind, exists=True):
        rid = CID if kind == 'container' else NID
        name = PROBE.NAMES[0] if kind == 'container' else PROBE.NETWORK
        if exists:
            self.change(resources={rid: {'kind': kind, 'Id': rid, 'Name': ('/' if kind == 'container' else '') + name,
                                         'Config': {'Labels': {}}, 'Labels': {}, 'HostConfig': {'PidMode': ''}}})
        self.probe.own.mkdir(parents=True, exist_ok=True)
        self.marker(kind).write_text(rid + '\n')
        self.probe.load_ownership()
        return rid

    def test_network_creation_response_loss_is_reconciled_before_cleanup_success(self):
        self.create_loss('network')
        self.assertIn(NID, self.state()['resources'])
        self.assertTrue(self.probe.cleanup())
        self.assertEqual(self.state()['resources'], {}, 'network leaked despite cleanup success')
        self.assertEqual(list(self.probe.own.iterdir()), [])

    def test_container_creation_response_loss_is_reconciled_before_cleanup_success(self):
        self.create_loss('container')
        self.assertIn(CID, self.state()['resources'])
        self.assertTrue(self.probe.cleanup())
        self.assertEqual(self.state()['resources'], {}, 'container leaked despite cleanup success')
        self.assertEqual(list(self.probe.own.iterdir()), [])

    def test_cleanup_only_recovers_creation_intent_after_process_restart(self):
        self.create_loss('network')
        # A different process/object cannot rely on self.ids from creation.
        fresh = PROBE.Probe(self.log, FastFaultDocker())
        fresh.load_ownership()
        self.assertTrue(fresh.cleanup())
        self.assertEqual(self.state()['resources'], {})

    def test_run_labels_and_intent_are_persisted_before_each_create(self):
        self.create_loss('container')
        records = self.state()['creation_records']
        self.assertEqual(len(records), 2)
        for record in records:
            with self.subTest(kind=record['kind']):
                self.assertIsNotNone(record['journal'], 'create had no durable intent')
                self.assertIn(RUN_LABEL, record['labels'])
                self.assertEqual(record['labels'][RUN_LABEL], record['journal']['run_id'])
                self.assertIn(record['name'], record['journal']['resources'])
                self.assertEqual(record['labels'][RESOURCE_LABEL], record['name'])

    def test_unobserved_creation_keeps_intent_and_does_not_claim_absence(self):
        self.create_loss('network', omit=True)
        self.assertEqual(self.state()['resources'], {})
        self.assertFalse(self.probe.cleanup(), 'in-flight creation was incorrectly treated as absent')
        self.assertTrue(any(self.probe.own.iterdir()))
        self.assertEqual(sum(call[:2] == ['network', 'create'] for call in self.state()['calls']), 1)

    def test_unknown_creation_never_deletes_same_name_with_another_run_label(self):
        self.create_loss('network')
        state = self.state()
        state['resources'][NID]['Labels'][RUN_LABEL] = 'e' * 32
        self.engine.write_text(json.dumps(state))
        self.assertFalse(self.probe.cleanup())
        self.assertIn(NID, self.state()['resources'])
        self.assertFalse(any(call[:2] == ['network', 'rm'] for call in self.state()['calls']))

    def test_known_missing_container_and_network_are_idempotent_success(self):
        for kind in ('container', 'network'):
            with self.subTest(kind=kind):
                self.seed_legacy(kind, exists=False)
                self.assertTrue(self.probe.cleanup(), 'exact not-found was not accepted')
                self.assertFalse(self.marker(kind).exists())

    def test_remove_response_loss_is_completed_by_exact_id_not_found_on_retry(self):
        for kind in ('container', 'network'):
            with self.subTest(kind=kind):
                rid = self.seed_legacy(kind)
                self.change(fault='remove-' + kind, fired=False)
                self.assertFalse(self.probe.cleanup())
                self.assertNotIn(rid, self.state()['resources'])
                self.assertTrue(self.marker(kind).exists())
                fresh = PROBE.Probe(self.log, FastFaultDocker())
                fresh.load_ownership()
                self.assertTrue(fresh.cleanup(), 'deletion succeeded but retry failed forever')
                self.assertFalse(self.marker(kind).exists())

    def test_unknown_inspect_failures_keep_legacy_ownership(self):
        self.seed_legacy('container')
        for status, text in ((1, 'Cannot connect to the Docker daemon'), (1, 'permission denied'),
                             (137, 'Error: No such container: {id}'), (1, 'Error: No such container: other'),
                             (1, 'Error: No such container: {id}\npermission denied')):
            with self.subTest(status=status, text=text):
                self.change(inspect_error={'status': status, 'text': text})
                self.assertFalse(self.probe.cleanup())
                self.assertTrue(self.marker('container').exists())
                self.assertIn(CID, self.state()['resources'])

    def test_failure_report_does_not_turn_the_probe_into_a_success(self):
        self.change(fault='create-network')
        with patch.object(PROBE, 'Probe', return_value=self.probe), \
                patch.object(PROBE.sys, 'argv', ['probe']), patch.object(PROBE.signal, 'signal'), \
                patch.object(PROBE.os, 'umask'):
            self.assertEqual(PROBE.main(), 1)
        report = json.loads((self.log / 'unlock-quorum-probe.json').read_text())
        self.assertEqual(report['status'], 'failed')
        self.assertTrue(report['cleanup_completed'])
        self.assertFalse(report['single_backup_acceptance'])
        self.assertEqual(self.state()['resources'], {}, 'report incorrectly declared cleanup complete')

    def test_cleanup_only_entrypoint_recovers_a_lost_creation_response(self):
        self.create_loss('network')
        fresh = PROBE.Probe(self.log, FastFaultDocker())
        with patch.object(PROBE, 'Probe', return_value=fresh), \
                patch.object(PROBE.sys, 'argv', ['probe', '--cleanup-only']), patch.object(PROBE.os, 'umask'):
            self.assertEqual(PROBE.main(), 0)
        self.assertEqual(self.state()['resources'], {})

    def test_creation_discovery_error_preserves_intent_for_a_later_retry(self):
        self.create_loss('network')
        self.change(list_error=True)
        self.assertFalse(self.probe.cleanup())
        self.assertIn(NID, self.state()['resources'])
        self.assertTrue((self.probe.own / 'creation.json').exists())
        self.change(list_error=False)
        self.assertTrue(self.probe.cleanup())
        self.assertEqual(self.state()['resources'], {})

    def test_discovery_labels_do_not_replace_actual_name_verification(self):
        self.create_loss('network')
        state = self.state()
        state['resources'][NID]['Name'] = 'someone-elses-network'
        self.engine.write_text(json.dumps(state))
        self.assertFalse(self.probe.cleanup())
        self.assertIn(NID, self.state()['resources'])
        self.assertFalse(any(call[:2] == ['network', 'rm'] for call in self.state()['calls']))

    def test_creation_journal_survives_a_lost_legacy_marker_write(self):
        self.change(fault='none')
        original = Path.write_text
        marker = self.probe.own / 'manager-network.network-id'
        def write(path, *args, **kwargs):
            if path == marker:
                raise OSError('synthetic marker write failure')
            return original(path, *args, **kwargs)
        with patch.object(Path, 'write_text', write):
            with self.assertRaisesRegex(OSError, 'marker write failure'):
                self.probe.execute()
        self.assertIn(NID, self.state()['resources'])
        fresh = PROBE.Probe(self.log, FastFaultDocker())
        self.assertTrue(fresh.cleanup())
        self.assertEqual(self.state()['resources'], {})

    def test_malformed_and_symlinked_creation_journals_never_authorize_cleanup(self):
        self.probe.own.mkdir(parents=True)
        path = self.probe.own / 'creation.json'
        for text in ('not json', '[]', '{"schema":1}',
                     json.dumps({'schema': 1, 'run_id': 'a'*32, 'resources': {'other': NID}}),
                     json.dumps({'schema': 1, 'run_id': 'invalid', 'resources': {PROBE.NETWORK: NID}}),
                     json.dumps({'schema': 1, 'run_id': 'a'*32, 'resources': {PROBE.NETWORK: 'short'}}),
                     '[' * 9000):
            with self.subTest(text=text[:90]):
                path.write_text(text)
                self.assertFalse(self.probe.cleanup())
                self.assertEqual(self.state()['calls'], [])
        path.unlink()
        target = self.root / 'foreign.json'
        target.write_text('{}')
        path.symlink_to(target)
        self.assertFalse(self.probe.cleanup())
        self.assertTrue(path.is_symlink())
        self.assertEqual(target.read_text(), '{}')

    def test_known_id_and_journal_disagreement_preserves_both_without_docker(self):
        self.seed_legacy('network')
        (self.probe.own / 'creation.json').write_text(json.dumps({
            'schema': 1, 'run_id': 'a'*32, 'resources': {PROBE.NETWORK: 'b'*64}}))
        self.assertFalse(self.probe.cleanup())
        self.assertEqual(self.state()['calls'], [])
        self.assertTrue(self.marker('network').exists())

    def test_late_creation_can_be_reconciled_without_resending_create(self):
        self.create_loss('network', omit=True)
        self.assertFalse(self.probe.cleanup())
        state = self.state()
        labels = state['creation_records'][0]['labels']
        state['resources'][NID] = {'kind': 'network', 'Id': NID, 'Name': PROBE.NETWORK, 'Labels': labels}
        self.engine.write_text(json.dumps(state))
        self.assertTrue(self.probe.cleanup())
        self.assertEqual(self.state()['resources'], {})
        self.assertEqual(sum(call[:2] == ['network', 'create'] for call in self.state()['calls']), 1)
        count = len(self.state()['calls'])
        self.assertTrue(self.probe.cleanup())
        self.assertEqual(len(self.state()['calls']), count)


if __name__ == '__main__':
    unittest.main(verbosity=2)
