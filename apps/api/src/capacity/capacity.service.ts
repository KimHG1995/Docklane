import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AGENT_CLIENT,
  AgentRequestError,
  type AgentClient,
} from '../agent/agent-client.js';
import type {
  CapacityCheckRequest,
  CapacityCheckResponse,
} from '../agent/capacity-model.js';

@Injectable()
export class CapacityService {
  private readonly logger = new Logger(CapacityService.name);
  private readonly clusterId = process.env.DOCKLANE_CLUSTER_ID ?? 'default';

  constructor(
    @Inject(AGENT_CLIENT) private readonly agentClient: AgentClient,
  ) {}

  check(
    clusterId: string,
    serviceId: string,
    input: CapacityCheckRequest,
  ): Promise<CapacityCheckResponse> {
    this.assertCluster(clusterId);
    return this.callAgent(serviceId, input);
  }

  async assertAvailable(
    serviceId: string,
    input: CapacityCheckRequest,
  ): Promise<CapacityCheckResponse> {
    const result = await this.callAgent(serviceId, input);

    if (result.status === 'INSUFFICIENT') {
      throw new ConflictException({
        code: 'INSUFFICIENT_CLUSTER_CAPACITY',
        message: 'Swarm capacity pre-check found insufficient eligible capacity',
        capacity: result,
      });
    }

    if (result.status === 'UNKNOWN') {
      this.logger.warn(
        `Capacity pre-check is UNKNOWN for service ${serviceId}: ${result.reasons.join(', ')}`,
      );
    }

    return result;
  }

  private async callAgent(
    serviceId: string,
    input: CapacityCheckRequest,
  ): Promise<CapacityCheckResponse> {
    try {
      return await this.agentClient.checkServiceCapacity(serviceId, input);
    } catch (error) {
      if (error instanceof AgentRequestError && error.statusCode === 409) {
        throw new ConflictException('Service changed before capacity check');
      }
      throw new BadGatewayException('Agent capacity check failed');
    }
  }

  private assertCluster(clusterId: string): void {
    if (clusterId !== this.clusterId) {
      throw new NotFoundException('Cluster not found');
    }
  }
}
