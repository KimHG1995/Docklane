import { Inject, Injectable } from '@nestjs/common';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { Database } from '../db/database.js';
import type {
  AuditEventInput,
  OperationRecord,
  OperationStatus,
  OperationType,
} from './operation.types.js';

interface OperationRow extends RowDataPacket {
  id: string;
  cluster_id: string;
  service_id: string;
  type: OperationType;
  status: OperationStatus;
  actor_id: string;
  expected_version: number;
  before_spec_hash: string;
  target_spec_hash: string;
  target_force_update: number;
  target_replicas: number | null;
  target_image: string | null;
  target_task_spec_hash: string | null;
  target_runtime_spec_hash: string | null;
  result_version: number | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class OperationRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  async find(id: string): Promise<OperationRecord | null> {
    const [rows] = await this.db.query<OperationRow[]>(
      'SELECT * FROM operations WHERE id = ? LIMIT 1',
      [id],
    );
    return rows[0] ? mapOperation(rows[0]) : null;
  }

  async findWithConnection(
    connection: PoolConnection,
    id: string,
  ): Promise<OperationRecord | null> {
    const [rows] = await connection.query<OperationRow[]>(
      'SELECT * FROM operations WHERE id = ? LIMIT 1',
      [id],
    );
    return rows[0] ? mapOperation(rows[0]) : null;
  }

  async listNonTerminal(): Promise<OperationRecord[]> {
    const [rows] = await this.db.query<OperationRow[]>(
      `SELECT * FROM operations
       WHERE status IN ('PENDING', 'RUNNING', 'VERIFYING', 'NEEDS_ATTENTION')
       ORDER BY created_at ASC`,
    );
    return rows.map(mapOperation);
  }

  async findNonTerminalForServiceWithConnection(
    connection: PoolConnection,
    clusterId: string,
    serviceId: string,
  ): Promise<OperationRecord | null> {
    const [rows] = await connection.query<OperationRow[]>(
      `SELECT * FROM operations
       WHERE cluster_id = ?
         AND service_id = ?
         AND status IN ('PENDING', 'RUNNING', 'VERIFYING', 'NEEDS_ATTENTION')
       ORDER BY created_at ASC
       LIMIT 1`,
      [clusterId, serviceId],
    );
    return rows[0] ? mapOperation(rows[0]) : null;
  }

  async create(
    connection: PoolConnection,
    input: {
      id: string;
      clusterId: string;
      serviceId: string;
      type: OperationType;
      actorId: string;
      expectedVersion: number;
      beforeSpecHash: string;
      targetSpecHash: string;
      targetForceUpdate: number;
      targetReplicas?: number;
      targetImage?: string;
      targetTaskSpecHash?: string;
      targetRuntimeSpecHash?: string;
    },
  ): Promise<void> {
    await connection.execute(
      `INSERT INTO operations
       (
         id, cluster_id, service_id, type, status, actor_id,
         expected_version, before_spec_hash, target_spec_hash,
         target_force_update, target_replicas, target_image, target_task_spec_hash,
         target_runtime_spec_hash
       )
       VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.clusterId,
        input.serviceId,
        input.type,
        input.actorId,
        input.expectedVersion,
        input.beforeSpecHash,
        input.targetSpecHash,
        input.targetForceUpdate,
        input.targetReplicas ?? null,
        input.targetImage ?? null,
        input.targetTaskSpecHash ?? null,
        input.targetRuntimeSpecHash ?? null,
      ],
    );
  }

  async backfillTargetRuntimeSpecHash(
    connection: PoolConnection,
    id: string,
    targetRuntimeSpecHash: string,
  ): Promise<void> {
    await connection.execute(
      `UPDATE operations
       SET target_runtime_spec_hash = ?
       WHERE id = ? AND target_runtime_spec_hash IS NULL`,
      [targetRuntimeSpecHash, id],
    );
  }

  async markRunning(connection: PoolConnection, id: string): Promise<void> {
    await connection.execute(
      "UPDATE operations SET status = 'RUNNING' WHERE id = ?",
      [id],
    );
  }

  async markVerifying(
    connection: PoolConnection,
    id: string,
    resultVersion: number,
  ): Promise<void> {
    await connection.execute(
      `UPDATE operations
       SET status = 'VERIFYING', result_version = ?,
           error_code = NULL, error_message = NULL
       WHERE id = ?`,
      [resultVersion, id],
    );
  }

  async markVerificationPending(
    connection: PoolConnection,
    id: string,
    code: string,
    message: string,
  ): Promise<void> {
    await connection.execute(
      `UPDATE operations
       SET status = 'VERIFYING', error_code = ?, error_message = ?
       WHERE id = ?`,
      [code, message, id],
    );
  }

  async markSuccess(
    connection: PoolConnection,
    id: string,
    resultVersion: number,
  ): Promise<void> {
    await connection.execute(
      `UPDATE operations
       SET status = 'SUCCESS', result_version = ?,
           error_code = NULL, error_message = NULL
       WHERE id = ?`,
      [resultVersion, id],
    );
  }

  async markNeedsAttention(
    connection: PoolConnection,
    id: string,
    code: string,
    message: string,
  ): Promise<void> {
    await connection.execute(
      `UPDATE operations
       SET status = 'NEEDS_ATTENTION', error_code = ?, error_message = ?
       WHERE id = ?`,
      [code, message, id],
    );
  }

  async markFailed(
    connection: PoolConnection,
    id: string,
    code: string,
    message: string,
  ): Promise<void> {
    await connection.execute(
      `UPDATE operations
       SET status = 'FAILED', error_code = ?, error_message = ?
       WHERE id = ?`,
      [code, message, id],
    );
  }

  async audit(
    connection: PoolConnection,
    input: AuditEventInput,
  ): Promise<void> {
    await connection.execute(
      `INSERT INTO audit_events
       (
         operation_id, actor_id, cluster_id, service_id,
         resource_type, resource_id, action, before_json, after_json
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.operationId,
        input.actorId,
        input.clusterId,
        input.serviceId,
        input.resourceType ?? 'service',
        input.resourceId ?? input.serviceId,
        input.action,
        input.beforeJson === undefined ? null : JSON.stringify(input.beforeJson),
        input.afterJson === undefined ? null : JSON.stringify(input.afterJson),
      ],
    );
  }


}

function mapOperation(row: OperationRow): OperationRecord {
  return {
    id: row.id,
    clusterId: row.cluster_id,
    serviceId: row.service_id,
    type: row.type,
    status: row.status,
    actorId: row.actor_id,
    expectedVersion: Number(row.expected_version),
    beforeSpecHash: row.before_spec_hash,
    targetSpecHash: row.target_spec_hash,
    targetForceUpdate: Number(row.target_force_update),
    targetReplicas: row.target_replicas,
    targetImage: row.target_image,
    targetTaskSpecHash: row.target_task_spec_hash,
    targetRuntimeSpecHash: row.target_runtime_spec_hash,
    resultVersion: row.result_version === null ? null : Number(row.result_version),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
