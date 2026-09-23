import { z } from 'zod';
import { OperationIdSchema } from './mutation.dto.js';

export const NodeMutationRequestSchema = z.object({
  operationId: OperationIdSchema,
  expectedVersion: z.number().int().nonnegative(),
});

export type NodeMutationRequest = z.infer<typeof NodeMutationRequestSchema>;
