import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { RequireRole } from '../auth/auth.decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/auth.types.js';
import { DeployRequestSchema } from './deployment.dto.js';
import { DeploymentService } from './deployment.service.js';
import type { DeploymentRecord } from './deployment.types.js';

@Controller('v1/clusters/:clusterId')
export class DeploymentController {
  constructor(
    @Inject(DeploymentService)
    private readonly deployments: DeploymentService,
  ) {}

  @Post('targets/:targetId/deploy')
  @HttpCode(200)
  @RequireRole('OPERATOR')
  deploy(
    @Param('clusterId') clusterId: string,
    @Param('targetId') targetId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<DeploymentRecord> {
    let input;
    try {
      input = DeployRequestSchema.parse(body);
    } catch {
      throw new BadRequestException('Invalid deployment request');
    }
    return this.deployments.deploy(
      clusterId,
      targetId,
      input,
      principal(request),
    );
  }

  @Get('deployments/:deploymentId')
  @RequireRole('VIEWER')
  deployment(
    @Param('clusterId') clusterId: string,
    @Param('deploymentId') deploymentId: string,
  ): Promise<DeploymentRecord> {
    return this.deployments.deployment(clusterId, deploymentId);
  }
}

function principal(request: AuthenticatedRequest): Principal {
  if (!request.principal) {
    throw new Error('Authenticated principal is missing');
  }
  return request.principal;
}
