import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { Database } from '../db/database.js';
import { OperationLock } from '../operations/operation-lock.js';
import { ClusterMaintenanceRepository } from './cluster-maintenance.repository.js';
import { MaintenanceControlLease, type MaintenanceLease } from './maintenance-control-lease.js';

export type EvidenceType = 'DISPATCH' | 'ADMISSION';

interface ResolveEvidenceInput {
  clusterId: string;
  generation: bigint;
  type: EvidenceType;
  evidenceId: string;
  actorId: string;
  reason: string;
  observation: string;
  lease: MaintenanceLease;
  observedUnchanged?: { version: number; specHash: string };
}

type LockedResource =
  | { type: 'service'; id: string }
  | { type: 'node'; id: string; affectedServiceIds: string[] };

function affectedServices(value: unknown): string[] {
  let parsed: unknown = value;
  try {
    if (typeof value === 'string') parsed = JSON.parse(value) as unknown;
  } catch {
    throw new ConflictException('Invalid affected services in recorded node operation');
  }
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== 'string' || !id)) {
    throw new ConflictException('Invalid affected services in recorded node operation');
  }
  return [...new Set(parsed as string[])].sort();
}

/**
 * An immutable manual resolution is NOT inferred from a later SUCCESS state.
 * The operator supplies observation evidence after all Agent barriers are
 * durably BLOCKED. Audit and resolution commit together, never deleting raw
 * SENDING/UNCERTAIN/admission history.
 */
