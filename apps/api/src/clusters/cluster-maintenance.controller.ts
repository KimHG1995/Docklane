import { Controller, Get, Inject, NotFoundException, Param, Req, ForbiddenException } from '@nestjs/common';
import { RequireRole } from '../auth/auth.decorators.js';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { ClusterBindingPolicy } from './cluster-binding.policy.js';
import { ClusterMaintenanceRepository } from './cluster-maintenance.repository.js';

/**
 * Observation-only administrative endpoint. Do NOT expose raw repository CAS:
 * CLOSING/CLOSED and reopening require durable audit, in-flight checks and
 * all-manager barriers, none of which this controller can yet enforce.
 */
@Controller('v1/clusters/:clusterId/maintenance')
@RequireRole('ADMIN')
export class ClusterMaintenanceController {
  constructor(
    @Inject(ClusterMaintenanceRepository) private readonly maintenance: ClusterMaintenanceRepository,
    @Inject(ClusterBindingPolicy) private readonly binding: ClusterBindingPolicy,
  ) {}

  @Get()
  async get(@Param('clusterId') clusterId: string, @Req() request: AuthenticatedRequest) {
    const principal = request.principal;
    if (!principal || principal.role !== 'ADMIN' ||
        (!principal.clusters.includes('*') && !principal.clusters.includes(clusterId))) {
      throw new ForbiddenException('Maintenance read requires scoped ADMIN');
    }
    if (clusterId !== this.binding.clusterId) throw new NotFoundException('Cluster not found');
    await this.binding.assertRegistered(clusterId);
    const record = await this.maintenance.requireRecord(clusterId);
    // JSON.stringify cannot serialize bigint. Keep CAS generation lossless.
    return { ...record, generation: record.generation.toString() };
  }
}
