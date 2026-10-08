import type { PoolConnection } from 'mysql2/promise';

// Additive schema only: no implicit registration or existing target reassignment.
export async function migrateClusterRegistration(connection: PoolConnection): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS cluster_registrations (
      cluster_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      swarm_cluster_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      display_name VARCHAR(128) NOT NULL,
      registered_by VARCHAR(128) NOT NULL,
      verified_node_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      UNIQUE KEY uq_cluster_registration_id (id),
      UNIQUE KEY uq_cluster_registration_swarm (swarm_cluster_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
  `);
}
