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
  );
  await assert.rejects(() => controller.get('default', request('VIEWER', ['default']) as never), /scoped ADMIN/);
  await assert.rejects(() => controller.get('default', request('ADMIN', ['other']) as never), /scoped ADMIN/);
  const result = await controller.get('default', request('ADMIN', ['default']) as never);
  assert.equal(result.generation, '9007199254740993');
  assert.equal(registrations, 1);
});
