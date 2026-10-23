import assert from 'node:assert/strict';
import test from 'node:test';
import { assertWorkloadSnapshot, assertSingleMutation, settleCleanup } from './maintenance-deployment-faults.mjs';
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
