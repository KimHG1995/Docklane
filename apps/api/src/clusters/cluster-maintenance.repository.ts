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

  /**
   * Advisory readiness snapshot only. Nonterminal durable operations prevent
   * CLOSED, but zero rows cannot prove that no Agent HTTP request is in flight.
   * Do not use this alone to enable CLOSED or Swarm rejoin.
   */
  async countUnresolvedOperations(clusterId: string): Promise<bigint> {
    try {
      const [rows] = await this.db.query<(RowDataPacket & { count: string })[]>(
        `SELECT CAST((
           (SELECT COUNT(*) FROM operations
            WHERE cluster_id = ? AND status IN ('PENDING','RUNNING','VERIFYING','NEEDS_ATTENTION'))
           +
           (SELECT COUNT(*) FROM node_operations
            WHERE cluster_id = ? AND status IN ('PENDING','RUNNING','VERIFYING','NEEDS_ATTENTION'))
         ) AS CHAR) AS count`,
        [clusterId, clusterId],
      );
      if (!rows[0] || !/^[0-9]+$/.test(String(rows[0].count))) {
        throw new Error('Invalid unresolved operation count');
      }
      return BigInt(rows[0].count);
    } catch {
      throw new ServiceUnavailableException('Unresolved operation state cannot be verified');
    }
  }

  /**
   * Persisted admission rows represent callbacks that may still send Docker
   * updates. Unclean process termination leaves them present on purpose.
   * A zero count is necessary but is not an Agent barrier acknowledgement.
   */
  /**
   * Internal CLOSED primitive. Call ONLY after a fresh all-manager blockAll
   * result using the fixed Swarm roster. One InnoDB transaction locks the
   * maintenance generation and checks durable admission, service/node operation
   * and HTTP dispatch evidence before writing the CLOSED audit event.
   *
   * Even a successful commit does not fence external Docker CLI writers or
   * independently prove that the manager roster has not changed afterward.
   * No public controller invokes this primitive until final acceptance.
   */
  async commitClosed(
    clusterId: string, generation: bigint, actorId: string, reason: string,
    expectedAgentIds: readonly string[],
  ): Promise<boolean> {
    if (generation < 1n || !actorId.trim() || !reason.trim() ||
        expectedAgentIds.length < 1 || new Set(expectedAgentIds).size !== expectedAgentIds.length ||
        reason.length > 1024) throw new ConflictException('Invalid maintenance closure evidence');
    const connection = await this.db.getConnection();
    try {
      await connection.beginTransaction();
      const [state] = await connection.query<(RowDataPacket & {state:string; generation:string})[]>(
        `SELECT state, CAST(generation AS CHAR) AS generation FROM cluster_maintenance_states
         WHERE cluster_id = ? FOR UPDATE`, [clusterId]);
      if (state[0]?.state !== 'CLOSING' || state[0]?.generation !== generation.toString()) {
        await connection.rollback();
        return false;
      }
      const [counts] = await connection.query<(RowDataPacket & {active:string; operations:string; dispatches:string})[]>(
        `SELECT
          (SELECT CAST(COUNT(*) AS CHAR) FROM maintenance_active_admissions WHERE cluster_id = ?) AS active,
          (SELECT CAST(COUNT(*) AS CHAR) FROM operations
           WHERE cluster_id = ? AND status IN ('PENDING','RUNNING','VERIFYING','NEEDS_ATTENTION'))
          + (SELECT COUNT(*) FROM node_operations
             WHERE cluster_id = ? AND status IN ('PENDING','RUNNING','VERIFYING','NEEDS_ATTENTION')) AS operations,
          (SELECT CAST(COUNT(*) AS CHAR) FROM maintenance_dispatches
           WHERE cluster_id = ? AND phase IN ('PREPARED','SENDING','UNCERTAIN')) AS dispatches`,
        [clusterId, clusterId, clusterId, clusterId],
      );
      const proof=counts[0];
      if (!proof || String(proof.active)!=='0' || String(proof.operations)!=='0' || String(proof.dispatches)!=='0') {
        throw new ConflictException('Maintenance has unresolved admission, operation or dispatch');
      }
      const [acks] = await connection.query<(RowDataPacket & {agent_id:string;generation:string;state:string})[]>(
        `SELECT agent_id, CAST(generation AS CHAR) AS generation, state
         FROM maintenance_agent_barriers WHERE cluster_id = ? ORDER BY agent_id`,
        [clusterId]);
      const expected=[...expectedAgentIds].sort();
      if (acks.length !== expected.length || acks.some((ack,i)=>
        ack.agent_id!==expected[i] || ack.generation!==generation.toString() ||
        ack.state!=='ACKNOWLEDGED')) {
        throw new ConflictException('Complete manager barrier acknowledgement is missing');
      }
      const [updated] = await connection.execute<import('mysql2/promise').ResultSetHeader>(
        `UPDATE cluster_maintenance_states SET state='CLOSED', generation=generation+1,
         changed_by=?, owner_id=?, reason=?, changed_at=UTC_TIMESTAMP(6)
         WHERE cluster_id=? AND state='CLOSING' AND generation=?`,
        [actorId,actorId,reason,clusterId,generation.toString()]);
      if (updated.affectedRows!==1) throw new ConflictException('Maintenance generation changed');
      await connection.execute(
        `INSERT INTO audit_events
         (operation_id, actor_id, cluster_id, service_id, resource_type,
          resource_id, action, after_json)
         VALUES (?,?,?,?, 'cluster', ?, 'CLUSTER_MAINTENANCE_CLOSED', ?)`,
        [randomUUID(),actorId,clusterId,clusterId,clusterId,
          JSON.stringify({generation:(generation+1n).toString(),reason,managerIds:expected})]);
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async countActiveAdmissions(clusterId: string): Promise<bigint> {
    try {
      const [rows] = await this.db.query<(RowDataPacket & { count: string })[]>(
        'SELECT CAST(COUNT(*) AS CHAR) AS count FROM maintenance_active_admissions WHERE cluster_id = ?',
        [clusterId],
      );
      if (!rows[0] || !/^[0-9]+$/.test(String(rows[0].count))) {
        throw new Error('Invalid admission count');
      }
      return BigInt(rows[0].count);
    } catch {
      throw new ServiceUnavailableException('In-flight admission evidence unavailable');
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
