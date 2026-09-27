import test from 'node:test';
import assert from 'node:assert/strict';
import { ReleaseService } from './release.service.js';

const application = {
  id: 'app-1',
  name: 'api',
  description: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

test('deployment target binds canonical Swarm service identity', async () => {
  let persisted: unknown = null;
  const repository = {
    findApplication: async () => application,
    createDeploymentTarget: async (
      applicationId: string,
      clusterId: string,
      input: unknown,
    ) => {
      persisted = { applicationId, clusterId, input };
      return {
        id: 'target-1',
        applicationId,
        clusterId,
        ...(input as object),
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
    },
  };
  const agent = {
    inspectService: async () => ({
      service: {
        id: 'canonical-service-id',
        name: 'api-prod',
      },
    }),
  };

  const service = new ReleaseService(repository as never, agent as never);
  await service.createTarget(
    'default',
    'app-1',
    {
      environment: 'production',
      dockerServiceId: 'api-prod',
      serviceName: 'client-supplied-name',
      routingMode: 'INGRESS',
    },
  );

  assert.deepEqual(persisted, {
    applicationId: 'app-1',
    clusterId: 'default',
    input: {
      environment: 'production',
      dockerServiceId: 'canonical-service-id',
      serviceName: 'api-prod',
      routingMode: 'INGRESS',
    },
  });
});

test('release creation records actor and preserves digest identity', async () => {
  let captured: unknown = null;
  const repository = {
    findApplication: async () => application,
    createRelease: async (
      applicationId: string,
      input: unknown,
      createdBy: string,
    ) => {
      captured = { applicationId, input, createdBy };
      return {
        id: 'release-1',
        applicationId,
        ...(input as object),
        createdBy,
        createdAt: new Date(0).toISOString(),
      };
    },
  };

  const service = new ReleaseService(repository as never, {} as never);
  const input = {
    version: '1.0.0',
    imageRepository: 'registry.example.com/team/api',
    imageTag: '1.0.0',
    imageDigest: `sha256:${'b'.repeat(64)}`,
    gitCommit: 'abc123',
    buildNumber: '42',
  };

  await service.createRelease('app-1', input, {
    actorId: 'operator-1',
    role: 'OPERATOR',
    clusters: ['default'],
  });

  assert.deepEqual(captured, {
    applicationId: 'app-1',
    input,
    createdBy: 'operator-1',
  });
});
