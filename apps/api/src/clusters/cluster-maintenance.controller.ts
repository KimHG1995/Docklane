import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Req, ForbiddenException, BadRequestException, ConflictException } from '@nestjs/common';
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

  // Only OPEN -> CLOSING is exposed. CLOSED must await full manager barriers.
  @Post('close-request')
  async requestClosing(
    @Param('clusterId') clusterId: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    const principal = request.principal;
    if (!principal || principal.role !== 'ADMIN' ||
        (!principal.clusters.includes('*') && !principal.clusters.includes(clusterId))) {
      throw new ForbiddenException('Maintenance close requires scoped ADMIN');
    }
    if (clusterId !== this.binding.clusterId) throw new NotFoundException('Cluster not found');
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('Invalid maintenance request');
    }
    const value = body as Record<string, unknown>;
    if (typeof value.generation !== 'string' ||
        !/^[1-9][0-9]{0,19}$/.test(value.generation) ||
        typeof value.reason !== 'string' || !value.reason.trim() ||
        value.reason.length > 1024) {
      throw new BadRequestException('Invalid maintenance generation or reason');
    }
    await this.binding.assertRegistered(clusterId);
    const result = await this.maintenance.requestClosing(
      clusterId, BigInt(value.generation), principal.actorId, value.reason,
    );
    if (!result) throw new ConflictException('Maintenance state changed; refresh and retry');
    return this.get(clusterId, request);
  }

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
