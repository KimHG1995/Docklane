import {
  BadRequestException, Body, ConflictException, Controller,
  ForbiddenException, Inject, NotFoundException, Param, Post, Req,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { RequireRole } from '../auth/auth.decorators.js';
import { ClusterBindingPolicy } from './cluster-binding.policy.js';
import { ClusterMaintenanceRepository } from './cluster-maintenance.repository.js';
import { MaintenanceManagerBarrier } from './maintenance-manager-barrier.js';
import { MaintenanceControlLease } from './maintenance-control-lease.js';

const MAX_GENERATION = 18446744073709551615n;
/**
 * Deliberate two-phase recovery:
 * CLOSED -> RECONCILING: retains blocked agents.
 * RECONCILING -> OPEN: first commits guarded DB state + audit, then opens
 * managers. A partial OPEN acknowledgement can be retried without another
 * state transition or HTTP mutation replay.
 */
@Controller('v1/clusters/:clusterId/maintenance')
@RequireRole('ADMIN')
export class MaintenanceRecoveryController {
  constructor(
    @Inject(ClusterBindingPolicy) private readonly binding: ClusterBindingPolicy,
    @Inject(ClusterMaintenanceRepository) private readonly maintenance: ClusterMaintenanceRepository,
    @Inject(MaintenanceManagerBarrier) private readonly barriers: MaintenanceManagerBarrier,
    @Inject(MaintenanceControlLease) private readonly leases: MaintenanceControlLease,
  ) {}

  private async check(clusterId: string, request: AuthenticatedRequest, payload: unknown) {
    const principal = request.principal;
    if (!principal || principal.role !== 'ADMIN' ||
        (!principal.clusters.includes('*') && !principal.clusters.includes(clusterId))) {
      throw new ForbiddenException('Maintenance recovery requires scoped ADMIN');
    }
    if (clusterId !== this.binding.clusterId) throw new NotFoundException('Cluster not found');
    if (process.env.DOCKLANE_MAINTENANCE_ENFORCE !== '1' ||
        this.binding.settings.mode !== 'enforce' ||
        !this.binding.settings.expectedSwarmClusterId) {
      throw new ConflictException('Enforced cluster registration and maintenance required');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new BadRequestException('Invalid recovery request');
    }
    const body = payload as Record<string, unknown>;
    if (typeof body.generation !== 'string' ||
        !/^[1-9][0-9]{0,19}$/.test(body.generation) ||
        typeof body.reason !== 'string' || !body.reason.trim() ||
        body.reason.length > 1024) {
      throw new BadRequestException('Generation and bounded reason are required');
    }
    const generation = BigInt(body.generation);
    if (generation >= MAX_GENERATION) {
      throw new BadRequestException('Maintenance generation cannot increment');
    }
    await this.binding.assertRegistered(clusterId);
    return { generation, actor: principal.actorId, reason: body.reason,
      swarmId: this.binding.settings.expectedSwarmClusterId };
  }

  @Post('begin-reconciliation')
  async beginReconciliation(
    @Param('clusterId') clusterId: string, @Req() request: AuthenticatedRequest,
    @Body() payload: unknown,
  ) {
    const input = await this.check(clusterId, request, payload);
    const lease = await this.leases.acquire(clusterId, 30);
    try {
      const updated = await this.maintenance.commitRecoveryTransition(
        clusterId, input.generation, input.actor, input.reason, 'CLOSED', lease);
      if (!updated) throw new ConflictException('Maintenance recovery generation changed');
      return { clusterId, state: 'RECONCILING' as const,
        generation: (input.generation + 1n).toString() };
    } finally {
      try { await this.leases.release(lease); } catch { /* Lost lease never grants reopening. */ }
    }
  }

  @Post('complete-reconciliation')
  async completeReconciliation(
    @Param('clusterId') clusterId: string, @Req() request: AuthenticatedRequest,
    @Body() payload: unknown,
  ) {
    const input = await this.check(clusterId, request, payload);
    const lease = await this.leases.acquire(clusterId, 30);
    try {
      // Recheck all current manager identities and persist BLOCKED for this
      // reconciliation generation before making any Agent OPEN.
      const blocked = await this.barriers.blockAll(clusterId, input.swarmId, input.generation);
      const updated = await this.maintenance.commitRecoveryTransition(
        clusterId, input.generation, input.actor, input.reason, 'RECONCILING',
        lease, blocked.blockedManagerIds);
      if (!updated) throw new ConflictException('Maintenance recovery generation changed');
      const openGeneration = input.generation + 1n;
      await this.barriers.openAll(clusterId, input.swarmId, openGeneration);
      return { clusterId, state: 'OPEN' as const,
        generation: openGeneration.toString(), managersReady: true };
    } finally {
      try { await this.leases.release(lease); } catch { /* Never retry a committed transition. */ }
    }
  }

  @Post('resume-managers')
  async resumeManagers(
    @Param('clusterId') clusterId: string, @Req() request: AuthenticatedRequest,
    @Body() payload: unknown,
  ) {
    const input = await this.check(clusterId, request, payload);
    const lease = await this.leases.acquire(clusterId, 30);
    try {
      // Safe idempotent recovery after an OPEN database commit where the
      // manager re-open acknowledgement was lost or only partially delivered.
      const result = await this.barriers.openAll(
        clusterId, input.swarmId, input.generation);
      return { clusterId, state: 'OPEN' as const,
        generation: input.generation.toString(), managersReady: true,
        openManagerIds: result.openManagerIds };
    } finally {
      try { await this.leases.release(lease); } catch { /* Fail-closed status remains. */ }
    }
  }
}
