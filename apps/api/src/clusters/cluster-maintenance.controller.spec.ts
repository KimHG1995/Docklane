import assert from 'node:assert/strict';
import test from 'node:test';
import { ClusterMaintenanceController } from './cluster-maintenance.controller.js';

const request = (role: string, clusters: string[]) => ({ principal: { actorId: '관리자', role, clusters } });

test('maintenance read requires scoped ADMIN and serializes generation losslessly', async () => {
  let registrations = 0;
  const controller = new ClusterMaintenanceController(
    { requireRecord: async () => ({
      clusterId: 'default', state: 'CLOSING', generation: 9007199254740993n,
      ownerId: '관리자', reason: 'maintenance', changedBy: '관리자',
      changedAt: new Date('2026-10-13T00:00:00Z'),
    }) } as never,
    { clusterId: 'default', assertRegistered: async () => { registrations += 1; } } as never,
    { countUnresolved: async () => 0n } as never,
  );
  await assert.rejects(() => controller.get('default', request('VIEWER', ['default']) as never), /scoped ADMIN/);
  await assert.rejects(() => controller.get('default', request('ADMIN', ['other']) as never), /scoped ADMIN/);
  const result = await controller.get('default', request('ADMIN', ['default']) as never);
  assert.equal(result.generation, '9007199254740993');
  assert.equal(registrations, 1);
});

test('maintenance close requires scoped ADMIN and sends precise generation', async () => {
  const calls: unknown[][] = [];
  const controller = new ClusterMaintenanceController(
    { requestClosing: async (...args: unknown[]) => { calls.push(args); return true; },
      requireRecord: async () => ({ clusterId:'default', state:'CLOSING', generation:2n }) } as never,
    { clusterId:'default', assertRegistered:async () => {} } as never,
    { countUnresolved: async () => 0n } as never,
  );
  const body = { generation:'1', reason:'planned maintenance' };
  await assert.rejects(() => controller.requestClosing('default', request('OPERATOR', ['default']) as never, body), /scoped ADMIN/);
  const result = await controller.requestClosing('default', request('ADMIN', ['default']) as never, body);
  assert.equal(result.generation, '2');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[1], 1n);
});

test('readiness remains unsafe with zero unresolved operations until Agent barriers exist', async () => {
  const controller = new ClusterMaintenanceController(
    {
      requireRecord: async () => ({ clusterId: 'default', state: 'CLOSING', generation: 8n }),
      countUnresolvedOperations: async () => 0n,
    } as never,
    { clusterId: 'default', assertRegistered: async () => {} } as never,
    { countUnresolved: async () => 0n } as never,
  );
  await assert.rejects(
    () => controller.readiness('default', request('OPERATOR', ['default']) as never),
    /scoped ADMIN/,
  );
  const result = await controller.readiness('default', request('ADMIN', ['default']) as never);
  assert.deepEqual(result, {
    clusterId: 'default', state: 'CLOSING', generation: '8',
    unresolvedOperations: '0', unresolvedDispatches: '0', agentBarrierVerified: false,
    inFlightDispatchVerified: false, safeToClose: false,
  });
});
