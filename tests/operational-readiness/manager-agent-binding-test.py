#!/usr/bin/env python3
"""Check the real 3-manager registered failover harness wiring without Docker."""
from pathlib import Path
import subprocess
import unittest

HERE = Path(__file__).resolve().parent

class ManagerAgentBindingTests(unittest.TestCase):
    def test_verified_fixture_cluster_reaches_the_secure_registry(self):
        shell = (HERE / 'manager-agents.sh').read_text()
        helper_path = HERE / 'manager-agents-registration.mjs'
        helper = helper_path.read_text()

        # The same cluster ID is observed on all real Docker managers first.
        self.assertIn('[[ "$observed_cluster_id" == "$cluster_id" ]]', shell)
        self.assertIn('DOCKLANE_EXPECTED_CLUSTER_ID="$cluster_id"', shell)
        self.assertIn('DOCKLANE_CLUSTER_REGISTRATION_MODE=enforce', shell)
        self.assertIn('DOCKLANE_DATABASE_URL=', shell)
        self.assertIn('node "$ROOT_DIR/tests/operational-readiness/manager-agents-registration.mjs"', shell)

        # The helper consumes the pinned ID and secure mTLS Agent registry.
        self.assertIn('expectedClusterId: process.env.DOCKLANE_EXPECTED_CLUSTER_ID', helper)
        self.assertIn("primaryId: 'manager-01'", helper)
        self.assertIn('insecureDev: false', helper)
        for name in ['ca', 'cert', 'key']:
            self.assertIn(name + ',', helper)
        self.assertIn("assert.equal(settings.mode, 'enforce')", helper)
        self.assertIn("await assert.rejects(guarded.identity()", helper)
        self.assertIn("const after = await guarded.identity()", helper)
        self.assertIn("const restarted = registeredAgentClient(", helper)
        self.assertIn("new ClusterRegistrationRepository(db)", helper)
        self.assertIn("assert.equal(Number(auditsAfter[0].count), 1)", helper)
        self.assertIn('remove_owned_container manager-db', (HERE / 'cleanup.sh').read_text())
        subprocess.run(['node', '--check', str(helper_path)], check=True)

    def test_unrelated_inherited_cluster_cannot_replace_the_verified_fixture(self):
        shell = (HERE / 'manager-agents.sh').read_text()
        helper = (HERE / 'manager-agents-registration.mjs').read_text()
        self.assertNotIn('DOCKLANE_EXPECTED_CLUSTER_ID=${DOCKLANE_EXPECTED_CLUSTER_ID}', shell)
        self.assertIn('DOCKLANE_EXPECTED_CLUSTER_ID="$cluster_id"', shell)
        self.assertIn("assert.equal(initial.clusterId, settings.expectedSwarmClusterId)", helper)
        self.assertIn("expectedSwarmClusterId: 'different-swarm-id'", helper)
        self.assertIn("'CLUSTER_REGISTRATION_MISMATCH'", helper)
        self.assertNotIn("expectedClusterId: process.env.DOCKLANE_CLUSTER_ID", helper)


    def test_registration_db_requires_host_tcp_and_not_local_socket_ping(self):
        shell = (HERE / 'manager-agents.sh').read_text()
        self.assertIn('-p "127.0.0.1:${REGISTRATION_DB_PORT}:3306"', shell)
        self.assertIn('mysql --protocol=TCP -h127.0.0.1', shell)
        self.assertIn("-e 'SELECT 1'", shell)
        self.assertIn('/dev/tcp/127.0.0.1/$REGISTRATION_DB_PORT', shell)
        self.assertIn('registration_db_ready=true', shell)
        self.assertIn('registration_db_ready" == "true"', shell)
        self.assertIn('DOCKLANE_DATABASE_URL="mysql://docklane:docklane-test@127.0.0.1:${REGISTRATION_DB_PORT}/docklane"', shell)
        self.assertNotIn('REGISTRATION_DB_IP', shell)
        self.assertNotIn('mysqladmin ping -uroot', shell)
        self.assertLess(shell.index('registration_db_ready=true'), shell.index('node "$ROOT_DIR/tests/operational-readiness/manager-agents-registration.mjs"'))
        self.assertIn('remove_owned_container manager-db', (HERE / 'cleanup.sh').read_text())

if __name__ == '__main__':
    unittest.main(verbosity=2)
