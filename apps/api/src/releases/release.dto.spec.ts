import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CreateDeploymentTargetRequestSchema,
  CreateReleaseRequestSchema,
} from './release.dto.js';

test('release creation accepts a tag that will be resolved server-side', () => {
  const valid = CreateReleaseRequestSchema.parse({
    version: '2026.09.28.1',
    imageRepository: 'registry.example.com/team/api',
    imageTag: 'latest',
  });

  assert.equal(valid.imageTag, 'latest');
  assert.equal(valid.imageDigest, undefined);
});

test('release creation accepts an immutable sha256 digest', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const valid = CreateReleaseRequestSchema.parse({
    version: '2026.09.28.1',
    imageRepository: 'registry.example.com/team/api',
    imageDigest: digest,
  });

  assert.equal(valid.imageDigest, digest);
});

test('release creation rejects missing or malformed image references', () => {
  assert.throws(() =>
    CreateReleaseRequestSchema.parse({
      version: '2026.09.28.1',
      imageRepository: 'registry.example.com/team/api',
    }),
  );

  assert.throws(() =>
    CreateReleaseRequestSchema.parse({
      version: '2026.09.28.1',
      imageRepository: 'registry.example.com/team/api',
      imageDigest: 'latest',
    }),
  );
});

test('deployment target only accepts ingress routing in MVP', () => {
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
