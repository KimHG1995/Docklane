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
  CreateApplicationRequestSchema,
  CreateDeploymentTargetRequestSchema,
  CreateReleaseRequestSchema,
} from './release.dto.js';
import { ReleaseService } from './release.service.js';
import type {
  ApplicationRecord,
  DeploymentTargetRecord,
  ReleaseRecord,
} from './release.types.js';

@Controller('v1')
export class ReleaseController {
  constructor(
    @Inject(ReleaseService) private readonly releases: ReleaseService,
  ) {}

  @Get('applications')
  @RequireRole('VIEWER')
  applications(): Promise<ApplicationRecord[]> {
    return this.releases.applications();
  }

  @Post('applications')
  @HttpCode(201)
  @RequireRole('OPERATOR')
  createApplication(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<ApplicationRecord> {
    return this.releases.createApplication(
      parseBody(CreateApplicationRequestSchema, body),
      principal(request),
    );
  }

  @Get('applications/:applicationId/releases')
  @RequireRole('VIEWER')
  releasesForApplication(
    @Param('applicationId') applicationId: string,
  ): Promise<ReleaseRecord[]> {
    return this.releases.releases(applicationId);
  }

  @Post('applications/:applicationId/releases')
  @HttpCode(201)
  @RequireRole('OPERATOR')
  createRelease(
    @Param('applicationId') applicationId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<ReleaseRecord> {
    return this.releases.createRelease(
      applicationId,
      parseBody(CreateReleaseRequestSchema, body),
      principal(request),
    );
  }

  @Get('clusters/:clusterId/applications/:applicationId/targets')
  @RequireRole('VIEWER')
  targets(
    @Param('clusterId') clusterId: string,
    @Param('applicationId') applicationId: string,
  ): Promise<DeploymentTargetRecord[]> {
    return this.releases.targets(clusterId, applicationId);
  }

  @Post('clusters/:clusterId/applications/:applicationId/targets')
  @HttpCode(201)
  @RequireRole('OPERATOR')
  createTarget(
    @Param('clusterId') clusterId: string,
    @Param('applicationId') applicationId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<DeploymentTargetRecord> {
    return this.releases.createTarget(
      clusterId,
      applicationId,
      parseBody(CreateDeploymentTargetRequestSchema, body),
      principal(request),
    );
  }
}

function parseBody<T>(
  schema: { parse(value: unknown): T },
  body: unknown,
): T {
  try {
    return schema.parse(body);
  } catch {
    throw new BadRequestException('Invalid release domain request');
  }
}

function principal(request: AuthenticatedRequest): Principal {
  if (!request.principal) {
    throw new Error('Authenticated principal is missing');
  }
  return request.principal;
}
