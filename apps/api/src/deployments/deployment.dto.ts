import { z } from 'zod';

export const DeployRequestSchema = z.object({
  operationId: z.string().trim().min(1).max(64),
  releaseId: z.string().trim().min(1).max(64),
  health: z.object({
    url: z
      .string()
      .url()
      .refine((value) => {
        const protocol = new URL(value).protocol;
        return protocol === 'http:' || protocol === 'https:';
      }, 'health URL must use HTTP or HTTPS'),
    intervalMs: z.number().int().min(100).max(10_000).default(500),
    timeoutMs: z.number().int().min(100).max(10_000).default(2_000),
    retries: z.number().int().min(0).max(20).default(3),
    stabilityWindowMs: z.number().int().min(500).max(30_000).default(3_000),
    expectedStatus: z.number().int().min(100).max(599).default(200),
  }),
});

export type DeployRequest = z.infer<typeof DeployRequestSchema>;


export const RollbackRequestSchema = z.object({
  operationId: z.string().trim().min(1).max(64),
});

export type RollbackRequest = z.infer<typeof RollbackRequestSchema>;
