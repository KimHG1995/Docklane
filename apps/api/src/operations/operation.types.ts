export type OperationType = 'SCALE' | 'RESTART';
export type OperationStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';

export interface OperationRecord {
  id: string;
  clusterId: string;
  serviceId: string;
  type: OperationType;
  status: OperationStatus;
  actorId: string;
  expectedVersion: number;
  targetReplicas: number | null;
  resultVersion: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEventInput {
  operationId: string;
  actorId: string;
  clusterId: string;
  serviceId: string;
  action: string;
  beforeJson?: unknown;
  afterJson?: unknown;
}
