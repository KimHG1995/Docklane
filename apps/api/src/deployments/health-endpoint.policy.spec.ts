import test from 'node:test';
import assert from 'node:assert/strict';
import { HealthEndpointPolicy } from './health-endpoint.policy.js';

test('health endpoint policy rejects localhost by default', async () => {
  const previous = process.env.DOCKLANE_HEALTH_PRIVATE_HOSTS;
  delete process.env.DOCKLANE_HEALTH_PRIVATE_HOSTS;
  try {
    const policy = new HealthEndpointPolicy();
    await assert.rejects(
      policy.assertAllowed(new URL('https://localhost/ready')),
      /explicitly allowlisted/,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.DOCKLANE_HEALTH_PRIVATE_HOSTS;
    } else {
      process.env.DOCKLANE_HEALTH_PRIVATE_HOSTS = previous;
    }
  }
});

test('health endpoint policy allows explicitly configured private LB', async () => {
  const previous = process.env.DOCKLANE_HEALTH_PRIVATE_HOSTS;
  process.env.DOCKLANE_HEALTH_PRIVATE_HOSTS = 'lb.internal:8080';
  try {
    const policy = new HealthEndpointPolicy();
    await policy.assertAllowed(new URL('http://lb.internal:8080/ready'));
  } finally {
    if (previous === undefined) {
      delete process.env.DOCKLANE_HEALTH_PRIVATE_HOSTS;
    } else {
      process.env.DOCKLANE_HEALTH_PRIVATE_HOSTS = previous;
    }
  }
});
