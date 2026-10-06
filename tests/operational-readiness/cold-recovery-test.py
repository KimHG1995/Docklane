#!/usr/bin/env python3
"""Offline policy tests and actual shell transition checks without Docker."""
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
PIN='89c5e8fd66634b6128fc4c0e6f1236e2540e46e0'

class ColdRecoveryTests(unittest.TestCase):
    def test_go_policy_and_secret_handling(self):
        subprocess.run(['go','test',str(HERE/'cold-recovery/policy.go'),str(HERE/'cold-recovery/policy_test.go')],
                       check=True,timeout=120,env=dict(os.environ,GOTOOLCHAIN='local'))

    def test_restore_remains_stopped_until_offline_success(self):
        source=(HERE/'trust-key-restore-v2.sh').read_text()
        self.assertIn('offline_restore_quorum(){',source)
        functions=source.split('\nfor name in ',1)[0]
        for failure in (False,True):
            with self.subTest(failure=failure),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);log=root/'log';log.mkdir();events=root/'events'
                function_file=root/'functions.sh';function_file.write_text(functions)
                # Exercise the actual shell transition; only boundaries are doubles.
                body=f'''source {shlex.quote(str(function_file))}
ROOT={shlex.quote(str(ROOT))}
DOCKLANE_OR_COLD_HELPER=/synthetic/helper
KEY1=SWMKEY-1-synthetic
RID={'d'*64}; CA1={'f'*64}
docker() {{ printf 'docker %s\\n' "$*" >>{shlex.quote(str(events))}; }}
wait_dind() {{ printf 'wait\\n' >>{shlex.quote(str(events))}; }}
assert_locked() {{ printf 'locked\\n' >>{shlex.quote(str(events))}; }}
timeout() {{ cat >/dev/null; printf 'helper\\n' >>{shlex.quote(str(events))}; return {1 if failure else 0}; }}
offline_restore_quorum "$RID" "$KEY1" "$CA1"
printf 'continued\\n' >>{shlex.quote(str(events))}
'''
                result=subprocess.run(['bash','-c',body],env=dict(os.environ,DOCKLANE_OR_LOG_DIR=str(log)),
                                      capture_output=True,text=True,timeout=10)
                actual=events.read_text().splitlines()
                self.assertTrue(actual[0].startswith('docker stop '))
                self.assertEqual(actual[1],'helper')
                self.assertNotIn('SWMKEY',events.read_text())
                if failure:
                    self.assertNotEqual(result.returncode,0)
                    self.assertEqual(len(actual),2,'failed helper continued into Docker startup')
                else:
                    self.assertEqual(result.returncode,0,result.stderr)
                    self.assertTrue(actual[2].startswith('docker start '))
                    self.assertEqual(actual[3:],['wait','locked','continued'])

    def test_new_recovery_order_does_not_retry_an_uncertain_unlock(self):
        source=(HERE/'trust-key-restore-v2.sh').read_text()
        self.assertIn('offline_restore_quorum "$RID" "$KEY1" "$CA1"',source)
        self.assertLess(source.index('cat "$OWN/$M1.container-id"'),source.index('docker rm -fv "$M3"'))
        self.assertLess(source.index('reject_unlock "$RESTORE" "$BAD_KEY"'),source.index('\noffline_restore_quorum "$RID"'))
        self.assertLess(source.index('\noffline_restore_quorum "$RID"'),source.index('\nunlock "$RESTORE" "$KEY1" restore-unlock'))
        self.assertNotIn('swarm init --force-new-cluster',source)
        self.assertIn('restored cluster ID mismatch',source)
        self.assertIn('reject_unlock "$RESTORE" "$KEY1" old-key',source)
        self.assertIn('unlock "$RESTORE" "$KEY2" rotated-unlock',source)
        self.assertIn('worker root CA mismatch',source)

    def test_helper_build_and_heavy_workflow_have_distinct_scopes(self):
        light=(ROOT/'.github/workflows/cold-recovery-helper.yml').read_text()
        heavy=(ROOT/'.github/workflows/operational-readiness-recovery-v2.yml').read_text()
        self.assertIn('pull_request:',light)
        self.assertNotIn('Run recovery drill',light)
        self.assertNotIn('pull_request:',heavy)
        for text in (light,heavy):
            self.assertIn(PIN,text)
            self.assertIn('build-cold-recovery.sh',text)
            before_steps=text.split('    steps:\n',1)[0]
            self.assertNotIn('${{ runner.temp }}',before_steps)
        self.assertIn('DOCKLANE_OR_COLD_HELPER:',heavy)
        self.assertIn('offline-quorum-rebuild.py --cleanup-only',heavy)
        self.assertIn('!${{ runner.temp }}/docklane-operational-readiness/offline-helper/ownership-trust-key/**',heavy)

if __name__=='__main__':unittest.main(verbosity=2)