@Injectable()
export class MaintenanceEvidenceRecovery {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ClusterMaintenanceRepository) private readonly maintenance: ClusterMaintenanceRepository,
    @Inject(MaintenanceControlLease) private readonly leases: MaintenanceControlLease,
    @Inject(OperationLock) private readonly operationLock: OperationLock,
  ) {}

  async list(clusterId: string) {
    const [dispatch] = await this.db.query<RowDataPacket[]>(
      `SELECT d.id, d.operation_id AS operationId, d.agent_id AS agentId,
          d.phase, CAST(d.generation AS CHAR) AS generation, d.created_at AS createdAt
         FROM maintenance_dispatches d WHERE d.cluster_id=?
         AND d.phase IN ('PREPARED','SENDING','UNCERTAIN')
         AND NOT EXISTS (SELECT 1 FROM maintenance_evidence_resolutions r
          WHERE r.cluster_id=d.cluster_id AND r.evidence_type='DISPATCH' AND r.evidence_id=d.id)
         ORDER BY d.created_at`, [clusterId]);
    const [admissions] = await this.db.query<RowDataPacket[]>(
      `SELECT a.id, a.owner_id AS ownerId, a.resource_type AS resourceType,
          a.resource_id AS resourceId, a.operation_id AS operationId, CAST(a.generation AS CHAR) AS generation,
          a.created_at AS createdAt
         FROM maintenance_active_admissions a WHERE a.cluster_id=?
         AND NOT EXISTS (SELECT 1 FROM maintenance_evidence_resolutions r
          WHERE r.cluster_id=a.cluster_id AND r.evidence_type='ADMISSION' AND r.evidence_id=a.id)
         ORDER BY a.created_at`, [clusterId]);
    return { dispatch, admissions };
  }


  async resolve(input: ResolveEvidenceInput): Promise<void> {
    if (
      !['CLOSING', 'RECONCILING'].includes((await this.maintenance.requireRecord(input.clusterId)).state) ||
      !input.reason.trim() || !input.observation.trim() ||
      input.reason.length > 1024 || input.observation.length > 4096
    ) {
      throw new ConflictException('Recovery requires maintenance and substantive evidence');
    }

    if (input.type === 'DISPATCH') {
      // Discover only the immutable operation identity here. Acquire the SAME
      // advisory resource locks as startup reconciliation before any state read
      // or write used to authorize a manual recovery.
      const [rows] = await this.db.query<(RowDataPacket & {
        resourceId: string; resourceType: string; affectedServiceIds: unknown;
      })[]>(
        `SELECT o.service_id AS resourceId, 'service' AS resourceType,
                  NULL AS affectedServiceIds
           FROM maintenance_dispatches d JOIN operations o
             ON o.id = d.operation_id AND o.cluster_id = d.cluster_id
           WHERE d.id = ? AND d.cluster_id = ?
           UNION ALL
           SELECT n.node_id AS resourceId, 'node' AS resourceType,
                  n.affected_service_ids AS affectedServiceIds
           FROM maintenance_dispatches d JOIN node_operations n
             ON n.id = d.operation_id AND n.cluster_id = d.cluster_id
           WHERE d.id = ? AND d.cluster_id = ?`,
        [input.evidenceId, input.clusterId, input.evidenceId, input.clusterId],
      );
      if (rows.length !== 1 || !rows[0]?.resourceId) {
        throw new ConflictException('Dispatch operation identity is ambiguous');
      }
      const row = rows[0];
      if (row.resourceType === 'service') {
        const resource: LockedResource = { type: 'service', id: row.resourceId };
        return this.operationLock.withServiceRecoveryLock(
          input.clusterId, resource.id,
          (connection) => this.resolveWithinTransaction(connection, input, resource),
        );
      }
      if (row.resourceType === 'node') {
        const resource: LockedResource = {
          type: 'node', id: row.resourceId,
          affectedServiceIds: affectedServices(row.affectedServiceIds),
        };
        return this.operationLock.withNodeRecoveryLocks(
          input.clusterId, resource.id, resource.affectedServiceIds,
          (connection) => this.resolveWithinTransaction(connection, input, resource),
        );
      }
      throw new ConflictException('Unsupported dispatch resource');
    }

    const connection = await this.db.getConnection();
    try {
      await this.resolveWithinTransaction(connection, input);
    } finally {
      connection.release();
    }
  }

  private async resolveWithinTransaction(
    connection: PoolConnection,
    input: ResolveEvidenceInput,
    lockedResource?: LockedResource,
  ): Promise<void> {
    try {
      await connection.beginTransaction();
      await this.leases.assertOwner(connection, input.lease);
      const [state] = await connection.query<(RowDataPacket & { state: string; generation: string })[]>(
        `SELECT state, CAST(generation AS CHAR) AS generation
         FROM cluster_maintenance_states WHERE cluster_id = ? FOR UPDATE`,
        [input.clusterId],
      );
      if (!state[0] || !['CLOSING', 'RECONCILING'].includes(state[0].state) ||
          state[0].generation !== input.generation.toString()) {
        throw new ConflictException('Maintenance recovery generation changed');
      }

      const evidenceTable = input.type === 'DISPATCH'
        ? 'maintenance_dispatches' : 'maintenance_active_admissions';
      const [evidence] = await connection.query<RowDataPacket[]>(
        `SELECT id FROM ${evidenceTable} WHERE id = ? AND cluster_id = ? LIMIT 1 FOR UPDATE`,
        [input.evidenceId, input.clusterId],
      );
      if (evidence.length !== 1) throw new ConflictException('Evidence not found');

      let outcome: Record<string, unknown> = {};
      if (input.type === 'DISPATCH') {
        const [records] = await connection.query<(RowDataPacket & {
          id: string; type: string; status: string; error_code: string | null;
          expected_version: number; before_spec_hash: string;
          resource_id: string; resource_type: string; affected_services: unknown;
        })[]>(
          `SELECT id, type, status, error_code, expected_version, before_spec_hash,
             service_id AS resource_id, 'service' AS resource_type, NULL AS affected_services
           FROM operations WHERE id = (SELECT operation_id FROM maintenance_dispatches WHERE id = ?)
             AND cluster_id = ?
           UNION ALL
           SELECT id, type, status, error_code, expected_version, before_spec_hash,
             node_id AS resource_id, 'node' AS resource_type,
             affected_service_ids AS affected_services
           FROM node_operations WHERE id = (SELECT operation_id FROM maintenance_dispatches WHERE id = ?)
             AND cluster_id = ?`,
          [input.evidenceId, input.clusterId, input.evidenceId, input.clusterId],
        );
        if (records.length !== 1) throw new ConflictException('Dispatch operation missing');
        const op = records[0]!;
        if (!lockedResource || op.resource_type !== lockedResource.type ||
            op.resource_id !== lockedResource.id ||
            (lockedResource.type === 'node' &&
             JSON.stringify(affectedServices(op.affected_services)) !==
             JSON.stringify(lockedResource.affectedServiceIds))) {
          throw new ConflictException('Dispatch resource changed before recovery lock');
        }

        const manualRecovery =
          (op.resource_type === 'node' && op.status === 'NEEDS_ATTENTION' &&
           op.error_code === 'NODE_MUTATION_NOT_OBSERVED') ||
          (op.resource_type === 'service' && (
            ((op.type === 'SCALE' || op.type === 'RESTART') &&
              op.status === 'NEEDS_ATTENTION' && op.error_code === 'MUTATION_NOT_OBSERVED') ||
            (op.type === 'DEPLOY' && op.status === 'NEEDS_ATTENTION' &&
              op.error_code === 'DEPLOYMENT_MUTATION_NOT_OBSERVED') ||
            (op.type === 'ROLLBACK' && op.status === 'VERIFYING' &&
              op.error_code === 'ROLLBACK_STILL_IN_PROGRESS')
          ));

        if (manualRecovery) {
          const unchanged = input.observedUnchanged;
          if (!unchanged || !Number.isSafeInteger(unchanged.version) ||
              unchanged.version !== Number(op.expected_version) ||
              unchanged.specHash !== op.before_spec_hash) {
            throw new ConflictException('Manual resolution requires verified unchanged resource fingerprint');
          }

          let deploymentId: string | null = null;
          let previousDeploymentStatus: string | null = null;
          if (op.type === 'DEPLOY' || op.type === 'ROLLBACK') {
            // A deployment or rollback is not just an operation row: its
            // linked deployment and immutable rollback_attempt must be proven
            // current before the operator can close the uncertainty.
            const rollback = op.type === 'ROLLBACK';
            const [linked] = await connection.query<(RowDataPacket & {
              id: string; status: string; operation_id: string;
              rollback_operation_id: string | null; attempt_id: string | null;
              cluster_id: string; docker_service_id: string;
            })[]>(
              rollback
                ? `SELECT d.id, d.status, d.operation_id, d.rollback_operation_id,
                        a.operation_id AS attempt_id, t.cluster_id, t.docker_service_id
                   FROM rollback_attempts a JOIN deployments d ON d.id = a.deployment_id
                   JOIN deployment_targets t ON t.id = d.deployment_target_id
                   WHERE a.operation_id = ? FOR UPDATE`
                : `SELECT d.id, d.status, d.operation_id, d.rollback_operation_id,
                        NULL AS attempt_id, t.cluster_id, t.docker_service_id
                   FROM deployments d JOIN deployment_targets t ON t.id = d.deployment_target_id
                   WHERE d.operation_id = ? FOR UPDATE`,
              [op.id],
            );
            const deployment = linked[0];
            if (linked.length !== 1 || !deployment ||
                deployment.cluster_id !== input.clusterId ||
                deployment.docker_service_id !== op.resource_id ||
                (rollback
                  ? deployment.rollback_operation_id !== op.id ||
                    deployment.attempt_id !== op.id ||
                    deployment.status !== 'ROLLBACK_VERIFYING'
                  : deployment.operation_id !== op.id ||
                    deployment.status !== 'NEEDS_ATTENTION' ||
                    deployment.rollback_operation_id !== null)) {
              throw new ConflictException('Deployment or rollback record changed before manual recovery');
            }
            deploymentId = deployment.id;
            previousDeploymentStatus = deployment.status;
          }

          const operationTable = op.resource_type === 'service' ? 'operations' : 'node_operations';
          const [updated] = await connection.execute<ResultSetHeader>(
            `UPDATE ${operationTable}
             SET status = 'FAILED', error_code = 'MANUAL_MUTATION_NOT_OBSERVED',
                 error_message = ?
             WHERE id = ? AND cluster_id = ? AND status = ? AND error_code = ?
               AND expected_version = ? AND before_spec_hash = ?`,
            [input.reason, op.id, input.clusterId, op.status, op.error_code,
              unchanged.version, unchanged.specHash],
          );
          if (updated.affectedRows !== 1) {
            throw new ConflictException('Operation changed while resolving');
          }

          if (deploymentId !== null) {
            // ROLLBACK was never observed, so restore the failed deployment
            // baseline (allowing a NEW rollback ID); retain rollback_attempts
            // and the old pointer for historical per-operation lookups.
            const rollback = op.type === 'ROLLBACK';
            const [deploymentUpdated] = await connection.execute<ResultSetHeader>(
              `UPDATE deployments
               SET status = 'FAILED', reason = ?, finished_at = UTC_TIMESTAMP(6)
               WHERE id = ? AND status = ?
                 AND ${rollback ? 'rollback_operation_id' : 'operation_id'} = ?`,
              [input.reason, deploymentId, previousDeploymentStatus, op.id],
            );
            if (deploymentUpdated.affectedRows !== 1) {
              throw new ConflictException('Deployment changed while resolving');
            }
          }
          outcome = {
            operationId: op.id, operationType: op.type, resourceType: op.resource_type,
            resourceId: op.resource_id, previousStatus: op.status,
            previousErrorCode: op.error_code, result: 'NOT_OBSERVED',
            version: unchanged.version, specHash: unchanged.specHash,
            deploymentId, previousDeploymentStatus,
          };
          await connection.execute(
            `INSERT INTO audit_events
             (operation_id, actor_id, cluster_id, service_id, resource_type, resource_id, action, after_json)
             VALUES (?, ?, ?, ?, ?, ?, 'MUTATION_MANUALLY_RECONCILED', ?)`,
            [op.id, input.actorId, input.clusterId, op.resource_id,
              op.resource_type, op.resource_id,
              JSON.stringify({ ...outcome, observation: input.observation, reason: input.reason })],
          );
        } else if (op.status !== 'SUCCESS' && op.status !== 'FAILED') {
          throw new ConflictException('Dispatch operation requires terminal outcome or supported unchanged-state recovery');
        }
      }

      // Raw dispatch/admission evidence and rollback_attempts are immutable.
      // Resolution, operation, deployment and both audits commit atomically.
      const resolutionId = randomUUID();
      await connection.execute<ResultSetHeader>(
        `INSERT INTO maintenance_evidence_resolutions
         (id, cluster_id, evidence_type, evidence_id, actor_id, reason, evidence_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [resolutionId, input.clusterId, input.type, input.evidenceId, input.actorId, input.reason,
          JSON.stringify({ observation: input.observation,
            generation: input.generation.toString(), ...outcome })],
      );
      await connection.execute(
        `INSERT INTO audit_events
         (operation_id, actor_id, cluster_id, service_id, resource_type, resource_id, action, after_json)
         VALUES (?, ?, ?, ?, 'cluster', ?, 'CLUSTER_MAINTENANCE_EVIDENCE_RESOLVED', ?)`,
        [randomUUID(), input.actorId, input.clusterId, input.clusterId, input.clusterId,
          JSON.stringify({ resolutionId, type: input.type, evidenceId: input.evidenceId,
            observation: input.observation, reason: input.reason, ...outcome })],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }
}
