import { Inject, Injectable } from '@nestjs/common';
import { HealthEndpointPolicy } from './health-endpoint.policy.js';
import type { HealthCheckConfig } from './deployment.types.js';

@Injectable()
export class HealthVerifier {
  constructor(
    @Inject(HealthEndpointPolicy)
    private readonly endpointPolicy: HealthEndpointPolicy,
  ) {}

  async verify(
    config: HealthCheckConfig,
    assertConverged?: () => Promise<void>,
  ): Promise<void> {
    const url = new URL(config.url);
    await this.endpointPolicy.assertAllowed(url);

    const deadline =
      Date.now() +
      config.stabilityWindowMs +
      (config.retries + 1) * (config.timeoutMs + config.intervalMs);
    let stableSince: number | null = null;
    let failures = 0;

    while (Date.now() < deadline) {
      await assertConverged?.();
      let ok = false;
      try {
        const response = await this.safeFetch(url, config.timeoutMs);
        ok = response.status === config.expectedStatus;
        await response.body?.cancel();
      } catch {
        ok = false;
      }

      if (ok) {
        await assertConverged?.();
        stableSince ??= Date.now();
        if (Date.now() - stableSince >= config.stabilityWindowMs) {
          await assertConverged?.();
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

  private async safeFetch(
    initial: URL,
    timeoutMs: number,
  ): Promise<Response> {
    let current = new URL(initial);

    for (let redirects = 0; redirects <= 5; redirects += 1) {
      await this.endpointPolicy.assertAllowed(current);
      const response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return response;
      }

      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) {
        throw new Error('Health redirect did not include a Location header');
      }

      current = new URL(location, current);
    }

    throw new Error('Health endpoint exceeded the redirect limit');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
