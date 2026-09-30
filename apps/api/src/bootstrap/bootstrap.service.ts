import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AGENT_CLIENT, type AgentClient } from '../agent/agent-client.js';
import type { Principal } from '../auth/auth.types.js';
import { NodeMutationService } from '../operations/node-mutation.service.js';
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
  BootstrapTokenRecord,
} from './bootstrap.types.js';

const TOKEN_PREFIX = 'docklane_bootstrap_';

@Injectable()
export class BootstrapService {
  private readonly clusterId = process.env.DOCKLANE_CLUSTER_ID ?? 'default';

  constructor(
    @Inject(BootstrapRepository)
    private readonly repository: BootstrapRepository,
    @Inject(SwarmJoinCredentialProvider)
    private readonly swarmJoin: SwarmJoinCredentialProvider,
    @Inject(AGENT_CLIENT)
    private readonly agentClient: AgentClient,
    @Inject(NodeMutationService)
    private readonly nodeMutations: NodeMutationService,
  ) {}

  async issue(
    clusterId: string,
    input: CreateBootstrapTokenRequest,
    principal: Principal,
  ): Promise<BootstrapTokenIssueResponse> {
    this.assertCluster(clusterId);
    this.requireSwarmJoinCredentials(clusterId, input.nodeRole);

    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

    const record = await this.repository.create({
      id: randomUUID(),
      tokenHash: tokenHash(token),
      clusterId,
      nodeRole: input.nodeRole,
      labels: input.labels,
      createdBy: principal.actorId,
      ttlSeconds: input.ttlSeconds,
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
    this.assertCluster(pending.clusterId);

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
    this.assertCluster(record.clusterId);

    let observed;
    try {
      observed = await this.agentClient.inspectNode(input.nodeId);
    } catch {
      throw new BadGatewayException(
        'Joined node could not be verified through the cluster Agent',
      );
    }

    this.assertNodeMatchesBootstrapScope(record, observed.node);

    const binding = await this.repository.bindCompletionNode(
      record.id,
      input.claimId,
      observed.node.id,
    );
    if (binding === 'INACTIVE') {
      throw new UnauthorizedException(
        'Bootstrap claim is not active for this claimId',
      );
    }
    if (binding === 'CONFLICT') {
      throw new ConflictException(
        'Bootstrap claim is already bound to a different node',
      );
    }

    const verified = await this.applyBootstrapLabels(record, observed);
    const verifiedAt = new Date().toISOString();

    await this.repository.recordCompletionAudit(record, {
      nodeId: verified.node.id,
      hostname: verified.node.hostname,
      role: verified.node.role,
      labels: verified.node.labels,
      verifiedAt,
    });

    return {
      tokenId: record.id,
      claimId: input.claimId,
      clusterId: record.clusterId,
      nodeRole: record.nodeRole,
      labels: record.labels,
      node: {
        id: verified.node.id,
        hostname: verified.node.hostname,
        role: verified.node.role,
        state: verified.node.state,
        availability: verified.node.availability,
        labels: verified.node.labels,
      },
      verifiedAt,
    };
  }

  private async applyBootstrapLabels(
    record: BootstrapTokenRecord,
    observed: Awaited<ReturnType<AgentClient['inspectNode']>>,
  ): Promise<Awaited<ReturnType<AgentClient['inspectNode']>>> {
    if (Object.keys(record.labels).length === 0) {
      return observed;
    }

    let expectedVersion = observed.node.version;
    try {
      const existing = await this.nodeMutations.operation(
        record.clusterId,
        record.id,
      );
      expectedVersion = existing.expectedVersion;
    } catch (error) {
      if (!(error instanceof NotFoundException)) {
        throw error;
      }
    }

    const operation = await this.nodeMutations.labels(
      record.clusterId,
      observed.node.id,
      {
        operationId: record.id,
        expectedVersion,
        set: record.labels,
        remove: [],
      },
      {
        actorId: `bootstrap:${record.id}`,
        role: 'ADMIN',
        clusters: [record.clusterId],
      },
    );

    if (operation.status !== 'SUCCESS') {
      throw new ConflictException(
        `Bootstrap node labels did not converge: ${operation.status}`,
      );
    }

    let verified;
    try {
      verified = await this.agentClient.inspectNode(observed.node.id);
    } catch {
      throw new BadGatewayException(
        'Joined node labels could not be verified through the cluster Agent',
      );
    }

    this.assertNodeMatchesBootstrapScope(record, verified.node);
    for (const [key, value] of Object.entries(record.labels)) {
      if (verified.node.labels[key] !== value) {
        throw new ConflictException(
          'Joined node labels do not match bootstrap scope',
        );
      }
    }

    return verified;
  }

  private assertNodeMatchesBootstrapScope(
    record: BootstrapTokenRecord,
    node: Awaited<ReturnType<AgentClient['inspectNode']>>['node'],
  ): void {
    const expectedManager = record.nodeRole === 'manager';
    if (
      node.state !== 'ready' ||
      node.availability !== 'active' ||
      node.role !== record.nodeRole ||
      node.manager !== expectedManager
    ) {
      throw new ConflictException(
        'Joined node state or role does not match bootstrap scope',
      );
    }
  }

  private assertCluster(clusterId: string): void {
    if (clusterId !== this.clusterId) {
      throw new NotFoundException('Cluster not found');
    }
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
