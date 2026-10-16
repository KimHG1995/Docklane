import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { Database } from '../db/database.js';

export interface MaintenanceLease { clusterId: string; holderId: string; token: bigint }
/**
 * Serializes maintenance orchestrators across CP processes. DB UTC time is
 * authoritative. Every reacquisition increments a persistent fencing token.
 * This does NOT itself fence an HTTP request already accepted by an Agent.
 */
@Injectable()
export class MaintenanceControlLease {
  constructor(@Inject(Database) private readonly db: Database) {}
  async acquire(clusterId: string, ttlSeconds = 30): Promise<MaintenanceLease> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 5 || ttlSeconds > 300) {
      throw new ConflictException('Invalid maintenance lease TTL');
    }
    const holderId = randomUUID();
    const connection = await this.db.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<(RowDataPacket & { holder_id: string; fence_token: string; expired: number })[]>(
        `SELECT holder_id, CAST(fence_token AS CHAR) AS fence_token,
           (expires_at <= UTC_TIMESTAMP(6)) AS expired
         FROM maintenance_control_leases WHERE cluster_id = ? FOR UPDATE`, [clusterId]);
      if (rows.length && Number(rows[0]!.expired) !== 1) {
        throw new ConflictException('Another Control Plane holds the maintenance lease');
      }
      let token = 1n;
      if (rows.length) {
        token = BigInt(rows[0]!.fence_token) + 1n;
        await connection.execute(
          `UPDATE maintenance_control_leases SET holder_id = ?, fence_token = ?,
            expires_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND)
           WHERE cluster_id = ?`, [holderId, token.toString(), ttlSeconds, clusterId]);
      } else {
        await connection.execute(
          `INSERT INTO maintenance_control_leases (cluster_id, holder_id, fence_token, expires_at)
           VALUES (?, ?, 1, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND))`,
          [clusterId, holderId, ttlSeconds]);
      }
      await connection.commit();
      return { clusterId, holderId, token };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }
  async assertOwner(connection: import('mysql2/promise').PoolConnection, lease: MaintenanceLease): Promise<void> {
    const [rows] = await connection.query<(RowDataPacket & { valid: number })[]>(
      `SELECT 1 AS valid FROM maintenance_control_leases
       WHERE cluster_id = ? AND holder_id = ? AND fence_token = ?
         AND expires_at > UTC_TIMESTAMP(6) FOR UPDATE`,
      [lease.clusterId, lease.holderId, lease.token.toString()]);
    if (rows.length !== 1) throw new ConflictException('Maintenance lease is expired or fenced');
  }
  async release(lease: MaintenanceLease): Promise<void> {
    // Keep token. An old holder cannot release a newer holder's lease.
    const [result] = await this.db.query<ResultSetHeader>(
      `UPDATE maintenance_control_leases SET expires_at = UTC_TIMESTAMP(6)
       WHERE cluster_id = ? AND holder_id = ? AND fence_token = ?`,
      [lease.clusterId, lease.holderId, lease.token.toString()]);
    if (result.affectedRows !== 1) throw new ConflictException('Maintenance lease ownership lost');
  }
}
