import { Injectable } from '@nestjs/common';
import type { HealthCheckConfig } from './deployment.types.js';

@Injectable()
export class HealthVerifier {
  async verify(config: HealthCheckConfig): Promise<void> {
    const url = new URL(config.url);
    if (url.username || url.password) {
      throw new Error('Health URL must not contain credentials');
    }

    const stableUntil = Date.now() + config.stabilityWindowMs;
    let failures = 0;

    while (Date.now() < stableUntil) {
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

      if (!ok) {
        failures += 1;
        if (failures > config.retries) {
          throw new Error(
            `Health verification failed after ${failures} unsuccessful checks`,
          );
        }
      } else {
        failures = 0;
      }

      if (Date.now() < stableUntil) {
        await sleep(config.intervalMs);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
