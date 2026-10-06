import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { HttpAgentClient } from './http-agent.client.js';

async function startAgent() {
  const state = {
    clusterId: 'cluster-a',
    nodeId: 'node-a',
    clusterPayloadId: 'cluster-a',
    identityCalls: 0,
    readCalls: 0,
    mutationCalls: 0,
    failIdentity: false,
    loseMutationResponse: false,
  };
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/identity') {
      state.identityCalls += 1;
      if (state.failIdentity) {
        request.socket.destroy();
        return;
      }
      response.end(JSON.stringify({
        component: 'docklane-agent', clusterId: state.clusterId,
        nodeId: state.nodeId, hostname: state.nodeId, manager: true, leader: false,
      }));
    } else if (request.url === '/v1/services') {
      state.readCalls += 1;
      response.end('[]');
    } else if (request.url === '/v1/cluster') {
      state.readCalls += 1;
      response.end(JSON.stringify({
        cluster: {
          id: state.clusterPayloadId, dockerVersion: '28.5.2', apiVersion: '1.51',
          createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z',
          managers: { total: 1, reachable: 1, required: 1, available: true, leaderCount: 1 },
        },
        nodes: [],
      }));
    } else if (request.method === 'POST' && request.url === '/v1/services/svc/scale') {
      state.mutationCalls += 1;
      if (state.loseMutationResponse) {
        request.socket.destroy();
        return;
      }
      response.end(JSON.stringify({
        serviceId: 'svc', version: 2, targetSpecHash: 'after', targetForceUpdate: 0,
      }));
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    state,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

function clientFor(...agents: Array<{ baseUrl: string }>): HttpAgentClient {
  return new HttpAgentClient({
    primaryId: 'manager-0',
    agents: agents.map((agent, index) => ({
      id: `manager-${index}`, baseUrl: agent.baseUrl, insecureDev: true,
    })),
  });
}

const scaleInput = {
  expectedVersion: 1, expectedSpecHash: 'before', targetSpecHash: 'after', replicas: 2,
};

test('safe reads reject a previously verified endpoint after a silent cluster change', async (t) => {
  const agent = await startAgent();
  t.after(agent.close);
  const client = clientFor(agent);
  assert.deepEqual(await client.listServices(), []);
  agent.state.clusterId = 'cluster-b';
  await assert.rejects(client.listServices(), /cluster cluster-b does not match cluster-a/);
  assert.equal(agent.state.identityCalls, 2);
  assert.equal(agent.state.readCalls, 1);
});

test('mutation selection refreshes identity and never sends to a silently replaced cluster', async (t) => {
  const agent = await startAgent();
  t.after(agent.close);
  const client = clientFor(agent);
  await client.listServices();
  agent.state.clusterId = 'cluster-b';
  await assert.rejects(client.scaleService('svc', scaleInput), /does not match cluster-a/);
  assert.equal(agent.state.identityCalls, 2);
  assert.equal(agent.state.mutationCalls, 0);
  // A rejected identity must not repin the client to B; the original cluster can recover.
  agent.state.clusterId = 'cluster-a';
  agent.state.nodeId = 'replacement-node';
  await client.scaleService('svc', scaleInput);
  assert.equal(agent.state.identityCalls, 3);
  assert.equal(agent.state.mutationCalls, 1);
});

test('cluster response identity is checked even when the preceding identity read matched', async (t) => {
  const agent = await startAgent();
  t.after(agent.close);
  const client = clientFor(agent);
  await client.identity();
  agent.state.clusterPayloadId = 'cluster-b';
  await assert.rejects(client.inspectCluster(), /cluster cluster-b does not match cluster-a/);
  agent.state.clusterId = 'cluster-b';
  await assert.rejects(client.scaleService('svc', scaleInput), /does not match cluster-a/);
  assert.equal(agent.state.mutationCalls, 0);
});

test('cluster response mismatch fails over without returning foreign cluster data', async (t) => {
  const primary = await startAgent();
  t.after(primary.close);
  const secondary = await startAgent();
  t.after(secondary.close);
  primary.state.clusterPayloadId = 'cluster-b';
  const result = await clientFor(primary, secondary).inspectCluster();
  assert.equal(result.cluster.id, 'cluster-a');
  assert.equal(primary.state.readCalls, 1);
  assert.equal(secondary.state.identityCalls, 1);
  assert.equal(secondary.state.readCalls, 1);
});

test('selection can fail over before mutation but cannot resend after response loss', async (t) => {
  const primary = await startAgent();
  t.after(primary.close);
  const secondary = await startAgent();
  t.after(secondary.close);
  const tertiary = await startAgent();
  t.after(tertiary.close);
  const client = clientFor(primary, secondary, tertiary);
  await client.listServices();
  primary.state.clusterId = 'cluster-b';
  secondary.state.loseMutationResponse = true;
  await assert.rejects(client.scaleService('svc', scaleInput), /transport failed/);
  assert.equal(primary.state.identityCalls, 2);
  assert.equal(primary.state.mutationCalls, 0);
  assert.equal(secondary.state.identityCalls, 1);
  assert.equal(secondary.state.mutationCalls, 1);
  assert.equal(tertiary.state.mutationCalls, 0);
});

test('unavailable identity cannot authorize a cached endpoint and same-cluster failover remains usable', async (t) => {
  const primary = await startAgent();
  t.after(primary.close);
  const secondary = await startAgent();
  t.after(secondary.close);
  const client = clientFor(primary, secondary);
  await client.listServices();
  primary.state.failIdentity = true;
  await client.scaleService('svc', scaleInput);
  assert.equal(primary.state.identityCalls, 2);
  assert.equal(primary.state.mutationCalls, 0);
  assert.equal(secondary.state.mutationCalls, 1);
});
