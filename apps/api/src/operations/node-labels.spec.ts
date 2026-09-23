import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeLabelsRequestSchema } from './node-mutation.dto.js';

test('node label patch accepts set/remove mutations', () => {
  const parsed = NodeLabelsRequestSchema.parse({
    operationId: '00000000-0000-4000-8000-000000000010',
    expectedVersion: 5,
    set: { zone: 'a' },
    remove: ['legacy'],
  });
  assert.deepEqual(parsed.set, { zone: 'a' });
  assert.deepEqual(parsed.remove, ['legacy']);
});

test('node label patch rejects no-op and overlapping keys', () => {
  assert.throws(() =>
    NodeLabelsRequestSchema.parse({
      operationId: '00000000-0000-4000-8000-000000000011',
      expectedVersion: 5,
      set: {},
      remove: [],
    }),
  );
  assert.throws(() =>
    NodeLabelsRequestSchema.parse({
      operationId: '00000000-0000-4000-8000-000000000012',
      expectedVersion: 5,
      set: { zone: 'a' },
      remove: ['zone'],
    }),
  );
});
