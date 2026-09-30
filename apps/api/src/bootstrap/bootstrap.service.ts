import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Principal } from '../auth/auth.types.js';
import type {
  BootstrapClaimRequest,
  CreateBootstrapTokenRequest,
} from './bootstrap.dto.js';
import { BootstrapRepository } from './bootstrap.repository.js';
import { SwarmJoinCredentialProvider } from './swarm-join-credential.provider.js';
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
    @Inject(SwarmJoinCredentialProvider)
    private readonly swarmJoin: SwarmJoinCredentialProvider,
  ) {}

  async issue(
    clusterId: string,
    input: CreateBootstrapTokenRequest,
    principal: Principal,
  ): Promise<BootstrapTokenIssueResponse> {
    this.requireSwarmJoinCredentials(clusterId, input.nodeRole);

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
    const hash = tokenHash(input.token);
    const pending = await this.repository.findValidByHash(hash);
    if (!pending) {
      throw new UnauthorizedException(
        'Invalid, expired, or already used bootstrap token',
      );
    }

    const swarmJoin = this.requireSwarmJoinCredentials(
      pending.clusterId,
      pending.nodeRole,
    );

    const record = await this.repository.consume(hash);
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
      swarmJoin,
    };
  }

  private requireSwarmJoinCredentials(
    clusterId: string,
    nodeRole: BootstrapTokenIssueResponse['nodeRole'],
  ) {
    const credentials = this.swarmJoin.credentials(clusterId, nodeRole);
    if (!credentials) {
      throw new ServiceUnavailableException(
        `Swarm join credentials are not configured for cluster ${clusterId}`,
      );
    }
    return credentials;
  }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
