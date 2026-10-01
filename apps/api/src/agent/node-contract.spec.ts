import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentIdentityResponseSchema,
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


test('Agent identity requires a local manager node identity', () => {
  const parsed = AgentIdentityResponseSchema.parse({
    component: 'docklane-agent',
    clusterId: 'cluster-1',
    nodeId: 'node-manager-01',
    hostname: 'manager-01',
    manager: true,
    leader: false,
  });
  assert.equal(parsed.nodeId, 'node-manager-01');
});

test('Agent identity rejects worker identities', () => {
  assert.throws(() =>
    AgentIdentityResponseSchema.parse({
      component: 'docklane-agent',
      clusterId: 'cluster-1',
      nodeId: 'node-worker-01',
      hostname: 'worker-01',
      manager: false,
      leader: false,
    }),
  );
});
