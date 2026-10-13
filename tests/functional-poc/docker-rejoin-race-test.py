#!/usr/bin/env python3
from pathlib import Path
import subprocess
import unittest
HERE=Path(__file__).resolve().parent
class RejoinSafety(unittest.TestCase):
    def test_syntax_and_owned_swarm(self):
        subprocess.run(['bash','-n',str(HERE/'docker-rejoin-race.sh')],check=True)
        subprocess.run(['python3','-m','py_compile',str(HERE/'docker-rejoin-proxy.py')],check=True)
        script=(HERE/'docker-rejoin-race.sh').read_text()
        run=(HERE/'run.sh').read_text()
        cleanup=(HERE/'cleanup.sh').read_text()
        self.assertIn('refusing rejoin experiment on an unverified cluster',script)
        self.assertIn('rejoin-swarm.node-id',script)
        self.assertIn('leave_owned_rejoin_swarm',cleanup)
        self.assertIn('owned Swarm A did not leave',script)
        self.assertIn('service ownership marker changed during rejoin',script)
        self.assertLess(script.index('owned Swarm A did not leave'),script.index('rm -f "$OWNERSHIP_DIR/service.id"'))
        self.assertLess(script.index('rm -f "$OWNERSHIP_DIR/service.id"'),script.index('docker swarm init --advertise-addr'))

        self.assertLess(run.index('scenario: audit completeness'),run.index('docker-rejoin-race.sh'))
        self.assertIn('CLUSTER_PRECONDITION_FAILED',script)
        self.assertIn('docker_service_update_attempt',script)
    def test_postguard_is_opt_in_and_observed(self):
        src=(HERE/'docker-rejoin-proxy.py').read_text()
        script=(HERE/'docker-rejoin-race.sh').read_text()
        self.assertIn('DOCKLANE_REJOIN_RACE_MODE", "preguard"',src)
        self.assertIn('if update_request and MODE == "postguard":',src)
        self.assertIn('postguard_update_held',src)
        self.assertLess(src.index('postguard_update_held'),src.index('conn.request('))
        self.assertIn('postguard_update_released',src)
        self.assertIn('RACE_MODE="${DOCKLANE_REJOIN_RACE_MODE:-preguard}"',script)
        self.assertIn('postguard daemon outcome mismatch',script)
        self.assertIn('docker_service_update_daemon_response',src)
        self.assertIn('daemonResponded=True',src)
        self.assertIn('expected Agent 502',script)
        self.assertIn('daemonResponse:$daemonResponse',script)
        self.assertIn('dockerUpdateAttempts:$attempts',script)
        subprocess.run(['bash','-n',str(HERE/'docker-rejoin-race.sh')],check=True)
        subprocess.run(['python3','-m','py_compile',str(HERE/'docker-rejoin-proxy.py')],check=True)
    def test_proxy_has_one_shot_response_barrier(self):
        src=(HERE/'docker-rejoin-proxy.py').read_text()
        self.assertIn('ARM.rename',src)
        self.assertIn('old_service_inspect_held',src)
        self.assertIn('old_service_inspect_released',src)
        self.assertIn('socket.AF_UNIX',src)
        self.assertIn('ThreadingHTTPServer(("127.0.0.1"',src)
if __name__=='__main__':
    unittest.main(verbosity=2)
