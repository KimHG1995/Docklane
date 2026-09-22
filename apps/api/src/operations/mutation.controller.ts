import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { RequireRole } from '../auth/auth.decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/auth.types.js';
import {
  RestartServiceRequestSchema,
  ScaleServiceRequestSchema,
} from './mutation.dto.js';
import { MutationService } from './mutation.service.js';
import type { OperationRecord } from './operation.types.js';

@Controller('v1/clusters/:clusterId')
export class MutationController {
  constructor(private readonly mutations: MutationService) {}

  @Get('operations/:operationId')
  @RequireRole('VIEWER')
  operation(
    @Param('clusterId') clusterId: string,
    @Param('operationId') operationId: string,
  ): Promise<OperationRecord> {
    return this.mutations.operation(clusterId, operationId);
  }

  @Post('services/:serviceId/scale')
  @HttpCode(200)
  @RequireRole('OPERATOR')
  scale(
    @Param('clusterId') clusterId: string,
    @Param('serviceId') serviceId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<OperationRecord> {
    return this.mutations.scale(
      clusterId,
      serviceId,
      ScaleServiceRequestSchema.parse(body),
      principal(request),
    );
  }

  @Post('services/:serviceId/restart')
  @HttpCode(200)
  @RequireRole('OPERATOR')
  restart(
    @Param('clusterId') clusterId: string,
    @Param('serviceId') serviceId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<OperationRecord> {
    return this.mutations.restart(
      clusterId,
      serviceId,
      RestartServiceRequestSchema.parse(body),
      principal(request),
    );
  }
}

function principal(request: AuthenticatedRequest): Principal {
  if (!request.principal) {
    throw new Error('Authenticated principal is missing');
  }
  return request.principal;
}
