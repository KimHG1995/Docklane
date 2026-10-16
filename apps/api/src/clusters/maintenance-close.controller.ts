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

/**
 * Operator-controlled OPEN->CLOSING->CLOSED finalisation. This controller lives
 * in AgentModule (not ClusterBindingModule) to avoid circular module imports.
 *
 * No rejoin/reopen endpoints are provided. A partial manager block remains
 * fail-closed and may be retried by the same generation after investigation.
 * Outside writers of the Docker socket are an operational security boundary.
 */
@Controller('v1/clusters/:clusterId/maintenance')
@RequireRole('ADMIN')
export class MaintenanceCloseController {
  constructor(
    @Inject(ClusterBindingPolicy) private readonly binding: ClusterBindingPolicy,
    @Inject(ClusterMaintenanceRepository) private readonly maintenance: ClusterMaintenanceRepository,
    @Inject(MaintenanceManagerBarrier) private readonly barrier: MaintenanceManagerBarrier,
    @Inject(MaintenanceControlLease) private readonly controlLease: MaintenanceControlLease,
  ) {}

  @Post('confirm-closed')
  async confirmClosed(
    @Param('clusterId') clusterId: string,
    @Req() request: AuthenticatedRequest,
    @Body() payload: unknown,
  ): Promise<{ clusterId: string; state: 'CLOSED'; generation: string }> {
    const principal = request.principal;
    if (!principal || principal.role !== 'ADMIN' ||
        (!principal.clusters.includes('*') && !principal.clusters.includes(clusterId))) {
      throw new ForbiddenException('Maintenance closure requires scoped ADMIN');
    }
    if (clusterId !== this.binding.clusterId) throw new NotFoundException('Cluster not found');
    if (process.env.DOCKLANE_MAINTENANCE_ENFORCE !== '1' ||
        this.binding.settings.mode !== 'enforce' ||
        !this.binding.settings.expectedSwarmClusterId) {
      throw new ConflictException('Maintenance enforcement and fixed registration are required');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new BadRequestException('Invalid closure request');
    }
    const body = payload as Record<string, unknown>;
    if (typeof body.generation !== 'string' ||
        !/^[1-9][0-9]{0,19}$/.test(body.generation) ||
        typeof body.reason !== 'string' || !body.reason.trim() ||
        body.reason.length > 1024) {
      throw new BadRequestException('A bounded reason and decimal generation are required');
    }
    const generation = BigInt(body.generation);
    if (generation > 18446744073709551615n) {
      throw new BadRequestException('Maintenance generation exceeds MySQL BIGINT range');
    }
    await this.binding.assertRegistered(clusterId);
    // Only one coordinator may collect ACK and commit closure at a time.
    // Lease expiry during a long barrier fails closed in commitClosed.
    const lease = await this.controlLease.acquire(clusterId, 30);
    try {
      const result = await this.barrier.blockAll(
        clusterId, this.binding.settings.expectedSwarmClusterId, generation);
      const updated = await this.maintenance.commitClosed(
        clusterId, generation, principal.actorId, body.reason,
        result.blockedManagerIds, lease);
      if (!updated) throw new ConflictException('Maintenance closure generation changed');
      return { clusterId, state: 'CLOSED', generation: (generation + 1n).toString() };
    } finally {
      try { await this.controlLease.release(lease); }
      catch { /* A lost lease must never turn a successful/failed close into a retry. */ }
    }
  }
}
