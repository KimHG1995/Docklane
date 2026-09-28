export type DeploymentStatus =
  | 'DEPLOYING'
  | 'VERIFYING'
  | 'SUCCESS'
  | 'FAILED'
  | 'ROLLING_BACK'
  | 'ROLLBACK_VERIFYING'
  | 'ROLLED_BACK'
  | 'ROLLBACK_FAILED'
  | 'NEEDS_ATTENTION';

export type DeploymentKind = 'DEPLOY' | 'HISTORICAL_REDEPLOY';

export interface HealthCheckConfig {
  url: string;
  intervalMs: number;
  timeoutMs: number;
  retries: number;
  stabilityWindowMs: number;
  expectedStatus: number;
}

export interface DeploymentRecord {
  id: string;
  kind: DeploymentKind;
  sourceDeploymentId: string | null;
  releaseId: string;
  previousReleaseId: string | null;
  deploymentTargetId: string;
  operationId: string;
  rollbackOperationId: string | null;
  status: DeploymentStatus;
  reason: string | null;
  noOp: boolean;
  beforeSpec: unknown;
  targetSpec: unknown;
  health: HealthCheckConfig;
  expectedServiceVersion: number;
  startedAt: string;
  finishedAt: string | null;
  createdBy: string;
  createdAt: string;
}


export interface DeploymentStatusView {
  deployment: DeploymentRecord;
  operation: import('../operations/operation.types.js').OperationRecord | null;
  rollbackOperation: import('../operations/operation.types.js').OperationRecord | null;
}
