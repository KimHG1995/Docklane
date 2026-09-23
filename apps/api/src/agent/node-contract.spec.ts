import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NodeLabelMutationPlanSchema,
  NodeMutationPlanSchema,
} from './read-model.js';

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


test('Agent label plans preserve an explicit empty target label map', () => {
  const parsed = NodeLabelMutationPlanSchema.parse({
    ...base,
    affectedServiceIds: [],
    targetLabels: {},
  });
  assert.deepEqual(parsed.targetLabels, {});
});

test('Agent label plans reject a missing target label field', () => {
  assert.throws(() =>
    NodeLabelMutationPlanSchema.parse({
      ...base,
      affectedServiceIds: [],
    }),
  );
});
