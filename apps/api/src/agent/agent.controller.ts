import { Controller, Get, Inject, Param } from '@nestjs/common';
import {
  AGENT_CLIENT,
  type AgentClient,
  type AgentJson,
} from './agent-client.js';

@Controller('internal/agent')
export class AgentController {
  constructor(
    @Inject(AGENT_CLIENT) private readonly agentClient: AgentClient,
  ) {}

  @Get('health')
  health(): Promise<AgentJson> {
    return this.agentClient.health();
  }

  @Get('cluster')
  cluster(): Promise<AgentJson> {
    return this.agentClient.inspectCluster();
  }

  @Get('services/:serviceId')
  service(@Param('serviceId') serviceId: string): Promise<AgentJson> {
    return this.agentClient.inspectService(serviceId);
  }

  @Get('services/:serviceId/tasks')
  tasks(@Param('serviceId') serviceId: string): Promise<AgentJson> {
    return this.agentClient.listServiceTasks(serviceId);
  }
}
