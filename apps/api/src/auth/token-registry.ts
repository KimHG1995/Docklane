import { Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Principal } from './auth.types.js';

const TokenEntrySchema = z.object({
  token: z.string().min(16),
  actorId: z.string().min(1),
  role: z.enum(['VIEWER', 'OPERATOR', 'ADMIN']),
  clusters: z.array(z.string().min(1)).min(1),
});
const TokenRegistrySchema = z.array(TokenEntrySchema);
type TokenEntry = z.infer<typeof TokenEntrySchema>;

@Injectable()
export class TokenRegistry {
  private readonly entries: TokenEntry[];

  constructor() {
    const raw = process.env.DOCKLANE_API_TOKENS ?? '[]';
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('DOCKLANE_API_TOKENS must be valid JSON');
    }
    this.entries = TokenRegistrySchema.parse(parsed);
  }

  authenticate(candidate: string): Principal | null {
    for (const entry of this.entries) {
      if (!safeEqual(candidate, entry.token)) continue;
      return { actorId: entry.actorId, role: entry.role, clusters: entry.clusters };
    }
    return null;
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
