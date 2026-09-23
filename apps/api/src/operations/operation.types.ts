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
  resourceType?: 'service' | 'node';
  resourceId?: string;
  action: string;
  beforeJson?: unknown;
  afterJson?: unknown;
}


export type NodeOperationType = 'DRAIN' | 'ACTIVATE';

export interface NodeOperationRecord {
  id: string;
  clusterId: string;
  nodeId: string;
  type: NodeOperationType;
  status: OperationStatus;
  actorId: string;
  expectedVersion: number;
  beforeSpecHash: string;
  targetSpecHash: string;
  targetAvailability: 'drain' | 'active';
  affectedServiceIds: string[];
  resultVersion: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}
