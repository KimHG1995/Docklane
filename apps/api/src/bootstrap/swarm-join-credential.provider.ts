import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { BootstrapNodeRole } from './bootstrap.types.js';

const SwarmJoinEntrySchema = z.object({
  clusterId: z.string().min(1),
  remoteAddr: z.string().min(3),
  managerToken: z.string().min(20),
  workerToken: z.string().min(20),
}).strict();

const SwarmJoinRegistrySchema = z.array(SwarmJoinEntrySchema);
type SwarmJoinEntry = z.infer<typeof SwarmJoinEntrySchema>;

export interface SwarmJoinCredential {
  remoteAddr: string;
  joinToken: string;
}

@Injectable()
export class SwarmJoinCredentialProvider {
  private readonly entries: Map<string, SwarmJoinEntry>;

  constructor() {
    const raw = process.env.DOCKLANE_SWARM_JOIN_JSON ?? '[]';
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('DOCKLANE_SWARM_JOIN_JSON must be valid JSON');
    }

    const entries = SwarmJoinRegistrySchema.parse(parsed);
    this.entries = new Map();
    for (const entry of entries) {
      if (this.entries.has(entry.clusterId)) {
        throw new Error(
          `DOCKLANE_SWARM_JOIN_JSON contains duplicate clusterId ${entry.clusterId}`,
        );
      }
      this.entries.set(entry.clusterId, entry);
    }
  }

  credentials(
    clusterId: string,
    role: BootstrapNodeRole,
  ): SwarmJoinCredential | null {
    const entry = this.entries.get(clusterId);
    if (!entry) return null;

    return {
      remoteAddr: entry.remoteAddr,
      joinToken:
        role === 'manager' ? entry.managerToken : entry.workerToken,
    };
  }
}
