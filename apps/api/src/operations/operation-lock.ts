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
    const connection = await this.db.getConnection();
    const lockName = `docklane:${clusterId}:${canonicalServiceId}`;

    try {
      const [rows] = await connection.query<LockRow[]>(
        'SELECT GET_LOCK(?, 2) AS acquired',
        [lockName],
      );
      if (rows[0]?.acquired !== 1) {
        throw new ConflictException('Another service mutation is in progress');
      }
      return await fn(connection);
    } finally {
      try {
        await connection.query('SELECT RELEASE_LOCK(?)', [lockName]);
      } catch {
        // Releasing the connection closes any remaining named lock ownership.
      }
      connection.release();
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
