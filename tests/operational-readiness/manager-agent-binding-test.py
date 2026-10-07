#!/usr/bin/env python3
"""Run the existing Bash/Node registry wiring without Docker or a real Swarm.

The client boundary is a strict fixture, not a substitute for API/mTLS tests.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent

CLIENT = """
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
export class HttpAgentClient {
  constructor(registry) {
    assert.equal(registry.expectedClusterId, 'verified-fixture-cluster');
    assert.equal(registry.primaryId, 'manager-01');
    assert.equal(registry.agents.length, 3);
    for (const agent of registry.agents) {
      assert.equal(agent.insecureDev, false);
      assert.ok(agent.baseUrl.startsWith('https://127.0.0.1:'));
      for (const field of ['ca', 'cert', 'key']) {
        assert.equal(agent[field].toString(), 'fixture-bytes');
      }
    }
  }
  async identity() {
    const suffix = existsSync('docker-called') ? '02' : '01';
    return { clusterId: 'verified-fixture-cluster', nodeId: 'node-' + suffix,
             hostname: 'manager-' + suffix };
  }
}
"""


class ManagerAgentBindingTests(unittest.TestCase):
    def invoke(self, inherited=None):
        text = (HERE / 'manager-agents.sh').read_text()
        # Execute the exact environment assignments and embedded JS, not a copy.
        marker = 'log "verifying Control Plane Agent failover after primary Agent loss"\n'
        self.assertEqual(text.count(marker), 1)
        tail = text.split(marker, 1)[1]
        block = tail.split('\nNODE\n', 1)[0] + '\nNODE\n'
        self.assertIn("node --input-type=module <<'NODE'", block)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'package.json').write_text('{"type":"module"}')
            module = root / 'apps/api/dist/agent/http-agent.client.js'
            module.parent.mkdir(parents=True)
            module.write_text(CLIENT)
            (root / 'fixture.pem').write_text('fixture-bytes')
            bindir = root / 'bin'
            bindir.mkdir()
            docker = bindir / 'docker'
            docker.write_text('''#!/usr/bin/env bash
set -euo pipefail
[[ "$#" == 5 && "$1" == exec && "$2" == fixture-manager && "$3" == sh && "$4" == -c ]]
printf '%s\\n' called >> docker-called
''')
            docker.chmod(0o700)
            env = dict(os.environ, PATH=str(bindir) + os.pathsep + os.environ['PATH'])
            env.pop('DOCKLANE_EXPECTED_CLUSTER_ID', None)
            if inherited is not None:
                env['DOCKLANE_EXPECTED_CLUSTER_ID'] = inherited
            script = '''set -Eeuo pipefail
cluster_id=verified-fixture-cluster
LOG_DIR=.
CA_CERT=fixture.pem
CLIENT_CERT=fixture.pem
CLIENT_KEY=fixture.pem
MANAGER_01_CONTAINER=fixture-manager
MANAGER_01_AGENT_PORT=19443
MANAGER_02_AGENT_PORT=19444
MANAGER_03_AGENT_PORT=19445
''' + block
            result = subprocess.run(['bash', '-c', script], cwd=root, env=env,
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            evidence = json.loads((root / 'manager-agent-failover.json').read_text())
            self.assertEqual(evidence['before']['clusterId'], 'verified-fixture-cluster')
            self.assertEqual(evidence['after']['clusterId'], 'verified-fixture-cluster')
            self.assertNotEqual(evidence['before']['nodeId'], evidence['after']['nodeId'])
            self.assertEqual((root / 'docker-called').read_text(), 'called\n')

    def test_verified_fixture_cluster_reaches_the_secure_registry(self):
        self.invoke()

    def test_unrelated_inherited_cluster_cannot_replace_the_verified_fixture(self):
        self.invoke('foreign-inherited-cluster')


if __name__ == '__main__':
    unittest.main(verbosity=2)
