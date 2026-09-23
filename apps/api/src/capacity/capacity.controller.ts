import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import {
  CapacityCheckRequestSchema,
  type CapacityCheckResponse,
} from '../agent/capacity-model.js';
import { RequireRole } from '../auth/auth.decorators.js';
import { CapacityService } from './capacity.service.js';

@Controller('v1/clusters/:clusterId/services/:serviceId/capacity-check')
@RequireRole('VIEWER')
export class CapacityController {
  constructor(
    @Inject(CapacityService) private readonly capacity: CapacityService,
  ) {}

  @Post()
  check(
    @Param('clusterId') clusterId: string,
    @Param('serviceId') serviceId: string,
    @Body() body: unknown,
  ): Promise<CapacityCheckResponse> {
    const parsed = CapacityCheckRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('Invalid capacity check request');
    }
    return this.capacity.check(clusterId, serviceId, parsed.data);
  }
}
