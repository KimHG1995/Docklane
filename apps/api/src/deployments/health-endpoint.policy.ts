import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Injectable } from '@nestjs/common';

@Injectable()
export class HealthEndpointPolicy {
  private readonly privateHosts = new Set(
    (process.env.DOCKLANE_HEALTH_PRIVATE_HOSTS ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );

  async assertAllowed(url: URL): Promise<void> {
    if (url.username || url.password) {
      throw new Error('Health URL must not contain credentials');
    }
    if (this.privateHosts.has(url.host.toLowerCase())) {
      return;
    }
    if (url.protocol !== 'https:') {
      throw new Error('Public health endpoints must use HTTPS');
    }

    const hostname = url.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local')
    ) {
      throw new Error(
        'Private health endpoints must be explicitly allowlisted',
      );
    }

    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error('Health endpoint hostname could not be resolved');
    }

    if (
      addresses.length === 0 ||
      addresses.some(({ address }) => isPrivateAddress(address))
    ) {
      throw new Error(
        'Private health endpoints must be explicitly allowlisted',
      );
    }
  }
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    if (octets.length !== 4) return true;
    const a = octets[0]!;
    const b = octets[1]!;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }

  if (family === 6) {
    const value = address.toLowerCase();
    return (
      value === '::' ||
      value === '::1' ||
      value.startsWith('fe8') ||
      value.startsWith('fe9') ||
      value.startsWith('fea') ||
      value.startsWith('feb') ||
      value.startsWith('fc') ||
      value.startsWith('fd') ||
      value.startsWith('ff')
    );
  }

  return true;
}
