import { randomUUID } from 'node:crypto';
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { ResultSetHeader } from 'mysql2/promise';
import { Database } from '../db/database.js';

export type DispatchPhase = 'PREPARED' | 'SENDING' | 'ACKNOWLEDGED' | 'REJECTED' | 'UNCERTAIN';

/**
 * Durable record for HTTP mutation send uncertainty.
 *
 * A persisted SENDING row is intentionally left unresolved after a CP crash.
 * Callers MUST NOT mark ACKNOWLEDGED after a timeout, a lost response, or a
 * later read showing unchanged Docker state.
 *
 * This writer uses its own DB transaction boundary and is not tied to the
 * resource-lock connection. In a 10/10 occupied connection pool this can wait:
 * admission is not considered safe to enable until an integration test proves
 * bounded checkout capacity and the final send fence.
 */
@Injectable()
export class MaintenanceDispatchJournal {
  constructor(@Inject(Database) private readonly db: Database) {}

  async prepare(clusterId: string, generation: bigint, agentId: string, operationId: string): Promise<string> {
    const id = randomUUID();
    try {
      await this.db.query<ResultSetHeader>(
        `INSERT INTO maintenance_dispatches (id, cluster_id, generation, agent_id, operation_id, phase)
         VALUES (?, ?, ?, ?, ?, 'PREPARED')`,
        [id, clusterId, generation.toString(), agentId, operationId],
      );
    } catch {
      throw new ServiceUnavailableException('Mutation dispatch journal unavailable before send');
    }
    return id;
  }

  async transition(id: string, from: DispatchPhase, to: DispatchPhase): Promise<void> {
    const allowed: Record<DispatchPhase, DispatchPhase[]> = {
      PREPARED: ['SENDING', 'REJECTED'],
      SENDING: ['ACKNOWLEDGED', 'REJECTED', 'UNCERTAIN'],
      ACKNOWLEDGED: [], REJECTED: [], UNCERTAIN: [],
    };
    if (!allowed[from].includes(to)) throw new Error('Invalid dispatch evidence transition');
    const [result] = await this.db.query<ResultSetHeader>(
      'UPDATE maintenance_dispatches SET phase = ? WHERE id = ? AND phase = ?',
      [to, id, from],
    );
    if (result.affectedRows !== 1) {
      throw new ServiceUnavailableException('Dispatch evidence state changed or unavailable');
    }
  }
}
