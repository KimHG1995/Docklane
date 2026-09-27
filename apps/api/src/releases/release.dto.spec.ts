import test from 'node:test';
import assert from 'node:assert/strict';
import { CreateReleaseRequestSchema } from './release.dto.js';

test('release creation requires immutable sha256 digest', () => {
  const valid = CreateReleaseRequestSchema.parse({
    version: '2026.09.28.1',
    imageRepository: 'registry.example.com/team/api',
    imageTag: 'latest',
    imageDigest: `sha256:${'a'.repeat(64)}`,
  });

  assert.equal(valid.imageDigest, `sha256:${'a'.repeat(64)}`);

  assert.throws(() =>
    CreateReleaseRequestSchema.parse({
      version: '2026.09.28.1',
      imageRepository: 'registry.example.com/team/api',
      imageTag: 'latest',
      imageDigest: 'latest',
    }),
  );
});

test('deployment target only accepts ingress routing in MVP', async () => {
  const { CreateDeploymentTargetRequestSchema } = await import('./release.dto.js');

  assert.equal(
    CreateDeploymentTargetRequestSchema.parse({
      environment: 'production',
      dockerServiceId: 'api',
      serviceName: 'ignored-by-server',
    }).routingMode,
    'INGRESS',
  );

  assert.throws(() =>
    CreateDeploymentTargetRequestSchema.parse({
      environment: 'production',
      dockerServiceId: 'api',
      serviceName: 'api',
      routingMode: 'HOST',
    }),
  );
});
