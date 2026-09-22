export type OperationType = 'SCALE' | 'RESTART';
export type OperationStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'VERIFYING'
  | 'SUCCESS'
  | 'FAILED'
  | 'NEEDS_ATTENTION';

export interface OperationRecord {
  id: string;
  clusterId: string;
  serviceId: string;
  type: OperationType;
  status: OperationStatus;
  actorId: string;
  expectedVersion: number;
  beforeSpecHash: string;
  targetSpecHash: string;
  targetForceUpdate: number;
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
