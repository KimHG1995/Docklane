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
import {
  DeployRequestSchema,
  HistoricalRedeployRequestSchema,
  RollbackRequestSchema,
} from './deployment.dto.js';
import { DeploymentService } from './deployment.service.js';
import type {
  DeploymentRecord,
  DeploymentStatusView,
} from './deployment.types.js';

@Controller('v1/clusters/:clusterId')
export class DeploymentController {
  constructor(
    @Inject(DeploymentService)
    private readonly deployments: DeploymentService,
  ) {}

  @Get('targets/:targetId/deployments')
  @RequireRole('VIEWER')
  history(
    @Param('clusterId') clusterId: string,
    @Param('targetId') targetId: string,
  ): Promise<DeploymentRecord[]> {
    return this.deployments.history(clusterId, targetId);
  }

  @Post('targets/:targetId/historical-redeploy')
  @HttpCode(200)
  @RequireRole('OPERATOR')
  historicalRedeploy(
    @Param('clusterId') clusterId: string,
    @Param('targetId') targetId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<DeploymentRecord> {
    let input;
    try {
      input = HistoricalRedeployRequestSchema.parse(body);
    } catch {
      throw new BadRequestException('Invalid historical redeploy request');
    }
    return this.deployments.historicalRedeploy(
      clusterId,
      targetId,
      input,
      principal(request),
    );
  }

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

  @Post('deployments/:deploymentId/rollback')
  @HttpCode(200)
  @RequireRole('OPERATOR')
  rollback(
    @Param('clusterId') clusterId: string,
    @Param('deploymentId') deploymentId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<DeploymentRecord> {
    let input;
    try {
      input = RollbackRequestSchema.parse(body);
    } catch {
      throw new BadRequestException('Invalid rollback request');
    }
    return this.deployments.rollback(
      clusterId,
      deploymentId,
      input,
      principal(request),
    );
  }

  @Get('deployments/:deploymentId/status')
  @RequireRole('VIEWER')
  status(
    @Param('clusterId') clusterId: string,
    @Param('deploymentId') deploymentId: string,
  ): Promise<DeploymentStatusView> {
    return this.deployments.status(clusterId, deploymentId);
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
