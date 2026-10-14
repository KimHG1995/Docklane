import { randomUUID } from 'node:crypto';
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';
import { Database } from '../db/database.js';

export type DispatchPhase = 'PREPARED' | 'SENDING' | 'ACKNOWLEDGED' | 'REJECTED' | 'UNCERTAIN';

/**
 * Durable record for HTTP mutation send uncertainty.
 *
 * A persisted SENDING row is intentionally left unresolved after a CP crash.
 * Callers MUST NOT mark ACKNOWLEDGED after a timeout, a lost response, or a
 * later read showing unchanged Docker state.
 *
 * Callers holding a resource lock MUST pass that same connection to avoid
 * deadlocking a fully utilized pool. An INSERT/UPDATE must be committed before
 * sending bytes: do not call with an open transaction that may roll back.
 * Not yet wired to runtime dispatch or owner-generation fencing.
 */
@Injectable()
export class MaintenanceDispatchJournal {
  constructor(@Inject(Database) private readonly db: Database) {}

  async prepare(clusterId: string, generation: bigint, agentId: string, operationId: string, connection?: PoolConnection): Promise<string> {
    const id = randomUUID();
    try {
      const executor = connection ?? this.db;
      await executor.query<ResultSetHeader>(
        `INSERT INTO maintenance_dispatches (id, cluster_id, generation, agent_id, operation_id, phase)
         VALUES (?, ?, ?, ?, ?, 'PREPARED')`,
        [id, clusterId, generation.toString(), agentId, operationId],
      );
    } catch {
      throw new ServiceUnavailableException('Mutation dispatch journal unavailable before send');
    }
    return id;
  }

  /**
   * Atomically checks the current maintenance generation while promoting one
   * PREPARED record to SENDING. A stale owner or CLOSING cluster cannot pass.
   *
   * The caller must commit this statement before invoking HTTP transport.
   * This is a DB admission barrier, NOT an atomic Docker mutation barrier.
   */
  async beginSend(
    id: string,
    clusterId: string,
    expectedGeneration: bigint,
    agentId: string,
    operationId: string,
    connection?: PoolConnection,
  ): Promise<void> {
    const executor = connection ?? this.db;
    let result: ResultSetHeader;
    try {
      [result] = await executor.query<ResultSetHeader>(
        `UPDATE maintenance_dispatches AS dispatch
         INNER JOIN cluster_maintenance_states AS maintenance
           ON maintenance.cluster_id = dispatch.cluster_id
         SET dispatch.phase = 'SENDING'
         WHERE dispatch.id = ?
           AND dispatch.cluster_id = ?
           AND dispatch.agent_id = ?
           AND dispatch.operation_id = ?
           AND dispatch.phase = 'PREPARED'
           AND dispatch.generation = ?
           AND maintenance.generation = ?
           AND maintenance.state = 'OPEN'`,
        [id, clusterId, agentId, operationId,
         expectedGeneration.toString(), expectedGeneration.toString()],
      );
    } catch {
      throw new ServiceUnavailableException('Mutation dispatch evidence unavailable before send');
    }
    if (result.affectedRows !== 1) {
      throw new ServiceUnavailableException('Mutation dispatch generation or maintenance state changed');
    }
  }

  async transition(id: string, from: DispatchPhase, to: DispatchPhase, connection?: PoolConnection): Promise<void> {
    const allowed: Record<DispatchPhase, DispatchPhase[]> = {
      PREPARED: ['SENDING', 'REJECTED'],
      SENDING: ['ACKNOWLEDGED', 'REJECTED', 'UNCERTAIN'],
      ACKNOWLEDGED: [], REJECTED: [], UNCERTAIN: [],
    };
    if (!allowed[from].includes(to)) throw new Error('Invalid dispatch evidence transition');
    const executor = connection ?? this.db;
    const [result] = await executor.query<ResultSetHeader>(
      'UPDATE maintenance_dispatches SET phase = ? WHERE id = ? AND phase = ?',
      [to, id, from],
    );
    if (result.affectedRows !== 1) {
      throw new ServiceUnavailableException('Dispatch evidence state changed or unavailable');
    }
  }
}
