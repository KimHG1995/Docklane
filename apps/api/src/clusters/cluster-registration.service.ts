import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AgentClient } from '../agent/agent-client.js';
import { HttpAgentClient } from '../agent/http-agent.client.js';
import {
  MANAGER_AGENT_CONFIG,
  resolveExpectedClusterId,
  type ManagerAgentConfig,
} from '../agent/agent-config.js';
import type { Principal } from '../auth/auth.types.js';
import { ClusterRegistrationRepository } from './cluster-registration.repository.js';
import {
  isBoundedIdentifier,
  isDisplayName,
  matchesRegistration,
  type ClusterRegistrationRecord,
  type ClusterRegistrationView,
  type RegisterClusterRequest,
} from './cluster-registration.types.js';

@Injectable()
export class ClusterRegistrationService {
  private readonly clusterId = process.env.DOCKLANE_CLUSTER_ID ?? 'default';
  private readonly expectedClusterId: string | null;

  constructor(
    @Inject(HttpAgentClient) private readonly agent: AgentClient,
    @Inject(ClusterRegistrationRepository) private readonly registrations: ClusterRegistrationRepository,
    @Inject(MANAGER_AGENT_CONFIG) registry: ManagerAgentConfig,
  ) {
    this.expectedClusterId = resolveExpectedClusterId(
      registry.expectedClusterId,
      registry.agents.every((agent) => agent.insecureDev === true),
    );
  }

  async register(
    clusterId: string,
    input: RegisterClusterRequest,
    principal: Principal,
  ): Promise<ClusterRegistrationRecord> {
    this.assertAccess(clusterId, principal);
    if (!isBoundedIdentifier(input?.swarmClusterId) || !isDisplayName(input?.displayName)) {
      throw new BadRequestException('Invalid cluster registration request');
    }
    const requested = { clusterId, swarmClusterId: input.swarmClusterId, displayName: input.displayName };
    if (this.expectedClusterId === null || requested.swarmClusterId !== this.expectedClusterId) {
      throw new ConflictException('Registration requires the explicitly configured Swarm cluster ID');
    }

    const existing = await this.registrations.find(clusterId);
    if (existing) {
      if (!matchesRegistration(existing, requested)) {
        throw new ConflictException('Cluster is already registered with different immutable metadata');
      }
      // Replay a committed result, not a fresh verification. Do not require the
      // Agent to be reachable after the caller lost the original response.
      return existing;
    }

    let identity;
    try {
      identity = await this.agent.identity();
    } catch {
      throw new BadGatewayException('Unable to verify the configured manager identity');
    }
    if (!identity || identity.component !== 'docklane-agent' || identity.manager !== true ||
        !isBoundedIdentifier(identity.nodeId)) {
      throw new BadGatewayException('Agent did not provide a valid manager identity');
    }
    if (identity.clusterId !== this.expectedClusterId) {
      throw new ConflictException('Current Agent cluster does not match the registration target');
    }

    return this.registrations.register({
      ...requested,
      registeredBy: principal.actorId,
      verifiedNodeId: identity.nodeId,
    });
  }

  async get(clusterId: string, principal: Principal): Promise<ClusterRegistrationView> {
    this.assertAccess(clusterId, principal);
    const registration = await this.registrations.find(clusterId);
    if (!registration) throw new NotFoundException('Cluster registration not found');
    return {
      registration,
      configuredSwarmClusterId: this.expectedClusterId,
      matchesConfiguration: registration.swarmClusterId === this.expectedClusterId,
    };
  }

  private assertAccess(clusterId: string, principal: Principal): void {
    if (!principal || principal.role !== 'ADMIN' ||
        (!principal.clusters.includes('*') && !principal.clusters.includes(clusterId))) {
      throw new ForbiddenException('Cluster registration requires a scoped ADMIN');
    }
    if (clusterId !== this.clusterId) throw new NotFoundException('Cluster not found');
    if (!isBoundedIdentifier(clusterId)) {
      throw new BadRequestException('Cluster registration requires a bounded logical identifier');
    }
  }
}
