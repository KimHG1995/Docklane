import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeMutationPlanSchema } from './read-model.js';

const base = {
  nodeId: 'node-1',
  version: 1,
  beforeSpecHash: 'before',
  targetSpecHash: 'target',
  targetAvailability: 'active' as const,
};

test('Agent node plans accept an explicit empty affected-service array', () => {
  const parsed = NodeMutationPlanSchema.parse({
    ...base,
    affectedServiceIds: [],
  });
  assert.deepEqual(parsed.affectedServiceIds, []);
});

test('Agent node plans reject null affected-service lists', () => {
  assert.throws(() =>
    NodeMutationPlanSchema.parse({
      ...base,
      affectedServiceIds: null,
    }),
  );
});
