import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { Database } from '../db/database.js';
import { ClusterMaintenanceRepository } from './cluster-maintenance.repository.js';
import { MaintenanceControlLease, type MaintenanceLease } from './maintenance-control-lease.js';

export type EvidenceType = 'DISPATCH' | 'ADMISSION';

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

  async resolve(input: {
    clusterId: string; generation: bigint; type: EvidenceType;
    evidenceId: string; actorId: string; reason: string;
    observation: string; lease: MaintenanceLease;
    observedUnchanged?: { version: number; specHash: string };
  }): Promise<void> {
    if (!['CLOSING','RECONCILING'].includes((await this.maintenance.requireRecord(input.clusterId)).state) ||
        !input.reason.trim() || !input.observation.trim() ||
        input.reason.length > 1024 || input.observation.length > 4096) {
      throw new ConflictException('Recovery requires maintenance and substantive evidence');
    }
    const connection = await this.db.getConnection();
    try {
      await connection.beginTransaction();
      await this.leases.assertOwner(connection, input.lease);
      const [state] = await connection.query<(RowDataPacket & {state:string;generation:string})[]>(
        `SELECT state, CAST(generation AS CHAR) AS generation
         FROM cluster_maintenance_states WHERE cluster_id=? FOR UPDATE`,
        [input.clusterId]);
      if (!state[0] || !['CLOSING','RECONCILING'].includes(state[0].state) ||
          state[0].generation !== input.generation.toString()) {
        throw new ConflictException('Maintenance recovery generation changed');
      }
      const table = input.type === 'DISPATCH' ? 'maintenance_dispatches' : 'maintenance_active_admissions';
      const [evidence] = await connection.query<RowDataPacket[]>(
        `SELECT id FROM ${table} WHERE id=? AND cluster_id=? LIMIT 1 FOR UPDATE`,
        [input.evidenceId,input.clusterId]);
      if (evidence.length !== 1) throw new ConflictException('Evidence not found');
      if (input.type === 'DISPATCH') {
        const [records] = await connection.query<(RowDataPacket & {
          id:string;status:string;error_code:string|null;expected_version:number;
          before_spec_hash:string;resource_id:string;resource_type:string;
        })[]>(
          `SELECT id,status,error_code,expected_version,before_spec_hash,
             service_id AS resource_id,'service' AS resource_type
           FROM operations WHERE id=(SELECT operation_id FROM maintenance_dispatches WHERE id=?) AND cluster_id=?
           UNION ALL SELECT id,status,error_code,expected_version,before_spec_hash,
             node_id AS resource_id,'node' AS resource_type
           FROM node_operations WHERE id=(SELECT operation_id FROM maintenance_dispatches WHERE id=?) AND cluster_id=?`,
          [input.evidenceId,input.clusterId,input.evidenceId,input.clusterId]);
        if (records.length !== 1) throw new ConflictException('Dispatch operation missing');
        const op=records[0]!;
        if (op.status === 'NEEDS_ATTENTION') {
          const unchanged=input.observedUnchanged;
          if (!unchanged || !Number.isSafeInteger(unchanged.version) ||
              unchanged.version !== Number(op.expected_version) ||
              unchanged.specHash !== op.before_spec_hash ||
              !['MUTATION_NOT_OBSERVED','NODE_MUTATION_NOT_OBSERVED'].includes(op.error_code ?? '')) {
            throw new ConflictException('Manual resolution requires verified unchanged resource fingerprint');
          }
          // The caller must supply a fresh Agent observation obtained only
          // after all Manager handlers were drained. Failure and resolution
          // are one transaction so no remaining NEEDS_ATTENTION can deadlock
          // CLOSED. Never infer that the original HTTP call was unsent.
          const tableName=op.resource_type==='service'?'operations':'node_operations';
          const [updated]=await connection.execute<ResultSetHeader>(
            `UPDATE ${tableName} SET status='FAILED',
             error_code='MANUAL_MUTATION_NOT_OBSERVED',
             error_message=? WHERE id=? AND cluster_id=? AND status='NEEDS_ATTENTION'
             AND error_code=? AND expected_version=? AND before_spec_hash=?`,
            [input.reason,op.id,input.clusterId,op.error_code,unchanged.version,unchanged.specHash]);
          if(updated.affectedRows!==1) throw new ConflictException('Operation changed while resolving');
          await connection.execute(
            `INSERT INTO audit_events
             (operation_id,actor_id,cluster_id,service_id,resource_type,resource_id,action,after_json)
             VALUES (?,?,?,?,?,?, 'MUTATION_MANUALLY_RECONCILED',?)`,
            [op.id,input.actorId,input.clusterId,op.resource_id,op.resource_type,op.resource_id,
             JSON.stringify({result:'NOT_OBSERVED',observation:input.observation,
               version:unchanged.version,specHash:unchanged.specHash})]);
        } else if (!['SUCCESS','FAILED'].includes(op.status)) {
          throw new ConflictException('Dispatch operation requires terminal outcome');
        }
      }
      // Original evidence is immutable. Unique key prevents overwrite/replay.
      const resolutionId = randomUUID();
      await connection.execute<ResultSetHeader>(
        `INSERT INTO maintenance_evidence_resolutions
         (id,cluster_id,evidence_type,evidence_id,actor_id,reason,evidence_json)
         VALUES (?,?,?,?,?,?,?)`,
        [resolutionId,input.clusterId,input.type,input.evidenceId,input.actorId,input.reason,
          JSON.stringify({observation:input.observation,generation:input.generation.toString()})]);
      await connection.execute(
        `INSERT INTO audit_events
         (operation_id,actor_id,cluster_id,service_id,resource_type,resource_id,action,after_json)
         VALUES (?,?,?,?, 'cluster', ?, 'CLUSTER_MAINTENANCE_EVIDENCE_RESOLVED', ?)`,
        [randomUUID(),input.actorId,input.clusterId,input.clusterId,input.clusterId,
          JSON.stringify({resolutionId,type:input.type,evidenceId:input.evidenceId,
            observation:input.observation,reason:input.reason})]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }
}
