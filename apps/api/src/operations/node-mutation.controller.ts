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
  NodeLabelsRequestSchema,
  NodeMutationRequestSchema,
} from './node-mutation.dto.js';
import { NodeMutationService } from './node-mutation.service.js';
import type { NodeOperationRecord } from './operation.types.js';

@Controller('v1/clusters/:clusterId')
export class NodeMutationController {
  constructor(
    @Inject(NodeMutationService)
    private readonly mutations: NodeMutationService,
  ) {}

  @Get('node-operations/:operationId')
  @RequireRole('VIEWER')
  operation(
    @Param('clusterId') clusterId: string,
    @Param('operationId') operationId: string,
  ): Promise<NodeOperationRecord> {
    return this.mutations.operation(clusterId, operationId);
  }

  @Post('nodes/:nodeId/drain')
  @HttpCode(200)
  @RequireRole('OPERATOR')
  drain(
    @Param('clusterId') clusterId: string,
    @Param('nodeId') nodeId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<NodeOperationRecord> {
    return this.mutations.drain(
      clusterId,
      nodeId,
      parseBody(body),
      principal(request),
    );
  }

  @Post('nodes/:nodeId/labels')
  @HttpCode(200)
  @RequireRole('OPERATOR')
  labels(
    @Param('clusterId') clusterId: string,
    @Param('nodeId') nodeId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<NodeOperationRecord> {
    let input;
    try {
      input = NodeLabelsRequestSchema.parse(body);
    } catch {
      throw new BadRequestException('Invalid node label mutation request');
    }
    return this.mutations.labels(
      clusterId,
      nodeId,
      input,
      principal(request),
    );
  }

  @Post('nodes/:nodeId/activate')
  @HttpCode(200)
  @RequireRole('OPERATOR')
  activate(
    @Param('clusterId') clusterId: string,
    @Param('nodeId') nodeId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<NodeOperationRecord> {
    return this.mutations.activate(
      clusterId,
      nodeId,
      parseBody(body),
      principal(request),
    );
  }
}

function parseBody(body: unknown) {
  try {
    return NodeMutationRequestSchema.parse(body);
  } catch {
    throw new BadRequestException('Invalid node mutation request');
  }
}

function principal(request: AuthenticatedRequest): Principal {
  if (!request.principal) {
    throw new Error('Authenticated principal is missing');
  }
  return request.principal;
}
