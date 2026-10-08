import type { PoolConnection } from 'mysql2/promise';

export async function migrateRollbackAttemptHistory(connection: PoolConnection): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS rollback_attempts (
      operation_id VARCHAR(64) PRIMARY KEY,
      deployment_id VARCHAR(64) NOT NULL,
      created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      INDEX idx_rollback_attempts_deployment (deployment_id, created_at),
      CONSTRAINT fk_rollback_attempt_deployment
        FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE RESTRICT,
      CONSTRAINT fk_rollback_attempt_operation
        FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB
  `);
  // Existing schema held one latest attempt. Backfill only when the operation is
  // a genuine ROLLBACK for the same cluster as its original deployment target.
  await connection.query(`
    INSERT INTO rollback_attempts (operation_id, deployment_id)
    SELECT o.id, d.id
    FROM deployments d
    JOIN deployment_targets t ON t.id = d.deployment_target_id
    JOIN operations o ON o.id = d.rollback_operation_id
      AND o.type = 'ROLLBACK' AND o.cluster_id = t.cluster_id
      AND o.service_id = t.docker_service_id
    ON DUPLICATE KEY UPDATE deployment_id = deployment_id
  `);
}
