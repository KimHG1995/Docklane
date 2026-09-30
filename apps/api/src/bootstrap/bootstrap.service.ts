import {
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Principal } from '../auth/auth.types.js';
import type {
  BootstrapClaimRequest,
  CreateBootstrapTokenRequest,
} from './bootstrap.dto.js';
import { BootstrapRepository } from './bootstrap.repository.js';
import type {
  BootstrapClaimResponse,
  BootstrapTokenIssueResponse,
} from './bootstrap.types.js';

const TOKEN_PREFIX = 'docklane_bootstrap_';

@Injectable()
export class BootstrapService {
  constructor(
    @Inject(BootstrapRepository)
    private readonly repository: BootstrapRepository,
  ) {}

  async issue(
    clusterId: string,
    input: CreateBootstrapTokenRequest,
    principal: Principal,
  ): Promise<BootstrapTokenIssueResponse> {
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);

    const record = await this.repository.create({
      id: randomUUID(),
      tokenHash: tokenHash(token),
      clusterId,
      nodeRole: input.nodeRole,
      labels: input.labels,
      createdBy: principal.actorId,
      expiresAt,
    });

    return {
      ...record,
      token,
    };
  }

  async claim(input: BootstrapClaimRequest): Promise<BootstrapClaimResponse> {
    const record = await this.repository.consume(tokenHash(input.token));
    if (!record || !record.usedAt) {
      throw new UnauthorizedException(
        'Invalid, expired, or already used bootstrap token',
      );
    }

    return {
      tokenId: record.id,
      clusterId: record.clusterId,
      nodeRole: record.nodeRole,
      labels: record.labels,
      expiresAt: record.expiresAt,
      claimedAt: record.usedAt,
    };
  }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
