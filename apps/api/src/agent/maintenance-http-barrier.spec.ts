import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { HttpAgentClient } from './http-agent.client.js';
import { withMutationAdmission, withMutationOperation } from './mutation-dispatch-context.js';
import { MaintenancePreDispatchRejection } from './agent-client.js';

test('actual selected manager barrier generation precedes journalled mutation transport', async (t) => {
  const status = { state: 'OPEN', generation: '4', mutates: 0, barrierReads: 0, header: '' };
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/identity') {
      res.end(JSON.stringify({
        component: 'docklane-agent', clusterId: 'cluster-a',
        nodeId: 'node-a', hostname: 'manager-a', manager: true, leader: true,
      }));
    } else if (req.url === '/v1/maintenance/barrier') {
      status.barrierReads += 1;
      res.end(JSON.stringify({
        clusterId: 'cluster-a', nodeId: 'node-a',
        generation: status.generation, state: status.state,
      }));
    } else if (req.url === '/v2/services/svc/restart') {
      status.mutates += 1;
      status.header = String(req.headers['x-docklane-maintenance-generation']);
      req.resume();
      res.end(JSON.stringify({
        serviceId: 'svc', version: 2, targetSpecHash: 'after', targetForceUpdate: 1,
      }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const port = (server.address() as AddressInfo).port;
  const journalCalls: Array<{ cluster: string; generation: bigint; agent: string; operation: string }> = [];
  const journal = {
    execute: async (cluster: string, generation: bigint, agent: string,
      operation: string, send: () => Promise<unknown>) => {
      journalCalls.push({ cluster, generation, agent, operation });
      return send();
    },
  };
  const client = new HttpAgentClient({
    primaryId: 'manager-0', expectedClusterId: 'cluster-a',
    agents: [{ id: 'manager-0', baseUrl: `http://127.0.0.1:${port}`, insecureDev: true }],
  }, journal as never);
  const invoke = () => withMutationOperation('operation-42',
    () => withMutationAdmission({
      clusterId: 'default', generation: 4n, connection: null,
    }, () => client.restartService('svc', {
      expectedVersion: 1, expectedSpecHash: 'before', targetSpecHash: 'after',
    })));

  await invoke();
  assert.equal(status.barrierReads, 1);
  assert.equal(status.mutates, 1);
  assert.equal(status.header, '4');
  assert.deepEqual(journalCalls, [{
    cluster: 'default', generation: 4n, agent: 'manager-0', operation: 'operation-42',
  }]);

  status.state = 'BLOCKED';
  await assert.rejects(invoke(), (error: unknown) =>
    error instanceof MaintenancePreDispatchRejection);
  assert.equal(status.mutates, 1);
  assert.equal(journalCalls.length, 1);

  status.state = 'OPEN';
  status.generation = '5';
  await assert.rejects(invoke(), (error: unknown) =>
    error instanceof MaintenancePreDispatchRejection);
  assert.equal(status.mutates, 1);
  assert.equal(journalCalls.length, 1);
});
