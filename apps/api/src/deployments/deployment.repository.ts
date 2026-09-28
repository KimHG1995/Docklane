import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { Database } from '../db/database.js';
import type {
  DeploymentRecord,
  DeploymentStatus,
  HealthCheckConfig,
} from './deployment.types.js';

interface DeploymentRow extends RowDataPacket {
  id: string;
  release_id: string;
  deployment_target_id: string;
  operation_id: string;
  status: DeploymentStatus;
  reason: string | null;
  no_op: number;
  before_spec: string | object;
  target_spec: string | object;
  health_json: string | HealthCheckConfig;
  expected_service_version: number;
  started_at: Date;
  finished_at: Date | null;
  created_by: string;
  created_at: Date;
}

@Injectable()
export class DeploymentRepository implements OnModuleInit {
  constructor(@Inject(Database) private readonly db: Database) {}

  async onModuleInit(): Promise<void> {
    await this.db.pool.query(`
      CREATE TABLE IF NOT EXISTS deployments (
        id VARCHAR(64) PRIMARY KEY,
        release_id VARCHAR(64) NOT NULL,
        deployment_target_id VARCHAR(64) NOT NULL,
        operation_id VARCHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL,
        reason TEXT NULL,
        no_op BOOLEAN NOT NULL DEFAULT FALSE,
        before_spec JSON NOT NULL,
        target_spec JSON NOT NULL,
        health_json JSON NOT NULL,
        expected_service_version BIGINT UNSIGNED NOT NULL,
        started_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        finished_at TIMESTAMP(6) NULL,
        created_by VARCHAR(128) NOT NULL,
        created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        UNIQUE KEY uq_deployments_operation (operation_id),
        INDEX idx_deployments_target_created (deployment_target_id, created_at),
        INDEX idx_deployments_status (status, created_at),
        CONSTRAINT fk_deployments_release
          FOREIGN KEY (release_id) REFERENCES releases(id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_deployments_target
          FOREIGN KEY (deployment_target_id) REFERENCES deployment_targets(id)
          ON DELETE RESTRICT
      ) ENGINE=InnoDB
    `);
  }

  async create(
    connection: PoolConnection,
    input: {
      releaseId: string;
      deploymentTargetId: string;
      operationId: string;
      status: DeploymentStatus;
      noOp: boolean;
      beforeSpec: unknown;
      targetSpec: unknown;
      health: HealthCheckConfig;
      expectedServiceVersion: number;
      createdBy: string;
    },
  ): Promise<DeploymentRecord> {
    const id = randomUUID();
    await connection.execute(
      `INSERT INTO deployments
       (
         id, release_id, deployment_target_id, operation_id, status,
         no_op, before_spec, target_spec, health_json,
         expected_service_version, created_by
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.releaseId,
        input.deploymentTargetId,
        input.operationId,
        input.status,
        input.noOp,
        JSON.stringify(input.beforeSpec),
        JSON.stringify(input.targetSpec),
        JSON.stringify(input.health),
        input.expectedServiceVersion,
        input.createdBy,
      ],
    );
    return this.requireWithConnection(connection, id);
  }

  async listForTarget(targetId: string): Promise<DeploymentRecord[]> {
    const [rows] = await this.db.pool.query<DeploymentRow[]>(
      `SELECT * FROM deployments
       WHERE deployment_target_id = ?
       ORDER BY created_at DESC`,
      [targetId],
    );
    return rows.map(mapDeployment);
  }

  async find(id: string): Promise<DeploymentRecord | null> {
    const [rows] = await this.db.pool.query<DeploymentRow[]>(
      'SELECT * FROM deployments WHERE id = ? LIMIT 1',
      [id],
    );
    return rows[0] ? mapDeployment(rows[0]) : null;
  }

  async findByOperationWithConnection(
    connection: PoolConnection,
    operationId: string,
  ): Promise<DeploymentRecord | null> {
    const [rows] = await connection.query<DeploymentRow[]>(
      'SELECT * FROM deployments WHERE operation_id = ? LIMIT 1',
      [operationId],
    );
    return rows[0] ? mapDeployment(rows[0]) : null;
  }

  async markVerifying(
    connection: PoolConnection,
    id: string,
  ): Promise<void> {
    await connection.execute(
      `UPDATE deployments
       SET status = 'VERIFYING', reason = NULL
       WHERE id = ?`,
      [id],
    );
  }

  async markSuccess(connection: PoolConnection, id: string): Promise<void> {
    await connection.execute(
      `UPDATE deployments
       SET status = 'SUCCESS', reason = NULL, finished_at = CURRENT_TIMESTAMP(6)
       WHERE id = ?`,
      [id],
    );
  }

  async markFailed(
    connection: PoolConnection,
    id: string,
    reason: string,
  ): Promise<void> {
    await connection.execute(
      `UPDATE deployments
       SET status = 'FAILED', reason = ?, finished_at = CURRENT_TIMESTAMP(6)
       WHERE id = ?`,
      [reason, id],
    );
  }

  async markNeedsAttention(
    connection: PoolConnection,
    id: string,
    reason: string,
  ): Promise<void> {
    await connection.execute(
      `UPDATE deployments
       SET status = 'NEEDS_ATTENTION', reason = ?, finished_at = CURRENT_TIMESTAMP(6)
       WHERE id = ?`,
      [reason, id],
    );
  }

  async requireWithConnection(
    connection: PoolConnection,
    id: string,
  ): Promise<DeploymentRecord> {
    const [rows] = await connection.query<DeploymentRow[]>(
      'SELECT * FROM deployments WHERE id = ? LIMIT 1',
      [id],
    );
    if (!rows[0]) throw new Error('Deployment disappeared after persistence');
    return mapDeployment(rows[0]);
  }
}

function mapDeployment(row: DeploymentRow): DeploymentRecord {
  return {
    id: row.id,
    releaseId: row.release_id,
    deploymentTargetId: row.deployment_target_id,
    operationId: row.operation_id,
    status: row.status,
    reason: row.reason,
    noOp: Boolean(row.no_op),
    beforeSpec: parseJson(row.before_spec),
    targetSpec: parseJson(row.target_spec),
    health: parseJson(row.health_json) as HealthCheckConfig,
    expectedServiceVersion: Number(row.expected_service_version),
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

function parseJson(value: string | object): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}
