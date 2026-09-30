import test from 'node:test';
import assert from 'node:assert/strict';
import { SwarmJoinCredentialProvider } from './swarm-join-credential.provider.js';

test('Swarm join credential provider selects token by bootstrap role', () => {
  const previous = process.env.DOCKLANE_SWARM_JOIN_JSON;
  process.env.DOCKLANE_SWARM_JOIN_JSON = JSON.stringify([
    {
      clusterId: 'cluster-1',
      remoteAddr: '10.0.0.10:2377',
      managerToken: 'SWMTKN-1-manager-test-token-1234567890',
      workerToken: 'SWMTKN-1-worker-test-token-1234567890',
    },
  ]);

  try {
    const provider = new SwarmJoinCredentialProvider();
    assert.deepEqual(provider.credentials('cluster-1', 'manager'), {
      remoteAddr: '10.0.0.10:2377',
      joinToken: 'SWMTKN-1-manager-test-token-1234567890',
    });
    assert.deepEqual(provider.credentials('cluster-1', 'worker'), {
      remoteAddr: '10.0.0.10:2377',
      joinToken: 'SWMTKN-1-worker-test-token-1234567890',
    });
    assert.equal(provider.credentials('cluster-2', 'worker'), null);
  } finally {
    if (previous === undefined) {
      delete process.env.DOCKLANE_SWARM_JOIN_JSON;
    } else {
      process.env.DOCKLANE_SWARM_JOIN_JSON = previous;
    }
  }
});

test('Swarm join credential provider rejects duplicate cluster configuration', () => {
  const previous = process.env.DOCKLANE_SWARM_JOIN_JSON;
  process.env.DOCKLANE_SWARM_JOIN_JSON = JSON.stringify([
    {
      clusterId: 'cluster-1',
      remoteAddr: '10.0.0.10:2377',
      managerToken: 'SWMTKN-1-manager-test-token-1234567890',
      workerToken: 'SWMTKN-1-worker-test-token-1234567890',
    },
    {
      clusterId: 'cluster-1',
      remoteAddr: '10.0.0.11:2377',
      managerToken: 'SWMTKN-1-manager-test-token-abcdefghij',
      workerToken: 'SWMTKN-1-worker-test-token-abcdefghij',
    },
  ]);

  try {
    assert.throws(
      () => new SwarmJoinCredentialProvider(),
      /duplicate clusterId cluster-1/,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.DOCKLANE_SWARM_JOIN_JSON;
    } else {
      process.env.DOCKLANE_SWARM_JOIN_JSON = previous;
    }
  }
});
