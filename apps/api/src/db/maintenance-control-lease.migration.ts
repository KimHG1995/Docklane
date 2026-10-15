import type { PoolConnection } from 'mysql2/promise';

/**
 * A monotonic per-cluster fencing token for competing Control Planes.
 * Keep the row after lease release: deleting it would reset the token and
 * allow an old owner to masquerade as the newest generation.
 */
export async function migrateMaintenanceControlLease(connection: PoolConnection): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS maintenance_control_leases (
      cluster_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      holder_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      fence_token BIGINT UNSIGNED NOT NULL,
      expires_at DATETIME(6) NOT NULL,
      CONSTRAINT fk_maintenance_control_lease_cluster
        FOREIGN KEY (cluster_id) REFERENCES cluster_maintenance_states(cluster_id)
        ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
  `);
}
