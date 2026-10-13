import type { AgentClient } from '../agent/agent-client.js';
import type { ClusterBindingPolicy } from './cluster-binding.policy.js';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { RowDataPacket } from 'mysql2/promise';
import type { Database } from '../db/database.js';

// Protect every current and future Agent method, except the liveness check.
// Only the registration service gets the raw HttpAgentClient for initial binding.
const MUTATIONS = new Set(['scaleService', 'restartService', 'updateServiceImage', 'rollbackService', 'drainNode', 'activateNode', 'updateNodeLabels']);
interface MaintenanceRow extends RowDataPacket { state: string; generation: string }
export function registeredAgentClient(raw: AgentClient, policy: ClusterBindingPolicy, db?: Database): AgentClient {
  return new Proxy(raw, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property === 'health') return value.bind(target);
      return async (...args: unknown[]) => {
        await policy.assertRegistered();
        // This is a final best-effort DB admission, not atomic Docker fencing.
        // Observation/reconciliation methods remain available in maintenance.
        if (MUTATIONS.has(String(property)) && process.env.DOCKLANE_MAINTENANCE_ENFORCE === '1') {
          if (!db) throw new ServiceUnavailableException('Maintenance database unavailable');
          const sql = 'SELECT state, CAST(generation AS CHAR) AS generation FROM cluster_maintenance_states WHERE cluster_id = ? LIMIT 1';
          let rows: MaintenanceRow[];
          try {
            const connection = policy.activeLockConnection();
            [rows] = connection
              ? await connection.query<MaintenanceRow[]>(sql, [policy.clusterId])
              : await db.query<MaintenanceRow[]>(sql, [policy.clusterId]);
          } catch {
            throw new ServiceUnavailableException('Maintenance dispatch state unavailable');
          }
          const row = rows[0];
          if (!row || row.state !== 'OPEN' || !/^\\d+$/.test(row.generation) || BigInt(row.generation) < 1n) {
            throw new ConflictException('Maintenance prevents new Docker dispatch');
          }
        }
        return value.apply(target, args);
      };
    },
  });
}
