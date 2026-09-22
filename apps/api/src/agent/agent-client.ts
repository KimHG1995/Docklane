import type {
  ClusterResponse,
  HealthResponse,
  ServiceDetailResponse,
  ServiceMutationPlan,
  ServiceMutationResponse,
  ServiceSummary,
  TaskSummary,
} from './read-model.js';

export interface AgentClient {
  health(): Promise<HealthResponse>;
  inspectCluster(): Promise<ClusterResponse>;
  listServices(): Promise<ServiceSummary[]>;
  inspectService(serviceId: string): Promise<ServiceDetailResponse>;
  listServiceTasks(serviceId: string): Promise<TaskSummary[]>;

  planScaleService(
    serviceId: string,
    expectedVersion: number,
    replicas: number,
  ): Promise<ServiceMutationPlan>;

  planRestartService(
    serviceId: string,
    expectedVersion: number,
  ): Promise<ServiceMutationPlan>;

  scaleService(
    serviceId: string,
    input: {
      expectedVersion: number;
      expectedSpecHash: string;
      targetSpecHash: string;
      replicas: number;
    },
  ): Promise<ServiceMutationResponse>;

  restartService(
    serviceId: string,
    input: {
      expectedVersion: number;
      expectedSpecHash: string;
      targetSpecHash: string;
    },
  ): Promise<ServiceMutationResponse>;
}

export const AGENT_CLIENT = Symbol('AGENT_CLIENT');

export class AgentRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly responseBody: string,
  ) {
    super(`Agent request failed with ${statusCode}`);
  }
}
