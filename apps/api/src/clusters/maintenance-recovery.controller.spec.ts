import assert from 'node:assert/strict';
import test from 'node:test';
import { MaintenanceRecoveryController } from './maintenance-recovery.controller.js';

const previous = process.env.DOCKLANE_MAINTENANCE_ENFORCE;
const req = { principal: { actorId: '관리자', role: 'ADMIN',
  clusters: ['default'] } };
const body = { generation: '9', reason: 'reviewed maintenance' };

function fixture(failOpen = false) {
  const calls: string[] = [];
  const lease = { clusterId: 'default', holderId: 'owner-a', token: 3n };
  const binding = { clusterId: 'default',
    settings: { mode: 'enforce', expectedSwarmClusterId: 'swarm-a' },
    assertRegistered: async () => { calls.push('register'); } };
  const maintenance = {
    commitRecoveryTransition: async (...args: unknown[]) => {
      calls.push('commit-' + args[4]);
      return true;
    },
  };
  const barrier = {
    blockAll: async () => {
      calls.push('block');
      return { blockedManagerIds: ['manager-0', 'manager-1'] };
    },
    openAll: async () => {
      calls.push('open');
      if (failOpen) throw new Error('manager did not confirm OPEN');
      return { openManagerIds: ['manager-0', 'manager-1'] };
    },
  };
  const leases = {
    acquire: async () => { calls.push('lease'); return lease; },
    release: async () => { calls.push('release'); },
  };
  return { controller: new MaintenanceRecoveryController(
    binding as never, maintenance as never, barrier as never, leases as never),
    calls };
}

test('recovery transitions preserve CLOSED agent state until OPEN is durable', async () => {
  process.env.DOCKLANE_MAINTENANCE_ENFORCE='1';
  try {
    const { controller, calls } = fixture();
    const begin = await controller.beginReconciliation(
      'default', req as never, body);
    assert.equal(begin.state, 'RECONCILING');
    assert.equal(begin.generation, '10');
    assert.deepEqual(calls, ['register','lease','commit-CLOSED','release']);
    calls.length = 0;
    const complete = await controller.completeReconciliation(
      'default', req as never, { generation: '10', reason: 'reconciled' });
    assert.equal(complete.state, 'OPEN');
    assert.equal(complete.generation, '11');
    assert.deepEqual(calls,
      ['register','lease','block','commit-RECONCILING','open','release']);
  } finally {
    if(previous===undefined) delete process.env.DOCKLANE_MAINTENANCE_ENFORCE;
    else process.env.DOCKLANE_MAINTENANCE_ENFORCE=previous;
  }
});

test('OPEN ack loss can retry exact generation but must not replay DB transition', async () => {
  process.env.DOCKLANE_MAINTENANCE_ENFORCE='1';
  try {
    const {controller,calls}=fixture(true);
    await assert.rejects(() => controller.completeReconciliation(
      'default', req as never, { generation: '10', reason: 'reconciled' }),
      /manager did not confirm OPEN/);
    assert.deepEqual(calls,
      ['register','lease','block','commit-RECONCILING','open','release']);
    const retry=fixture();
    const result=await retry.controller.resumeManagers(
      'default', req as never, { generation: '11', reason: 'retry ACKs' });
    assert.equal(result.managersReady,true);
    assert.deepEqual(retry.calls, ['register','lease','open','release']);
  } finally {
    if(previous===undefined) delete process.env.DOCKLANE_MAINTENANCE_ENFORCE;
    else process.env.DOCKLANE_MAINTENANCE_ENFORCE=previous;
  }
});

test('unauthorized recovery never acquires lease or talks to managers', async () => {
  process.env.DOCKLANE_MAINTENANCE_ENFORCE='1';
  try {
    const {controller,calls}=fixture();
    await assert.rejects(() => controller.beginReconciliation('default',
      {principal:{actorId:'other',role:'VIEWER',clusters:['default']}} as never,body),
      /scoped ADMIN/);
    assert.equal(calls.length,0);
  } finally {
    if(previous===undefined) delete process.env.DOCKLANE_MAINTENANCE_ENFORCE;
    else process.env.DOCKLANE_MAINTENANCE_ENFORCE=previous;
  }
});
