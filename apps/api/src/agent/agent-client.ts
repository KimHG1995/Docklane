import type {
  ClusterResponse,
  HealthResponse,
  ServiceDetailResponse,
  ServiceSummary,
  TaskSummary,
  ServiceMutationResponse,
} from './read-model.js';

export interface AgentClient {
  health(): Promise<HealthResponse>;
  inspectCluster(): Promise<ClusterResponse>;
  listServices(): Promise<ServiceSummary[]>;
  inspectService(serviceId: string): Promise<ServiceDetailResponse>;
  listServiceTasks(serviceId: string): Promise<TaskSummary[]>;
  scaleService(
    serviceId: string,
    expectedVersion: number,
    replicas: number,
  ): Promise<ServiceMutationResponse>;
  restartService(
    serviceId: string,
    expectedVersion: number,
  ): Promise<ServiceMutationResponse>;
}

export const AGENT_CLIENT = Symbol('AGENT_CLIENT');
