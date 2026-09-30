import { z } from 'zod';

export const CreateBootstrapTokenRequestSchema = z.object({
  nodeRole: z.enum(['manager', 'worker']),
  labels: z.record(z.string(), z.string().max(256)).default({}),
  ttlSeconds: z.number().int().min(30).max(3600).default(600),
}).strict();

export const BootstrapClaimRequestSchema = z.object({
  token: z.string().min(32).max(256),
  claimId: z.uuid(),
}).strict();

export type CreateBootstrapTokenRequest = z.infer<
  typeof CreateBootstrapTokenRequestSchema
>;
export type BootstrapClaimRequest = z.infer<
  typeof BootstrapClaimRequestSchema
>;
