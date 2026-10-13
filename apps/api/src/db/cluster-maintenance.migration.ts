import type { PoolConnection } from 'mysql2/promise';

/**
 * Persistent cluster-wide maintenance state, never an Agent-side lock.
 *
 * A missing row means "not configured", NOT "OPEN" when maintenance admission
 * enforcement is enabled. No row is inserted by migration: the operator must
 * explicitly initialize a registered cluster before enabling enforcement.
 *
 * This schema does not itself fence Docker CLI writers, in-flight requests or
 * other Control Plane instances. Dispatch gates and manager barriers are
 * intentionally separate follow-up changes.
 */
export async function migrateClusterMaintenanceState(connection: PoolConnection): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS cluster_maintenance_states (
      cluster_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      state ENUM('OPEN', 'CLOSING', 'CLOSED', 'RECONCILING') NOT NULL,
      generation BIGINT UNSIGNED NOT NULL,
      owner_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      reason VARCHAR(1024) NOT NULL,
      changed_by VARCHAR(128) NOT NULL,
      changed_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT fk_cluster_maintenance_registration
        FOREIGN KEY (cluster_id) REFERENCES cluster_registrations(cluster_id)
        ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
  `);
}
