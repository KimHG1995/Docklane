import test from 'node:test';
import assert from 'node:assert/strict';
import { RegistryEndpointPolicy } from './registry-endpoint.policy.js';

test('registry endpoint policy rejects local hosts by default', async () => {
  const previous = process.env.DOCKLANE_REGISTRY_PRIVATE_HOSTS;
  delete process.env.DOCKLANE_REGISTRY_PRIVATE_HOSTS;

  try {
    const policy = new RegistryEndpointPolicy();
    await assert.rejects(
      policy.assertAllowed(new URL('https://localhost:5000')),
      /explicitly allowlisted/,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.DOCKLANE_REGISTRY_PRIVATE_HOSTS;
    } else {
      process.env.DOCKLANE_REGISTRY_PRIVATE_HOSTS = previous;
    }
  }
});

test('registry endpoint policy permits explicitly allowlisted private host', async () => {
  const previous = process.env.DOCKLANE_REGISTRY_PRIVATE_HOSTS;
  process.env.DOCKLANE_REGISTRY_PRIVATE_HOSTS = 'registry.internal:5000';

  try {
    const policy = new RegistryEndpointPolicy();
    await policy.assertAllowed(new URL('http://registry.internal:5000'));
  } finally {
    if (previous === undefined) {
      delete process.env.DOCKLANE_REGISTRY_PRIVATE_HOSTS;
    } else {
      process.env.DOCKLANE_REGISTRY_PRIVATE_HOSTS = previous;
    }
  }
});
