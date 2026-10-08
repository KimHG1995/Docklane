import type { PoolConnection } from 'mysql2/promise';
import { Database } from '../db/database.js';
import { OperationLock } from '../operations/operation-lock.js';
import { ClusterBindingPolicy } from './cluster-binding.policy.js';

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
      (connection) => this.binding.withLockedConnection(connection, () => fn(connection)),
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
      (connection) => this.binding.withLockedConnection(connection, () => fn(connection)),
    );
  }
}
