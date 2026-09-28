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
