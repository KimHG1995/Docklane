import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { RowDataPacket } from 'mysql2/promise';
import { HttpAgentClient } from '../agent/http-agent.client.js';
import { MANAGER_AGENT_CONFIG, type ManagerAgentConfig } from '../agent/agent-config.js';
import { Database } from '../db/database.js';
import { ClusterMaintenanceRepository } from './cluster-maintenance.repository.js';

/**
 * Collects barrier acknowledgements from the complete live Swarm manager roster.
 * A missing, duplicated, mismatched or unavailable manager blocks completion.
 * This is evidence collection, NOT permission to enter CLOSED by itself.
 */
@Injectable()
export class MaintenanceManagerBarrier {
  constructor(
    @Inject(HttpAgentClient) private readonly agent: HttpAgentClient,
    @Inject(ClusterMaintenanceRepository) private readonly maintenance: ClusterMaintenanceRepository,
    @Inject(Database) private readonly db: Database,
    @Inject(MANAGER_AGENT_CONFIG) private readonly config: ManagerAgentConfig,
  ) {}

  async blockAll(clusterId: string, swarmClusterId: string, generation: bigint) {
    const state = await this.maintenance.requireRecord(clusterId);
    if (state.state !== 'CLOSING' || state.generation !== generation ||
        this.config.expectedClusterId !== swarmClusterId) {
      throw new ConflictException('Maintenance generation or registered Swarm mismatch');
    }
    const targets = await this.agent.inspectConfiguredManagers(swarmClusterId);
    if (targets.length !== this.config.agents.length) {
      throw new ConflictException('Incomplete manager membership');
    }
    const acknowledgements: string[] = [];
    for (const target of targets) {
      await this.agent.blockConfiguredManager(target.agentId, target.nodeId, swarmClusterId, generation);
      // Do not claim an ACK if a failed DB write left it uncommitted.
      await this.db.query(
        `INSERT INTO maintenance_agent_barriers (cluster_id, agent_id, generation, state)
         VALUES (?, ?, ?, 'ACKNOWLEDGED')
         ON DUPLICATE KEY UPDATE generation = VALUES(generation), state = 'ACKNOWLEDGED'`,
        [clusterId, target.agentId, generation.toString()],
      );
      acknowledgements.push(target.agentId);
    }
    // Recheck membership and generation: any changed manager fails closed.
    const fresh = await this.agent.inspectConfiguredManagers(swarmClusterId);
    if (JSON.stringify(fresh) !== JSON.stringify(targets)) {
      throw new ConflictException('Manager membership changed during barrier');
    }
    const latest = await this.maintenance.requireRecord(clusterId);
    if (latest.state !== 'CLOSING' || latest.generation !== generation) {
      throw new ConflictException('Maintenance generation changed during barrier');
    }
    const [rows] = await this.db.query<(RowDataPacket & { agent_id: string; generation: string; state: string })[]>(
      `SELECT agent_id, CAST(generation AS CHAR) AS generation, state
       FROM maintenance_agent_barriers WHERE cluster_id = ? ORDER BY agent_id`,
      [clusterId],
    );
    const expectedIds = targets.map(t => t.agentId).sort();
    if (rows.length !== expectedIds.length ||
        rows.some((row, i) => row.agent_id !== expectedIds[i] ||
          row.generation !== generation.toString() || row.state !== 'ACKNOWLEDGED')) {
      throw new ConflictException('Missing or stale manager barrier acknowledgement');
    }
    return { clusterId, generation: generation.toString(), blockedManagerIds: expectedIds };
  }
}
