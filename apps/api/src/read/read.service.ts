import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AGENT_CLIENT, type AgentClient } from '../agent/agent-client.js';
import type {
  ClusterResponse,
  ServiceDetailResponse,
  ServiceSummary,
  TaskSummary,
} from '../agent/read-model.js';

@Injectable()
export class ReadService {
  private readonly clusterId = process.env.DOCKLANE_CLUSTER_ID ?? 'default';

  constructor(
    @Inject(AGENT_CLIENT) private readonly agentClient: AgentClient,
  ) {}

  async cluster(clusterId: string): Promise<ClusterResponse> {
    this.assertCluster(clusterId);
    return this.agentClient.inspectCluster();
  }

  async services(clusterId: string): Promise<ServiceSummary[]> {
    this.assertCluster(clusterId);
    return this.agentClient.listServices();
  }

  async service(clusterId: string, serviceId: string): Promise<ServiceDetailResponse> {
    this.assertCluster(clusterId);
    return this.agentClient.inspectService(serviceId);
  }

  async tasks(clusterId: string, serviceId: string): Promise<TaskSummary[]> {
    this.assertCluster(clusterId);
    return this.agentClient.listServiceTasks(serviceId);
  }

  private assertCluster(clusterId: string): void {
    if (clusterId !== this.clusterId) {
      throw new NotFoundException('Cluster not found');
    }
  }
}
