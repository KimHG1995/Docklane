import assert from 'node:assert/strict';
import test from 'node:test';
import {
  currentMutationAdmission, currentMutationOperation,
  withMutationAdmission, withMutationOperation,
} from './mutation-dispatch-context.js';

test('durable operation and generation scopes survive asynchronous Agent selection', async () => {
  const fakeConnection = { query: async () => [] };
  assert.equal(currentMutationOperation(), null);
  assert.equal(currentMutationAdmission(), null);
  await withMutationOperation('operation-42', () =>
    withMutationAdmission({
      clusterId: 'default',
      generation: 9007199254740993n,
      connection: fakeConnection as never,
    }, async () => {
      await Promise.resolve();
      assert.equal(currentMutationOperation(), 'operation-42');
      assert.equal(currentMutationAdmission()?.generation, 9007199254740993n);
      assert.equal(currentMutationAdmission()?.connection, fakeConnection);
    }));
  assert.equal(currentMutationOperation(), null);
  assert.equal(currentMutationAdmission(), null);
});

test('transport cannot invent durable operation identity', () => {
  assert.throws(() => withMutationOperation('', async () => {}), /Durable operation ID/);
});
