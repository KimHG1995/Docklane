import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException,
  Inject, NotFoundException, Param, Post, Req,
} from '@nestjs/common';
import { RequireRole } from '../auth/auth.decorators.js';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { HttpAgentClient } from '../agent/http-agent.client.js';
import { ClusterBindingPolicy } from './cluster-binding.policy.js';
import { ClusterMaintenanceRepository } from './cluster-maintenance.repository.js';

/** No startup auto-open: scoped administrator explicitly pins live Swarm identity. */
@Controller('v1/clusters/:clusterId/maintenance')
@RequireRole('ADMIN')
export class MaintenanceInitializeController {
  constructor(
    @Inject(ClusterBindingPolicy) private readonly binding: ClusterBindingPolicy,
    @Inject(ClusterMaintenanceRepository) private readonly maintenance: ClusterMaintenanceRepository,
    @Inject(HttpAgentClient) private readonly agent: HttpAgentClient,
  ) {}

  @Post('initialize')
  async initialize(@Param('clusterId') clusterId: string,
    @Req() request: AuthenticatedRequest, @Body() payload: unknown) {
    const principal = request.principal;
    if (!principal || principal.role !== 'ADMIN' ||
        (!principal.clusters.includes('*') && !principal.clusters.includes(clusterId))) {
      throw new ForbiddenException('Maintenance initialization requires scoped ADMIN');
    }
    if (clusterId !== this.binding.clusterId) throw new NotFoundException('Cluster not found');
    const expected = this.binding.settings.expectedSwarmClusterId;
    if (this.binding.settings.mode !== 'enforce' || !expected) {
      throw new ConflictException('Fixed real Swarm registration enforcement is required');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        typeof (payload as Record<string, unknown>).reason !== 'string' ||
        !(payload as {reason:string}).reason.trim() ||
        (payload as {reason:string}).reason.length > 1024) {
      throw new BadRequestException('A bounded initialization reason is required');
    }
    await this.binding.assertRegistered(clusterId);
    // Fresh identity from the running Docker Manager, not a cached registered
    // logical alias. On mismatch or outage NEVER create the OPEN record.
    const actual = await this.agent.identity();
    if (!actual.manager || actual.clusterId !== expected || !actual.nodeId) {
      throw new ConflictException('Current Docker Swarm differs from registered cluster');
    }
    const record = await this.maintenance.initializeOpen(
      clusterId, principal.actorId, (payload as {reason:string}).reason);
    return { ...record, generation: record.generation.toString() };
  }
}
