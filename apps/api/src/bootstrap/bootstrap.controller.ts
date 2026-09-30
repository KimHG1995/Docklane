import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import {
  Public,
  RequireRole,
} from '../auth/auth.decorators.js';
import type {
  AuthenticatedRequest,
  Principal,
} from '../auth/auth.types.js';
import {
  BootstrapClaimRequestSchema,
  BootstrapCompleteRequestSchema,
  CreateBootstrapTokenRequestSchema,
} from './bootstrap.dto.js';
import { BootstrapService } from './bootstrap.service.js';
import type {
  BootstrapClaimResponse,
  BootstrapCompleteResponse,
  BootstrapTokenIssueResponse,
} from './bootstrap.types.js';

@Controller('v1')
export class BootstrapController {
  constructor(
    @Inject(BootstrapService)
    private readonly bootstrap: BootstrapService,
  ) {}

  @Post('clusters/:clusterId/bootstrap/tokens')
  @HttpCode(201)
  @RequireRole('ADMIN')
  issue(
    @Param('clusterId') clusterId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<BootstrapTokenIssueResponse> {
    return this.bootstrap.issue(
      clusterId,
      parseBody(CreateBootstrapTokenRequestSchema, body),
      principal(request),
    );
  }

  @Post('bootstrap/complete')
  @HttpCode(200)
  @Public()
  complete(@Body() body: unknown): Promise<BootstrapCompleteResponse> {
    return this.bootstrap.complete(
      parseBody(BootstrapCompleteRequestSchema, body),
    );
  }

  @Post('bootstrap/claim')
  @HttpCode(200)
  @Public()
  claim(@Body() body: unknown): Promise<BootstrapClaimResponse> {
    return this.bootstrap.claim(
      parseBody(BootstrapClaimRequestSchema, body),
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
    throw new BadRequestException('Invalid bootstrap request');
  }
}

function principal(request: AuthenticatedRequest): Principal {
  if (!request.principal) {
    throw new Error('Authenticated principal is missing');
  }
  return request.principal;
}
