import { z } from 'zod';

export const OperationIdSchema = z.string().uuid();

export const ScaleServiceRequestSchema = z.object({
  operationId: OperationIdSchema,
  expectedVersion: z.number().int().nonnegative(),
  replicas: z.number().int().min(0).max(1000),
});

export const RestartServiceRequestSchema = z.object({
  operationId: OperationIdSchema,
  expectedVersion: z.number().int().nonnegative(),
});

export type ScaleServiceRequest = z.infer<typeof ScaleServiceRequestSchema>;
export type RestartServiceRequest = z.infer<typeof RestartServiceRequestSchema>;
