import { Controller, Get, Param } from '@nestjs/common';
import { RequireRole } from '../auth/auth.decorators.js';
import type {
  ClusterResponse,
  ServiceDetailResponse,
  ServiceSummary,
  TaskSummary,
} from '../agent/read-model.js';
import { ReadService } from './read.service.js';

@Controller('v1/clusters/:clusterId')
@RequireRole('VIEWER')
export class ReadController {
  constructor(private readonly readService: ReadService) {}

  @Get()
  cluster(@Param('clusterId') clusterId: string): Promise<ClusterResponse> {
    return this.readService.cluster(clusterId);
  }

  @Get('services')
  services(@Param('clusterId') clusterId: string): Promise<ServiceSummary[]> {
    return this.readService.services(clusterId);
  }

  @Get('services/:serviceId')
  service(
    @Param('clusterId') clusterId: string,
    @Param('serviceId') serviceId: string,
  ): Promise<ServiceDetailResponse> {
    return this.readService.service(clusterId, serviceId);
  }

  @Get('services/:serviceId/tasks')
  tasks(
    @Param('clusterId') clusterId: string,
    @Param('serviceId') serviceId: string,
  ): Promise<TaskSummary[]> {
    return this.readService.tasks(clusterId, serviceId);
  }
}
