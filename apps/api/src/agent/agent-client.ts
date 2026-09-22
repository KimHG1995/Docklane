import type {
  ClusterResponse,
  HealthResponse,
  ServiceDetailResponse,
  ServiceSummary,
  TaskSummary,
} from './read-model.js';

export interface AgentClient {
  health(): Promise<HealthResponse>;
  inspectCluster(): Promise<ClusterResponse>;
  listServices(): Promise<ServiceSummary[]>;
  inspectService(serviceId: string): Promise<ServiceDetailResponse>;
  listServiceTasks(serviceId: string): Promise<TaskSummary[]>;
}

export const AGENT_CLIENT = Symbol('AGENT_CLIENT');
