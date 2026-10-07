import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { AgentRequestError } from './agent-client.js';
import { HttpAgentClient } from './http-agent.client.js';

const header = 'x-docklane-expected-cluster-id';
const input = { expectedVersion: 1, expectedSpecHash: 'before', targetSpecHash: 'after' };
const identity = (clusterId = 'cluster-a') => ({
  component: 'docklane-agent', clusterId, nodeId: 'manager-1',
  hostname: 'manager-1', manager: true, leader: true,
});

async function agent(t: TestContext, handler: (r: IncomingMessage, w: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function client(...baseUrls: string[]) {
  return new HttpAgentClient({
    primaryId: 'manager-0',
    agents: baseUrls.map((baseUrl, i) => ({ id: `manager-${i}`, baseUrl, insecureDev: true })),
  });
}

function json(w: ServerResponse, value: unknown, status = 200) {
  w.writeHead(status, { 'Content-Type': 'application/json' });
  w.end(JSON.stringify(value));
}

const mutations: Array<{ path: string; invoke: (c: HttpAgentClient) => Promise<unknown> }> = [
  { path: '/v2/services/svc/scale', invoke: (c) => c.scaleService('svc', { ...input, replicas: 2 }) },
  { path: '/v2/services/svc/restart', invoke: (c) => c.restartService('svc', input) },
  { path: '/v2/services/svc/image', invoke: (c) => c.updateServiceImage('svc', { ...input, image: 'repo@sha256:' + 'a'.repeat(64) }) },
  { path: '/v2/services/svc/rollback', invoke: (c) => c.rollbackService('svc', input) },
  { path: '/v2/nodes/node/drain', invoke: (c) => c.drainNode('node', input) },
  { path: '/v2/nodes/node/activate', invoke: (c) => c.activateNode('node', input) },
  { path: '/v2/nodes/node/labels', invoke: (c) => c.updateNodeLabels('node', { ...input, expectedServiceIds: [], targetLabels: {} }) },
];

test('all mutations use v2 and the verified cluster header without changing the body', async (t) => {
  for (const operation of mutations) {
    await t.test(operation.path, async (t) => {
      const requests: Array<{ path: string; cluster: unknown; body: Record<string, unknown> }> = [];
      const baseUrl = await agent(t, (r, w) => {
        if (r.url === '/v1/identity') { json(w, identity()); return; }
        const chunks: Buffer[] = [];
        r.on('data', (chunk: Buffer) => chunks.push(chunk));
        r.on('end', () => {
          requests.push({ path: r.url!, cluster: r.headers[header], body: JSON.parse(Buffer.concat(chunks).toString()) });
          json(w, operation.path.includes('/nodes/')
            ? { nodeId: 'node', version: 2, targetSpecHash: 'after', targetAvailability: 'active' }
            : { serviceId: 'svc', version: 2, targetSpecHash: 'after', targetForceUpdate: 0 });
        });
      });
      await operation.invoke(client(baseUrl));
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.path, operation.path);
      assert.equal(requests[0]!.cluster, 'cluster-a');
      assert.equal(requests[0]!.body.expectedVersion, 1);
      assert.equal(requests[0]!.body.expectedSpecHash, 'before');
      assert.equal(requests[0]!.body.targetSpecHash, 'after');
      assert.equal('expectedClusterId' in requests[0]!.body, false);
    });
  }
});

test('a cluster change after identity is rejected by the mutation endpoint without failover', async (t) => {
  let currentCluster = 'cluster-a';
  let posts = 0;
  let writes = 0;
  let secondaryCalls = 0;
  const primary = await agent(t, (r, w) => {
    if (r.url === '/v1/identity') {
      json(w, identity(currentCluster));
      currentCluster = 'cluster-b';
      return;
    }
    posts += 1;
    if (r.url === '/v2/services/svc/restart' && r.headers[header] !== currentCluster) {
      json(w, { code: 'CLUSTER_PRECONDITION_FAILED' }, 412);
      return;
    }
    writes += 1; // An old path or missing v2 guard must make this test fail.
    json(w, { serviceId: 'svc', version: 2, targetSpecHash: 'after', targetForceUpdate: 1 });
  });
  const secondary = await agent(t, (_r, w) => { secondaryCalls += 1; json(w, identity()); });
  await assert.rejects(client(primary, secondary).restartService('svc', input),
    (e: unknown) => e instanceof AgentRequestError && e.statusCode === 412);
  assert.equal(posts, 1);
  assert.equal(writes, 0);
  assert.equal(secondaryCalls, 0);
});

test('an old Agent cannot silently ignore the cluster guard and is never retried via v1', async (t) => {
  const paths: string[] = [];
  const baseUrl = await agent(t, (r, w) => {
    paths.push(r.url!);
    if (r.url === '/v1/identity') { json(w, identity()); return; }
    if (r.url === '/v1/services/svc/restart') {
      json(w, { serviceId: 'svc', version: 2, targetSpecHash: 'after', targetForceUpdate: 1 });
      return;
    }
    json(w, { error: 'not found' }, 404);
  });
  await assert.rejects(client(baseUrl).restartService('svc', input),
    (e: unknown) => e instanceof AgentRequestError && e.statusCode === 404);
  assert.deepEqual(paths, ['/v1/identity', '/v2/services/svc/restart']);
});

test('precondition and unavailable responses do not authorize automatic mutation resend', async (t) => {
  for (const status of [412, 428, 503]) {
    await t.test(String(status), async (t) => {
      let posts = 0;
      let secondaryCalls = 0;
      const primary = await agent(t, (r, w) => {
        if (r.url === '/v1/identity') { json(w, identity()); return; }
        posts += 1;
        json(w, { error: 'rejected or unavailable' }, status);
      });
      const secondary = await agent(t, (_r, w) => { secondaryCalls += 1; json(w, identity()); });
      await assert.rejects(client(primary, secondary).restartService('svc', input),
        (e: unknown) => e instanceof AgentRequestError && e.statusCode === status);
      assert.equal(posts, 1);
      assert.equal(secondaryCalls, 0);
    });
  }
});

test('unusable cluster IDs are rejected before sending any mutation', async (t) => {
  for (const clusterId of ['cluster-a\nforged-header:value', 'a'.repeat(129)]) {
    let posts = 0;
    const baseUrl = await agent(t, (r, w) => {
      if (r.url === '/v1/identity') { json(w, identity(clusterId)); return; }
      posts += 1;
      json(w, { serviceId: 'svc', version: 2, targetSpecHash: 'after', targetForceUpdate: 1 });
    });
    await assert.rejects(client(baseUrl).restartService('svc', input));
    assert.equal(posts, 0);
  }
});
