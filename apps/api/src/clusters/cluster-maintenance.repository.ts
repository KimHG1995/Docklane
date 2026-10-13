import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { RowDataPacket } from 'mysql2/promise';
import { Database } from '../db/database.js';

/**
 * Durable maintenance read boundary shared by all Control Plane processes.
 *
 * Missing row, invalid state and DB failure MUST NOT become OPEN. This module
 * does not authorize transitions, gate mutation dispatch or fence Docker CLI.
 * Those operations require a later coordinated admission/barrier implementation.
 */
export type MaintenanceState = 'OPEN' | 'CLOSING' | 'CLOSED' | 'RECONCILING';
export interface MaintenanceRecord {
  clusterId: string;
  state: MaintenanceState;
  generation: bigint;
  ownerId: string;
  reason: string;
  changedBy: string;
  changedAt: Date;
}
interface MaintenanceRow extends RowDataPacket {
  cluster_id: string;
  state: string;
  generation: string | number;
  owner_id: string;
  reason: string;
  changed_by: string;
  changed_at: Date;
}
const STATES = new Set<MaintenanceState>(['OPEN', 'CLOSING', 'CLOSED', 'RECONCILING']);

@Injectable()
export class ClusterMaintenanceRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  async requireRecord(clusterId: string): Promise<MaintenanceRecord> {
    let rows: MaintenanceRow[];
    try {
      [rows] = await this.db.query<MaintenanceRow[]>(
        'SELECT cluster_id, state, CAST(generation AS CHAR) AS generation, owner_id, reason, changed_by, changed_at FROM cluster_maintenance_states WHERE cluster_id = ? LIMIT 1',
        [clusterId],
      );
    } catch {
      throw new ServiceUnavailableException('Cluster maintenance state cannot be verified');
    }
    const row = rows[0];
    if (!row || !STATES.has(row.state as MaintenanceState)) {
      throw new ServiceUnavailableException('Cluster maintenance state is missing or invalid');
    }
    const generation = BigInt(row.generation);
    if (generation < 1n) {
      throw new ConflictException('Cluster maintenance generation is invalid');
    }
    return {
      clusterId: row.cluster_id,
      state: row.state as MaintenanceState,
      generation,
      ownerId: row.owner_id,
      reason: row.reason,
      changedBy: row.changed_by,
      changedAt: row.changed_at,
    };
  }


  /**
   * Operator initialization is explicit and limited to an already registered
   * cluster. No implicit OPEN row is created on read/startup/migration.
   * A duplicate request never resets a CLOSED or CLOSING state.
   */
  async initializeOpen(clusterId: string, actorId: string, reason: string): Promise<MaintenanceRecord> {
    if (!actorId.trim() || !reason.trim() || reason.length > 1024) {
      throw new ConflictException('Maintenance initializer requires actor and bounded reason');
    }
    const connection = await this.db.getConnection();
    try {
      await connection.beginTransaction();
      const [registered] = await connection.query<RowDataPacket[]>(
        'SELECT cluster_id FROM cluster_registrations WHERE cluster_id = ? LIMIT 1 FOR UPDATE',
        [clusterId],
      );
      if (registered.length !== 1) {
        throw new ConflictException('Cluster registration is required before maintenance initialization');
      }
      const [result] = await connection.execute(
        `INSERT INTO cluster_maintenance_states
         (cluster_id, state, generation, owner_id, reason, changed_by)
         VALUES (?, 'OPEN', 1, ?, ?, ?)
         ON DUPLICATE KEY UPDATE cluster_id = cluster_id`,
        [clusterId, actorId, reason, actorId],
      );
      // Replays never change the existing state; no automatic re-opening.
      void result;
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return this.requireRecord(clusterId);
  }

  /**
   * Compare-and-swap transition. Caller must separately prove in-flight
   * completion and manager barriers before CLOSING -> CLOSED or reopening.
   * This is a database primitive, NOT authorization or Docker fencing.
   */
  async compareAndSetState(
    clusterId: string,
    expectedState: MaintenanceState,
    expectedGeneration: bigint,
    targetState: MaintenanceState,
    actorId: string,
    reason: string,
  ): Promise<boolean> {
    const allowed: Record<MaintenanceState, readonly MaintenanceState[]> = {
      OPEN: ['CLOSING'],
      CLOSING: ['CLOSED'],
      CLOSED: ['RECONCILING'],
      RECONCILING: ['OPEN'],
    };
    if (!allowed[expectedState].includes(targetState) ||
        expectedGeneration < 1n || !actorId.trim() || !reason.trim() || reason.length > 1024) {
      throw new ConflictException('Invalid maintenance state transition');
    }
    const [result] = await this.db.query<import('mysql2/promise').ResultSetHeader>(
      `UPDATE cluster_maintenance_states
       SET state = ?, generation = generation + 1, owner_id = ?, reason = ?,
           changed_by = ?, changed_at = UTC_TIMESTAMP(6)
       WHERE cluster_id = ? AND state = ? AND generation = ?`,
      [targetState, actorId, reason, actorId, clusterId, expectedState, expectedGeneration.toString()],
    );
    return result.affectedRows === 1;
  }

  /**
   * Atomic maintenance close request and audit. Only OPEN -> CLOSING is exposed:
   * CLOSED requires in-flight dispatch accounting and all manager barriers.
   * The single-row CAS is protected by InnoDB; audit failure rolls it back.
   */
  async requestClosing(
    clusterId: string, generation: bigint, actorId: string, reason: string,
  ): Promise<boolean> {
    if (generation < 1n || !actorId.trim() || reason.trim().length === 0 ||
        reason.length > 1024) {
      throw new ConflictException('Invalid maintenance close request');
    }
    const connection = await this.db.getConnection();
    try {
      await connection.beginTransaction();
      const [update] = await connection.execute<import('mysql2/promise').ResultSetHeader>(
        `UPDATE cluster_maintenance_states
         SET state = 'CLOSING', generation = generation + 1,
             owner_id = ?, reason = ?, changed_by = ?,
             changed_at = UTC_TIMESTAMP(6)
         WHERE cluster_id = ? AND state = 'OPEN' AND generation = ?`,
        [actorId, reason, actorId, clusterId, generation.toString()],
      );
      if (update.affectedRows !== 1) {
        await connection.rollback();
        return false;
      }
      await connection.execute(
        `INSERT INTO audit_events
         (operation_id, actor_id, cluster_id, service_id,
          resource_type, resource_id, action, after_json)
         VALUES (?, ?, ?, ?, 'cluster', ?, 'CLUSTER_MAINTENANCE_CLOSING', ?)`,
        [randomUUID(), actorId, clusterId,
         clusterId, clusterId,
         JSON.stringify({ previousState: 'OPEN', state: 'CLOSING',
           generation: (generation + 1n).toString(), reason })],
      );
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async requireOpen(clusterId: string): Promise<MaintenanceRecord> {
    const record = await this.requireRecord(clusterId);
    if (record.state !== 'OPEN') {
      throw new ConflictException('Cluster is in maintenance; mutation is blocked');
    }
    return record;
  }
}
