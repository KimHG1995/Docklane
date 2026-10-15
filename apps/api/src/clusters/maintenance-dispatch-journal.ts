import { randomUUID } from 'node:crypto';
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';
import { Database } from '../db/database.js';
import { MaintenancePreDispatchRejection } from '../agent/agent-client.js';

/**
 * Another CP already persisted this operation lineage. The previous request
 * might have reached Docker; never classify a duplicate as unsent.
 */
export class DuplicateDispatchEvidence extends Error {
  constructor() { super('Existing mutation dispatch evidence requires reconciliation'); }
}
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
    } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ER_DUP_ENTRY') {
        throw new DuplicateDispatchEvidence();
      }
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

  /**
   * Execute a mutation with durable state recorded before transport.
   * The caller must supply the actual selected manager ID and durable operation
   * ID, and guarantee that the supplied connection has no open transaction.
   *
   * ACKNOWLEDGED means the Agent returned a successful response; it does not
   * mean Docker tasks converged. Unknown errors remain UNCERTAIN. If writing
   * the final phase fails, the durable SENDING record remains unresolved.
   */
  async execute<T>(
    clusterId: string,
    generation: bigint,
    agentId: string,
    operationId: string,
    send: () => Promise<T>,
    isDefinitePreUpdateRejection: (error: unknown) => boolean,
    connection?: PoolConnection,
  ): Promise<T> {
    // No Agent transport is invoked until both statements have returned.
    // Pre-send DB failures are deterministic to the caller, even if an INSERT
    // or UPDATE committed but its DB acknowledgement was lost. Such stale
    // records remain conservatively unresolved and block CLOSED.
    let id: string | null = null;
    try {
      id = await this.prepare(clusterId, generation, agentId, operationId, connection);
      await this.beginSend(id, clusterId, generation, agentId, operationId, connection);
    } catch (error) {
      // A duplicate means a previous Control Plane may already have sent this
      // operation. Never retry transport or report deterministic non-send.
      if (error instanceof DuplicateDispatchEvidence) throw error;
      if (id !== null) {
        try {
          await this.transition(id, 'PREPARED', 'REJECTED', connection);
        } catch {
          // DB failure or a committed SENDING state: retain unresolved evidence.
        }
      }
      throw new MaintenancePreDispatchRejection('MAINTENANCE_UNAVAILABLE');
    }

    // Never combine transport exceptions with the journal acknowledgement
    // update: a failed ACKNOWLEDGED write is not an Agent rejection.
    let response: T;
    try {
      response = await send();
    } catch (error) {
      // Only the established exact pre-update Agent rejection contract permits
      // REJECTED; response loss and generic 409/503 remain UNCERTAIN.
      const next = isDefinitePreUpdateRejection(error) ? 'REJECTED' : 'UNCERTAIN';
      try {
        await this.transition(id, 'SENDING', next, connection);
      } catch {
        // Keep SENDING unresolved; never replay HTTP to repair the journal.
      }
      throw error;
    }

    // If persisting this successful Agent response fails, let the error reach
    // reconciliation. Never replay an already accepted Docker mutation.
    await this.transition(id, 'SENDING', 'ACKNOWLEDGED', connection);
    return response;
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
