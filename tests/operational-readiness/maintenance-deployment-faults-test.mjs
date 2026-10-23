import assert from 'node:assert/strict';
import test from 'node:test';
import { assertWorkloadSnapshot, assertSingleMutation, settleCleanup, reconcileUntilTerminal } from './maintenance-deployment-faults.mjs';
const image='alpine@sha256:'+'a'.repeat(64);
const snapshot=()=>({service:{desiredReplicas:2,runningReplicas:2,image},tasks:[1,2].map(slot=>({slot,state:'running',desiredState:'running',image}))});
test('workload evidence requires two distinct running digest-pinned slots',()=>{
  assert.doesNotThrow(()=>assertWorkloadSnapshot(snapshot(),2,image));
  for(const change of [
    s=>{s.service.runningReplicas=0;},
    s=>{s.tasks[1].slot=1;},
    s=>{s.tasks[1].image='alpine:latest';},
    s=>{s.tasks[1].state='starting';},
  ]){
    const value=snapshot();change(value);
    assert.throws(()=>assertWorkloadSnapshot(value,2,image));
  }
});
test('zero replicas and floating images cannot count as workload acceptance',()=>{
  assert.throws(()=>assertWorkloadSnapshot({service:{desiredReplicas:0,runningReplicas:0,image},tasks:[]},0,image));
  const floating=snapshot();
  floating.service.image='alpine:latest';
  for(const task of floating.tasks)task.image='alpine:latest';
  assert.throws(()=>assertWorkloadSnapshot(floating,2,'alpine:latest'));
});

test('rejected mutation replay cannot masquerade as no replay', () => {
  const accepted = { method: 'POST', path: '/v2/services/owned/image', status: 200, acknowledgedByAgent: true };
  assert.doesNotThrow(() => assertSingleMutation([accepted], accepted.path));
  for (const status of [409, 412]) {
    assert.throws(() => assertSingleMutation([accepted, { ...accepted, status, acknowledgedByAgent: false }], accepted.path));
    assert.throws(() => assertSingleMutation([{ ...accepted, status }], accepted.path));
  }
  assert.throws(() => assertSingleMutation([accepted], '/v2/services/other/image'));
});
test('cleanup attempts every resource despite throws, rejection, and timeout', async () => {
  const visited = [];
  const errors = await settleCleanup([
    () => { visited.push('throw'); throw new Error('sync failure'); },
    async () => { visited.push('reject'); throw new Error('async failure'); },
    () => { visited.push('hang'); return new Promise(() => {}); },
    () => { visited.push('success'); },
  ], 20);
  assert.deepEqual(visited, ['throw', 'reject', 'hang', 'success']);
  assert.equal(errors.length, 3);
  assert.match(String(errors[2]), /cleanup timed out/);
});

test('same-operation reconciliation allows pending to expected terminal without changing IDs', async () => {
  for (const [pending, expected] of [['ROLLBACK_VERIFYING', 'ROLLED_BACK'], ['VERIFYING', 'SUCCESS']]) {
    const input = { operationId: 'fixed-operation' };
    const calls = [];
    const result = await reconcileUntilTerminal(async received => {
      calls.push(received);
      return { id: 'fixed-deployment', status: calls.length === 1 ? pending : expected };
    }, input, expected, { intervalMs: 0 });
    assert.equal(result.status, expected);
    assert.deepEqual(calls, [input, input]);
    assert.ok(calls.every(received => received === input && received.operationId === 'fixed-operation'));
  }
});
test('same-operation reconciliation rejects terminal failure immediately', async () => {
  let calls = 0;
  await assert.rejects(reconcileUntilTerminal(async () => { calls++; return { id: 'd', status: 'FAILED' }; },
    { operationId: 'fixed' }, 'ROLLED_BACK'), /unexpected deployment status FAILED/);
  assert.equal(calls, 1);
});
test('same-operation reconciliation times out pending without issuing new IDs', async () => {
  let clock = 0;
  const ids = [];
  await assert.rejects(reconcileUntilTerminal(async input => {
    ids.push(input.operationId);
    return { id: 'd', status: 'ROLLBACK_VERIFYING' };
  }, { operationId: 'fixed' }, 'ROLLED_BACK', {
    timeoutMs: 20, intervalMs: 10, now: () => clock, sleep: async ms => { clock += ms; },
  }), /timed out.*fixed.*ROLLBACK_VERIFYING/);
  assert.deepEqual(ids, ['fixed', 'fixed']);
});
