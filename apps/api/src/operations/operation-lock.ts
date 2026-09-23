import { createHash } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { Database } from '../db/database.js';

interface LockRow extends RowDataPacket {
  acquired: number | null;
}

@Injectable()
export class OperationLock {
  constructor(@Inject(Database) private readonly db: Database) {}

  async withServiceLock<T>(
    clusterId: string,
    canonicalServiceId: string,
    fn: (connection: PoolConnection) => Promise<T>,
  ): Promise<T> {
    return this.withResourceLocks(
      [resourceLockKey('service', clusterId, canonicalServiceId)],
      fn,
    );
  }

  async withNodeAndServiceLocks<T>(
    clusterId: string,
    canonicalNodeId: string,
    serviceIds: string[],
    fn: (connection: PoolConnection) => Promise<T>,
  ): Promise<T> {
    const keys = [
      resourceLockKey('node', clusterId, canonicalNodeId),
      ...serviceIds.map((serviceId) =>
        resourceLockKey('service', clusterId, serviceId),
      ),
    ];
    return this.withResourceLocks(keys, fn);
  }

  private async withResourceLocks<T>(
    resourceKeys: string[],
    fn: (connection: PoolConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.db.getConnection();
    const lockNames = [...new Set(resourceKeys.map(namedLockName))].sort();
    const acquired: string[] = [];
    let reusable = true;

    try {
      for (const lockName of lockNames) {
        const [rows] = await connection.query<LockRow[]>(
          'SELECT GET_LOCK(?, 2) AS acquired',
          [lockName],
        );
        if (rows[0]?.acquired !== 1) {
          throw new ConflictException(
            'Another mutation is in progress for an affected resource',
          );
        }
        acquired.push(lockName);
      }

      return await fn(connection);
    } finally {
      for (const lockName of acquired.reverse()) {
        try {
          await connection.query('SELECT RELEASE_LOCK(?)', [lockName]);
        } catch {
          reusable = false;
          connection.destroy();
          break;
        }
      }
      if (reusable) {
        connection.release();
      }
    }
  }

  async assertAvailable(): Promise<void> {
    try {
      await this.db.pool.query('SELECT 1');
    } catch (error) {
      throw new InternalServerErrorException(
        `Database unavailable: ${String(error)}`,
      );
    }
  }
}


function resourceLockKey(
  type: 'service' | 'node',
  clusterId: string,
  resourceId: string,
): string {
  return `${type}\0${clusterId}\0${resourceId}`;
}

function namedLockName(resourceKey: string): string {
  const digest = createHash('sha256').update(resourceKey).digest('hex');
  return `docklane:${digest.slice(0, 55)}`;
}
