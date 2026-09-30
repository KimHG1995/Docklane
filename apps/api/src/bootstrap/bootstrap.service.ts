import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AGENT_CLIENT, type AgentClient } from '../agent/agent-client.js';
import type { Principal } from '../auth/auth.types.js';
import type {
  BootstrapClaimRequest,
  BootstrapCompleteRequest,
  CreateBootstrapTokenRequest,
} from './bootstrap.dto.js';
import { BootstrapRepository } from './bootstrap.repository.js';
import { SwarmJoinCredentialProvider } from './swarm-join-credential.provider.js';
import type {
  BootstrapClaimResponse,
  BootstrapCompleteResponse,
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
    @Inject(AGENT_CLIENT)
    private readonly agentClient: AgentClient,
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
    const pending = await this.repository.findClaimableByHash(
      hash,
      input.claimId,
    );
    if (!pending) {
      throw new UnauthorizedException(
        'Invalid, expired, or already used bootstrap token',
      );
    }

    const swarmJoin = this.requireSwarmJoinCredentials(
      pending.clusterId,
      pending.nodeRole,
    );

    const consumed = await this.repository.consume(hash, input.claimId);
    if (!consumed) {
      throw new UnauthorizedException(
        'Invalid, expired, or claimed by another bootstrap request',
      );
    }

    const record = consumed.record;
    const claimedAt = record.usedAt;
    if (!claimedAt) {
      throw new Error('Consumed bootstrap claim is missing usedAt');
    }
    return {
      tokenId: record.id,
      clusterId: record.clusterId,
      nodeRole: record.nodeRole,
      labels: record.labels,
      expiresAt: record.expiresAt,
      claimedAt,
      claimId: input.claimId,
      replayed: consumed.replayed,
      swarmJoin,
    };
  }

  async complete(
    input: BootstrapCompleteRequest,
  ): Promise<BootstrapCompleteResponse> {
    const record = await this.repository.findClaimableByHash(
      tokenHash(input.token),
      input.claimId,
    );
    if (
      !record ||
      !record.usedAt ||
      record.claimId !== input.claimId
    ) {
      throw new UnauthorizedException(
        'Bootstrap claim is not active for this claimId',
      );
    }

    let observed;
    try {
      observed = await this.agentClient.inspectNode(input.nodeId);
    } catch {
      throw new BadGatewayException(
        'Joined node could not be verified through the cluster Agent',
      );
    }

    const expectedManager = record.nodeRole === 'manager';
    if (
      observed.node.state !== 'ready' ||
      observed.node.availability !== 'active' ||
      observed.node.role !== record.nodeRole ||
      observed.node.manager !== expectedManager
    ) {
      throw new ConflictException(
        'Joined node state or role does not match bootstrap scope',
      );
    }

    return {
      tokenId: record.id,
      claimId: input.claimId,
      clusterId: record.clusterId,
      nodeRole: record.nodeRole,
      labels: record.labels,
      node: {
        id: observed.node.id,
        hostname: observed.node.hostname,
        role: observed.node.role,
        state: observed.node.state,
        availability: observed.node.availability,
      },
      verifiedAt: new Date().toISOString(),
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
