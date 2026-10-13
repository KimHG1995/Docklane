import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { Database } from '../db/database.js';
import { OperationLock } from '../operations/operation-lock.js';
import { ClusterBindingPolicy } from './cluster-binding.policy.js';

// Opt-in while administrative transitions and manager barriers are unfinished.
// This is an admission guard, not Docker-native atomic fencing.
const maintenanceEnforced = () => process.env.DOCKLANE_MAINTENANCE_ENFORCE === '1';
interface MaintenanceGuardRow extends RowDataPacket { state: string; generation: string | number }

async function assertMaintenanceOpen(connection: PoolConnection, clusterId: string): Promise<void> {
  if (!maintenanceEnforced()) return;
  let rows: MaintenanceGuardRow[];
  try {
    [rows] = await connection.query<MaintenanceGuardRow[]>(
      'SELECT state, generation FROM cluster_maintenance_states WHERE cluster_id = ? LIMIT 1',
      [clusterId],
    );
  } catch {
    throw new ServiceUnavailableException('Maintenance state unavailable');
  }
  const row = rows[0];
  if (!row || row.state !== 'OPEN' || BigInt(row.generation) < 1n) {
    throw new ConflictException('Cluster maintenance admission closed');
  }
}

export class RegisteredOperationLock extends OperationLock {
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
        await assertMaintenanceOpen(connection, clusterId);
        return fn(connection);
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
        await assertMaintenanceOpen(connection, clusterId);
        return fn(connection);
      }),
    );
  }
}
