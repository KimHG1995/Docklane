import { randomUUID } from 'node:crypto';
const PROCESS_INSTANCE_ID = randomUUID();
import type { ResultSetHeader } from 'mysql2/promise';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { Database } from '../db/database.js';
import { OperationLock } from '../operations/operation-lock.js';
import { ClusterBindingPolicy } from './cluster-binding.policy.js';

// Opt-in while administrative transitions and manager barriers are unfinished.
// This is an admission guard, not Docker-native atomic fencing.
const maintenanceEnforced = () => process.env.DOCKLANE_MAINTENANCE_ENFORCE === '1';
interface MaintenanceGuardRow extends RowDataPacket { state: string; generation: string | number }

async function assertMaintenanceOpen(connection: PoolConnection, clusterId: string,
  type: 'service' | 'node', resourceId: string): Promise<string | null> {
  if (!maintenanceEnforced()) return null;
  let rows: MaintenanceGuardRow[];
  try {
    [rows] = await connection.query<MaintenanceGuardRow[]>(
      'SELECT state, CAST(generation AS CHAR) AS generation FROM cluster_maintenance_states WHERE cluster_id = ? LIMIT 1',
      [clusterId],
    );
  } catch {
    throw new ServiceUnavailableException('Maintenance state unavailable');
  }
  const row = rows[0];
  if (!row || row.state !== 'OPEN' || BigInt(row.generation) < 1n) {
    throw new ConflictException('Cluster maintenance admission closed');
  }
  // The registration row is committed before the caller can issue Agent HTTP.
  // CLOSING locks the same maintenance row, preventing admission after closing.
  const id = randomUUID();
  const [result] = await connection.query<ResultSetHeader>(`INSERT INTO maintenance_active_admissions
    (id, cluster_id, generation, owner_id, resource_type, resource_id)
    SELECT ?, cluster_id, generation, ?, ?, ? FROM cluster_maintenance_states
    WHERE cluster_id = ? AND state = 'OPEN' AND generation = ?`,
    [id, PROCESS_INSTANCE_ID, type, resourceId, clusterId, String(row.generation)]);
  if (result.affectedRows !== 1) throw new ConflictException('Maintenance admission changed');
  return id;
}

async function releaseAdmission(connection: PoolConnection, id: string | null): Promise<void> {
  if (id === null) return;
  // A failed delete leaves conservative evidence and prevents CLOSED.
  await connection.query('DELETE FROM maintenance_active_admissions WHERE id = ?', [id]);
}

export class RegisteredOperationLock extends OperationLock {
  // Observation-only recovery retains resource serialization and cluster binding,
  // but bypasses admission which only governs NEW mutations. Callers MUST NOT
  // dispatch Docker mutation from this callback.
  override async withServiceRecoveryLock<T>(
    clusterId: string, serviceId: string, fn: (connection: PoolConnection) => Promise<T>,
  ): Promise<T> {
    await this.binding.assertRegistered(clusterId);
    return super.withServiceRecoveryLock(clusterId, serviceId,
      connection => this.binding.withLockedConnection(connection, () => fn(connection)));
  }

  override async withNodeRecoveryLocks<T>(
    clusterId: string, nodeId: string, serviceIds: string[],
    fn: (connection: PoolConnection) => Promise<T>,
  ): Promise<T> {
    await this.binding.assertRegistered(clusterId);
    return super.withNodeRecoveryLocks(clusterId, nodeId, serviceIds,
      connection => this.binding.withLockedConnection(connection, () => fn(connection)));
  }

  constructor(db: Database, private readonly binding: ClusterBindingPolicy) {
    super(db);
  }

  override async withServiceLock<T>(
    clusterId: string,
    canonicalServiceId: string,
    fn: (connection: PoolConnection) => Promise<T>,
  ): Promise<T> {
    await this.binding.assertRegistered(clusterId);
    return super.withServiceLock(
      clusterId, canonicalServiceId,
      (connection) => this.binding.withLockedConnection(connection, async () => {
        const admission = await assertMaintenanceOpen(connection, clusterId, 'service', canonicalServiceId);
        try { return await fn(connection); }
        finally { await releaseAdmission(connection, admission); }
      }),
    );
  }

  override async withNodeAndServiceLocks<T>(
    clusterId: string,
    canonicalNodeId: string,
    serviceIds: string[],
    fn: (connection: PoolConnection) => Promise<T>,
  ): Promise<T> {
    await this.binding.assertRegistered(clusterId);
    return super.withNodeAndServiceLocks(
      clusterId, canonicalNodeId, serviceIds,
      (connection) => this.binding.withLockedConnection(connection, async () => {
        const admission = await assertMaintenanceOpen(connection, clusterId, 'node', canonicalNodeId);
        try { return await fn(connection); }
        finally { await releaseAdmission(connection, admission); }
      }),
    );
  }
}
