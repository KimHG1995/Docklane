import test from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import { CapacityService } from './capacity.service.js';

const request = {
  expectedVersion: 10,
  targetReplicas: 4,
  includeUpdateOverlap: false,
};

function response(status: 'SUFFICIENT' | 'INSUFFICIENT' | 'UNKNOWN') {
  return {
    serviceId: 'service-1',
    status,
    currentReplicas: 2,
    targetReplicas: 4,
    updateOverlapReplicas: 0,
    requiredAdditionalReplicas: 2,
    schedulableAdditionalReplicas: status === 'INSUFFICIENT' ? 1 : 2,
    unplacedReplicas: status === 'INSUFFICIENT' ? 1 : 0,
    eligibleNodeCount: 2,
    reservation: { nanoCpus: 1_000_000_000, memoryBytes: 536_870_912 },
    reasons: status === 'UNKNOWN' ? ['NO_CPU_OR_MEMORY_RESERVATION'] : [],
    unsupportedConstraints: [],
    nodes: [],
  } as const;
}

test('capacity pre-check blocks confirmed insufficient capacity', async () => {
  const agent = {
    checkServiceCapacity: async () => response('INSUFFICIENT'),
  };
  const service = new CapacityService(agent as never);

  await assert.rejects(
    service.assertAvailable('service-1', request),
    (error: unknown) =>
      error instanceof ConflictException &&
      (error.getResponse() as { code?: string }).code ===
        'INSUFFICIENT_CLUSTER_CAPACITY',
  );
});

test('capacity pre-check allows unknown estimates to defer to Swarm', async () => {
  const agent = {
    checkServiceCapacity: async () => response('UNKNOWN'),
  };
  const service = new CapacityService(agent as never);

  const result = await service.assertAvailable('service-1', request);
  assert.equal(result.status, 'UNKNOWN');
});
