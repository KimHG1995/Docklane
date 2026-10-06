#!/usr/bin/env python3
"""Test offline recovery fencing without Docker or an upstream library download."""
import importlib.util
import io
import json
import os
from types import SimpleNamespace
from unittest.mock import Mock, patch
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('offline_rebuild', HERE / 'offline-quorum-rebuild.py')
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)
RID='d'*64
SOURCE_IDS=['a'*64,'b'*64,'c'*64]
CA='f'*64

class Docker:
    def __init__(self):
        self.calls=[]
        self.values={RID:{'Id':RID,'Name':'/docklane-or-trust-restore','Image':'sha256:'+'e'*64,
                          'State':{'Running':False,'Paused':False,'Restarting':False,'Dead':False},'HostConfig':{'PidMode':''}}}
    def inspect_resource(self,kind,rid):
        self.calls.append((kind,rid))
        return self.values.get(rid)

class FenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.log=Path(self.tmp.name)
        own=self.log/'ownership-trust-key';own.mkdir()
        (own/'docklane-or-trust-restore.container-id').write_text(RID+'\n')
        (self.log/'original-managers.ids').write_text('\n'.join(SOURCE_IDS)+'\n')
        self.docker=Docker()
    def test_stopped_owned_copy_and_absent_originals_are_required(self):
        value=MOD.validate_restore(self.docker,self.log,RID,CA)
        self.assertEqual(value,'sha256:'+'e'*64)
        self.assertEqual(set(self.docker.calls),{('container',rid) for rid in [RID,*SOURCE_IDS]})
    def test_running_or_paused_copy_is_rejected(self):
        for field in ('Running','Paused','Restarting','Dead'):
            with self.subTest(field=field):
                self.docker.values[RID]['State'][field]=True
                with self.assertRaises(MOD.RecoveryError):MOD.validate_restore(self.docker,self.log,RID,CA)
                self.docker.values[RID]['State'][field]=False
    def test_any_surviving_original_manager_prevents_rebuild(self):
        self.docker.values[SOURCE_IDS[1]]={'Id':SOURCE_IDS[1]}
        with self.assertRaises(MOD.RecoveryError):MOD.validate_restore(self.docker,self.log,RID,CA)
    def test_ownership_name_id_and_pid_namespace_must_match(self):
        for changes in ({'Id':'x'*64},{'Name':'/another'},{'HostConfig':{'PidMode':'host'}},{'State':{}}):
            with self.subTest(changes=changes):
                self.docker=Docker();self.docker.values[RID].update(changes)
                with self.assertRaises(MOD.RecoveryError):MOD.validate_restore(self.docker,self.log,RID,CA)
    def test_missing_duplicate_or_malformed_source_ids_are_rejected(self):
        for text in ('',RID,'a'*64+'\n'+'a'*64+'\n'+'b'*64,'not-an-id'):
            with self.subTest(text=text):
                (self.log/'original-managers.ids').write_text(text)
                with self.assertRaises(MOD.RecoveryError):MOD.validate_restore(self.docker,self.log,RID,CA)
    def test_marker_symlink_or_wrong_id_is_rejected(self):
        marker=self.log/'ownership-trust-key/docklane-or-trust-restore.container-id'
        marker.write_text('a'*64)
        with self.assertRaises(MOD.RecoveryError):MOD.validate_restore(self.docker,self.log,RID,CA)
        marker.unlink();marker.symlink_to(self.log/'original-managers.ids')
        with self.assertRaises(MOD.RecoveryError):MOD.validate_restore(self.docker,self.log,RID,CA)


    def invoke(self, exit_code=0, cleanup_ok=True, creation_error=False):
        owner=Mock();owner.docker=self.docker
        owner.own=self.log/'offline-helper'/'ownership-trust-key'
        helper=self.log/'helper';helper.write_text('synthetic');helper.chmod(0o755)
        owner.create_owned.return_value='9'*64
        if creation_error: owner.create_owned.side_effect=RuntimeError('synthetic failure')
        owner.cleanup.return_value=cleanup_ok
        self.docker.absent=Mock()
        self.docker.raw=Mock(return_value=(exit_code,json.dumps({'status':'offline-quorum-rebuilt','root_ca_preserved':True,'single_backup_acceptance':False}),'SWMKEY-1-raw-private-error'))
        self.docker.values['9'*64]={'State':{'Running':False,'ExitCode':0}}
        factory=Mock(return_value=owner)
        key=b'SWMKEY-1-'+b'A'*43+b'\n'
        with patch.object(MOD,'load_backend',return_value=SimpleNamespace(Probe=factory,NAMES=('docklane-or-manager-01',))), \
             patch.dict(os.environ,{'DOCKLANE_OR_LOG_DIR':str(self.log),'DOCKLANE_OR_COLD_HELPER':str(helper)}), \
             patch.object(MOD.sys,'argv',['offline',RID,CA]), \
             patch.object(MOD.sys,'stdin',SimpleNamespace(buffer=io.BytesIO(key))),patch.object(MOD.os,'umask'):
            code=MOD.main()
        return code,owner,key

    def test_helper_has_open_stdin_and_receives_key_only_on_stdin(self):
        code,owner,key=self.invoke()
        self.assertEqual(code,0)
        args=owner.create_owned.call_args.args[1]
        self.assertIn('-i',args, 'created helper will otherwise receive EOF when started')
        self.assertIn('--read-only',args)
        self.assertEqual(args[args.index('--network')+1],'none')
        self.assertEqual(args[args.index('--volumes-from')+1],RID)
        self.assertEqual(args[args.index('--cap-drop')+1],'ALL')
        self.assertNotIn('SWMKEY-',str(args))
        self.assertEqual(self.docker.raw.call_args.kwargs['payload'],key)
        self.assertEqual(self.docker.raw.call_count,1)
        owner.cleanup.assert_called_once()

    def test_failed_helper_never_reports_completed_or_retries(self):
        code,owner,_=self.invoke(exit_code=137)
        self.assertEqual(code,1)
        self.assertEqual(self.docker.raw.call_count,1)
        result=owner.publish.call_args.args[1]
        self.assertEqual(result['status'],'failed')
        self.assertFalse(result['single_backup_acceptance'])
        self.assertNotIn('SWMKEY',str(result))
        owner.cleanup.assert_called_once()

    def test_failed_cleanup_prevents_success_even_after_helper_completion(self):
        code,owner,_=self.invoke(cleanup_ok=False)
        self.assertEqual(code,1)
        self.assertFalse(owner.publish.call_args.args[1]['cleanup_completed'])

    def test_ambiguous_helper_create_is_cleaned_without_a_second_create_or_start(self):
        code,owner,_=self.invoke(creation_error=True)
        self.assertEqual(code,1)
        owner.create_owned.assert_called_once()
        self.docker.raw.assert_not_called()
        owner.cleanup.assert_called_once()

if __name__=='__main__':unittest.main(verbosity=2)
