import {
  BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Put, Req, UnauthorizedException,
} from '@nestjs/common';
import { RequireRole } from '../auth/auth.decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/auth.types.js';
import { RegisterClusterRequestSchema } from './cluster-registration.dto.js';
import { ClusterRegistrationService } from './cluster-registration.service.js';
import type { ClusterRegistrationRecord, ClusterRegistrationView } from './cluster-registration.types.js';

@Controller('v1/clusters/:clusterId/registration')
@RequireRole('ADMIN')
export class ClusterRegistrationController {
  constructor(@Inject(ClusterRegistrationService) private readonly registrations: ClusterRegistrationService) {}

  @Put()
  @HttpCode(200)
  register(
    @Param('clusterId') clusterId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<ClusterRegistrationRecord> {
    const parsed = RegisterClusterRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid cluster registration request');
    return this.registrations.register(clusterId, parsed.data, principal(request));
  }

  @Get()
  get(
    @Param('clusterId') clusterId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ClusterRegistrationView> {
    return this.registrations.get(clusterId, principal(request));
  }
}

function principal(request: AuthenticatedRequest): Principal {
  if (!request.principal) throw new UnauthorizedException('Authenticated principal is missing');
  return request.principal;
}
