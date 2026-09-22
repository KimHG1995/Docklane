import {
  Inject,
  Injectable,
  type OnModuleInit,
} from '@nestjs/common';
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
  result_version: number | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

interface CountRow extends RowDataPacket {
  count: number;
}

@Injectable()
export class OperationRepository implements OnModuleInit {
  constructor(@Inject(Database) private readonly db: Database) {}

  async onModuleInit(): Promise<void> {
    await this.initialize();
  }

  async initialize(): Promise<void> {
    await this.db.pool.query(`
      CREATE TABLE IF NOT EXISTS operations (
        id VARCHAR(64) PRIMARY KEY,
        cluster_id VARCHAR(128) NOT NULL,
        service_id VARCHAR(128) NOT NULL,
        type VARCHAR(32) NOT NULL,
        status VARCHAR(32) NOT NULL,
        actor_id VARCHAR(128) NOT NULL,
        expected_version BIGINT UNSIGNED NOT NULL,
        before_spec_hash VARCHAR(64) NOT NULL DEFAULT '',
        target_spec_hash VARCHAR(64) NOT NULL DEFAULT '',
        target_force_update BIGINT UNSIGNED NOT NULL DEFAULT 0,
        target_replicas INT NULL,
        result_version BIGINT UNSIGNED NULL,
        error_code VARCHAR(64) NULL,
        error_message TEXT NULL,
        created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        INDEX idx_operations_service (cluster_id, service_id, created_at),
        INDEX idx_operations_status (status, updated_at)
      ) ENGINE=InnoDB
    `);

    await this.ensureColumn(
      'before_spec_hash',
      "VARCHAR(64) NOT NULL DEFAULT ''",
    );
    await this.ensureColumn(
      'target_spec_hash',
      "VARCHAR(64) NOT NULL DEFAULT ''",
    );
    await this.ensureColumn(
      'target_force_update',
      'BIGINT UNSIGNED NOT NULL DEFAULT 0',
    );

    await this.db.pool.query(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        operation_id VARCHAR(64) NOT NULL,
        actor_id VARCHAR(128) NOT NULL,
        cluster_id VARCHAR(128) NOT NULL,
        service_id VARCHAR(128) NOT NULL,
        action VARCHAR(64) NOT NULL,
        before_json JSON NULL,
        after_json JSON NULL,
        created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        INDEX idx_audit_operation (operation_id),
        INDEX idx_audit_resource (cluster_id, service_id, created_at)
      ) ENGINE=InnoDB
    `);
  }

  async find(id: string): Promise<OperationRecord | null> {
    const [rows] = await this.db.pool.query<OperationRow[]>(
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
    const [rows] = await this.db.pool.query<OperationRow[]>(
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
    },
  ): Promise<void> {
    await connection.execute(
      `INSERT INTO operations
       (
         id, cluster_id, service_id, type, status, actor_id,
         expected_version, before_spec_hash, target_spec_hash,
         target_force_update, target_replicas
       )
       VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)`,
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
      ],
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
       (operation_id, actor_id, cluster_id, service_id, action, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.operationId,
        input.actorId,
        input.clusterId,
        input.serviceId,
        input.action,
        input.beforeJson === undefined ? null : JSON.stringify(input.beforeJson),
        input.afterJson === undefined ? null : JSON.stringify(input.afterJson),
      ],
    );
  }

  private async ensureColumn(
    columnName: string,
    definition: string,
  ): Promise<void> {
    const [rows] = await this.db.pool.query<CountRow[]>(
      `SELECT COUNT(*) AS count
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND table_name = 'operations'
         AND column_name = ?`,
      [columnName],
    );
    if ((rows[0]?.count ?? 0) > 0) {
      return;
    }

    if (!/^[a-z_]+$/.test(columnName)) {
      throw new Error('Unsafe operation column name');
    }
    await this.db.pool.query(
      `ALTER TABLE operations ADD COLUMN ${columnName} ${definition}`,
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
    resultVersion: row.result_version === null ? null : Number(row.result_version),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
