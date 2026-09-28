import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRequestError } from '../agent/agent-client.js';
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
      actorId: string,
    ) => {
      persisted = { applicationId, clusterId, input, actorId };
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
        mode: 'replicated',
      },
    }),
  };

  const service = new ReleaseService(
    repository as never,
    agent as never,
    {} as never,
  );
  await service.createTarget(
    'default',
    'app-1',
    {
      environment: 'production',
      dockerServiceId: 'api-prod',
      serviceName: 'client-supplied-name',
      routingMode: 'INGRESS',
    },
    {
      actorId: 'operator-1',
      role: 'OPERATOR',
      clusters: ['default'],
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
    actorId: 'operator-1',
  });
});

test('release creation resolves a tag and persists only the immutable digest', async () => {
  let captured: unknown = null;
  const digest = `sha256:${'b'.repeat(64)}`;
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
  const registry = {
    resolve: async (imageRepository: string, reference: string) => {
      assert.equal(imageRepository, 'registry.example.com/team/api');
      assert.equal(reference, '1.0.0');
      return {
        repository: imageRepository,
        reference,
        digest,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        contentLength: 123,
      };
    },
  };

  const service = new ReleaseService(
    repository as never,
    {} as never,
    registry as never,
  );
  const input = {
    version: '1.0.0',
    imageRepository: 'registry.example.com/team/api',
    imageTag: '1.0.0',
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
    input: {
      ...input,
      imageDigest: digest,
    },
    createdBy: 'operator-1',
  });
});

test('release creation verifies an explicitly supplied digest', async () => {
  const digest = `sha256:${'c'.repeat(64)}`;
  let persisted = false;
  const repository = {
    findApplication: async () => application,
    createRelease: async () => {
      persisted = true;
      throw new Error('must not persist');
    },
  };
  const registry = {
    resolve: async () => ({
      repository: 'registry.example.com/team/api',
      reference: digest,
      digest: `sha256:${'d'.repeat(64)}`,
      mediaType: null,
      contentLength: null,
    }),
  };

  const service = new ReleaseService(
    repository as never,
    {} as never,
    registry as never,
  );

  await assert.rejects(
    service.createRelease(
      'app-1',
      {
        version: '1.0.0',
        imageRepository: 'registry.example.com/team/api',
        imageDigest: digest,
      },
      {
        actorId: 'operator-1',
        role: 'OPERATOR',
        clusters: ['default'],
      },
    ),
    /does not match/,
  );

  assert.equal(persisted, false);
});


test('deployment target rejects unsupported Swarm service modes before persistence', async () => {
  let persisted = false;
  const repository = {
    findApplication: async () => application,
    createDeploymentTarget: async () => {
      persisted = true;
      throw new Error('must not persist');
    },
  };
  const agent = {
    inspectService: async () => ({
      service: {
        id: 'global-service',
        name: 'global-service',
        mode: 'global',
      },
    }),
  };
  const service = new ReleaseService(
    repository as never,
    agent as never,
    {} as never,
  );

  await assert.rejects(
    service.createTarget(
      'default',
      'app-1',
      {
        environment: 'production',
        dockerServiceId: 'global-service',
        serviceName: 'global-service',
        routingMode: 'INGRESS',
      },
      {
        actorId: 'operator-1',
        role: 'OPERATOR',
        clusters: ['default'],
      },
    ),
    /only supports replicated services/,
  );
  assert.equal(persisted, false);
});

test('deployment target preserves Agent failures instead of returning service not found', async () => {
  const repository = {
    findApplication: async () => application,
  };
  const agent = {
    inspectService: async () => {
      throw new AgentRequestError(502, 'upstream unavailable');
    },
  };
  const service = new ReleaseService(
    repository as never,
    agent as never,
    {} as never,
  );

  await assert.rejects(
    service.createTarget(
      'default',
      'app-1',
      {
        environment: 'production',
        dockerServiceId: 'api',
        serviceName: 'api',
        routingMode: 'INGRESS',
      },
      {
        actorId: 'operator-1',
        role: 'OPERATOR',
        clusters: ['default'],
      },
    ),
    /Agent service lookup failed with HTTP 502/,
  );
});
