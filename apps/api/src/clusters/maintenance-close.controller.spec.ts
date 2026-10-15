import assert from 'node:assert/strict';
import test from 'node:test';
import { MaintenanceCloseController } from './maintenance-close.controller.js';

const req = (role: string, clusters: string[]) => ({
  principal: { actorId: '관리자', role, clusters },
});
function fixture(options?: { failManager?: boolean; active?: boolean; registration?: boolean }) {
  const calls: string[] = [];
  const binding = {
    clusterId: 'default',
    settings: { mode: options?.registration === false ? 'compat' : 'enforce',
      expectedSwarmClusterId: 'swarm-a' },
    assertRegistered: async () => { calls.push('registration'); },
  };
  const barrier = {
    blockAll: async () => {
      calls.push('barrier');
      if (options?.failManager) throw new Error('Manager B unavailable');
      return { blockedManagerIds: ['manager-0', 'manager-1'] };
    },
  };
  const repository = {
    commitClosed: async () => {
      calls.push('commit');
      return true;
    },
  };
  const lease = { acquire: async () => { calls.push('lease'); return {clusterId:'default',holderId:'owner',token:1n}; },
    release: async () => { calls.push('release'); } };
  return { controller: new MaintenanceCloseController(
    binding as never, repository as never, barrier as never, lease as never), calls };
}
const body = { generation: '8', reason: 'planned maintenance' };

test('maintenance CLOSED requires scoped ADMIN and enforced registration', async () => {
  const prior = process.env.DOCKLANE_MAINTENANCE_ENFORCE;
  process.env.DOCKLANE_MAINTENANCE_ENFORCE = '1';
  try {
    const { controller, calls } = fixture();
    await assert.rejects(
      () => controller.confirmClosed('default', req('VIEWER', ['default']) as never, body),
      /scoped ADMIN/);
    await assert.rejects(
      () => controller.confirmClosed('default', req('ADMIN', ['other']) as never, body),
      /scoped ADMIN/);
    await assert.rejects(
      () => fixture({ registration: false }).controller.confirmClosed(
        'default', req('ADMIN', ['default']) as never, body),
      /fixed registration/);
    assert.equal(calls.length, 0);
  } finally {
    if (prior === undefined) delete process.env.DOCKLANE_MAINTENANCE_ENFORCE;
    else process.env.DOCKLANE_MAINTENANCE_ENFORCE = prior;
  }
});

test('all managers are blocked before the atomic CLOSED commit', async () => {
  const prior = process.env.DOCKLANE_MAINTENANCE_ENFORCE;
  process.env.DOCKLANE_MAINTENANCE_ENFORCE = '1';
  try {
    const { controller, calls } = fixture();
    const result = await controller.confirmClosed(
      'default', req('ADMIN', ['default']) as never, body);
    assert.deepEqual(calls, ['registration', 'lease', 'barrier', 'commit', 'release']);
    assert.deepEqual(result, { clusterId: 'default', state: 'CLOSED', generation: '9' });
  } finally {
    if (prior === undefined) delete process.env.DOCKLANE_MAINTENANCE_ENFORCE;
    else process.env.DOCKLANE_MAINTENANCE_ENFORCE = prior;
  }
});

test('missing manager refuses CLOSED before the repository is called', async () => {
  const prior = process.env.DOCKLANE_MAINTENANCE_ENFORCE;
  process.env.DOCKLANE_MAINTENANCE_ENFORCE = '1';
  try {
    const { controller, calls } = fixture({ failManager: true });
    await assert.rejects(
      () => controller.confirmClosed('default', req('ADMIN', ['default']) as never, body),
      /Manager B unavailable/);
    assert.deepEqual(calls, ['registration', 'lease', 'barrier', 'release']);
  } finally {
    if (prior === undefined) delete process.env.DOCKLANE_MAINTENANCE_ENFORCE;
    else process.env.DOCKLANE_MAINTENANCE_ENFORCE = prior;
  }
});
