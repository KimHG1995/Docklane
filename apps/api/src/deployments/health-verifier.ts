import { Inject, Injectable } from '@nestjs/common';
import { HealthEndpointPolicy } from './health-endpoint.policy.js';
import type { HealthCheckConfig } from './deployment.types.js';

@Injectable()
export class HealthVerifier {
  constructor(
    @Inject(HealthEndpointPolicy)
    private readonly endpointPolicy: HealthEndpointPolicy,
  ) {}

  async verify(config: HealthCheckConfig): Promise<void> {
    const url = new URL(config.url);
    await this.endpointPolicy.assertAllowed(url);

    const deadline =
      Date.now() +
      config.stabilityWindowMs +
      (config.retries + 1) * (config.timeoutMs + config.intervalMs);
    let stableSince: number | null = null;
    let failures = 0;

    while (Date.now() < deadline) {
      let ok = false;
      try {
        const response = await fetch(url, {
          method: 'GET',
          redirect: 'follow',
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        ok = response.status === config.expectedStatus;
        await response.body?.cancel();
      } catch {
        ok = false;
      }

      if (ok) {
        stableSince ??= Date.now();
        if (Date.now() - stableSince >= config.stabilityWindowMs) {
          return;
        }
      } else {
        stableSince = null;
        failures += 1;
        if (failures > config.retries) {
          throw new Error(
            `Health verification failed after ${failures} unsuccessful checks`,
          );
        }
      }

      await sleep(config.intervalMs);
    }

    throw new Error('Health endpoint did not remain stable for the required window');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
