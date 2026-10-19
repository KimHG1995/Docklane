import { BadRequestException, Body, Controller, ForbiddenException, Inject, NotFoundException, Param, Post, Get, Req, ConflictException } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { RequireRole } from '../auth/auth.decorators.js';
import { AGENT_CLIENT, type AgentClient } from '../agent/agent-client.js';
import { Database } from '../db/database.js';
import { ClusterBindingPolicy } from './cluster-binding.policy.js';
import { ClusterMaintenanceRepository } from './cluster-maintenance.repository.js';
import { MaintenanceManagerBarrier } from './maintenance-manager-barrier.js';
import { MaintenanceControlLease } from './maintenance-control-lease.js';
import { MaintenanceEvidenceRecovery, type EvidenceType } from './maintenance-evidence-recovery.js';

/**
 * Only an authenticated, scoped administrator can reconcile orphan evidence.
 * A fresh all-manager BLOCKED barrier must be ACKed before resolving any row.
 * Never automatically mark UNCERTAIN as ACKNOWLEDGED or delete raw evidence.
 */
@Controller('v1/clusters/:clusterId/maintenance/evidence')
@RequireRole('ADMIN')
export class MaintenanceEvidenceController {
  constructor(
    @Inject(ClusterBindingPolicy) private readonly binding: ClusterBindingPolicy,
    @Inject(ClusterMaintenanceRepository) private readonly maintenance: ClusterMaintenanceRepository,
    @Inject(MaintenanceManagerBarrier) private readonly barrier: MaintenanceManagerBarrier,
    @Inject(MaintenanceControlLease) private readonly leases: MaintenanceControlLease,
    @Inject(MaintenanceEvidenceRecovery) private readonly recovery: MaintenanceEvidenceRecovery,
    @Inject(AGENT_CLIENT) private readonly agent: AgentClient,
    @Inject(Database) private readonly db: Database,
  ) {}

  private async authorize(clusterId: string, request: AuthenticatedRequest): Promise<string> {
    const principal = request.principal;
    if (!principal || principal.role !== 'ADMIN' ||
        (!principal.clusters.includes('*') && !principal.clusters.includes(clusterId))) {
      throw new ForbiddenException('Scoped ADMIN recovery required');
    }
    if (clusterId !== this.binding.clusterId) throw new NotFoundException('Cluster not found');
    if (process.env.DOCKLANE_MAINTENANCE_ENFORCE !== '1' ||
        this.binding.settings.mode !== 'enforce' ||
        !this.binding.settings.expectedSwarmClusterId) {
      throw new ConflictException('Maintenance and registered Swarm enforcement required');
    }
    await this.binding.assertRegistered(clusterId);
    return principal.actorId;
  }

  @Get()
  async list(@Param('clusterId') clusterId: string, @Req() request: AuthenticatedRequest) {
    await this.authorize(clusterId, request);
    return this.recovery.list(clusterId);
  }

  @Post('resolve')
  async resolve(@Param('clusterId') clusterId: string,
    @Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const actorId = await this.authorize(clusterId, request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('Recovery evidence required');
    }
    const input = body as Record<string, unknown>;
    if ((input.type !== 'ADMISSION' && input.type !== 'DISPATCH') ||
        typeof input.evidenceId !== 'string' ||
        !/^[0-9a-fA-F-]{36}$/.test(input.evidenceId) ||
        typeof input.generation !== 'string' ||
        !/^[1-9][0-9]{0,19}$/.test(input.generation) ||
        typeof input.reason !== 'string' || !input.reason.trim() ||
        input.reason.length > 1024 ||
        typeof input.observation !== 'string' || !input.observation.trim() ||
        input.observation.length > 4096) {
      throw new BadRequestException('Malformed maintenance recovery proof');
    }
    const generation = BigInt(input.generation);
    if (generation > 18446744073709551615n) {
      throw new BadRequestException('Generation too large');
    }
    const lease = await this.leases.acquire(clusterId, 30);
    try {
      const current = await this.maintenance.requireRecord(clusterId);
      if (!['CLOSING','RECONCILING'].includes(current.state) || current.generation !== generation) {
        throw new ConflictException('Recovery requires current blocked maintenance generation');
      }
      // The BLOCKED acknowledgement waits for existing Agent handlers to
      // finish; incomplete Manager coverage MUST prevent evidence recovery.
      await this.barrier.blockAll(
        clusterId, this.binding.settings.expectedSwarmClusterId!, generation);
      // The resolver acquires the identical resource recovery lock used by
      // bootstrap reconciliation. Inspect only INSIDE that lock so neither a
      // stale observation nor a concurrently resolving CP can authorize a
      // different operation outcome.
      const observeResource = input.type === 'DISPATCH'
        ? async () => {
            const [rows] = await this.db.query<import('mysql2/promise').RowDataPacket[]>(
              `SELECT o.service_id AS resourceId, 'service' AS kind
               FROM maintenance_dispatches d JOIN operations o
                 ON o.id = d.operation_id AND o.cluster_id = d.cluster_id
               WHERE d.id = ? AND d.cluster_id = ?
               UNION ALL SELECT n.node_id AS resourceId, 'node' AS kind
               FROM maintenance_dispatches d JOIN node_operations n
                 ON n.id = d.operation_id AND n.cluster_id = d.cluster_id
               WHERE d.id = ? AND d.cluster_id = ?`,
              [input.evidenceId, clusterId, input.evidenceId, clusterId],
            );
            if (rows.length !== 1) {
              throw new ConflictException('Dispatch operation identity is ambiguous');
            }
            const item = rows[0]!;
            const actual = item.kind === 'service'
              ? (await this.agent.inspectService(item.resourceId as string)).service
              : (await this.agent.inspectNode(item.resourceId as string)).node;
            return { version: actual.version, specHash: actual.specHash };
          }
        : undefined;
      await this.recovery.resolve({
        clusterId, generation, type: input.type as EvidenceType,
        evidenceId: input.evidenceId, actorId, reason: input.reason,
        observation: input.observation, lease, observeResource,
      });
      return { resolved: true, evidenceId: input.evidenceId };
    } finally {
      try { await this.leases.release(lease); } catch { /* Never grant a second owner. */ }
    }
  }
}
