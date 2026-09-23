import { z } from 'zod';

export const CapacityCheckRequestSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  targetReplicas: z.number().int().nonnegative(),
  includeUpdateOverlap: z.boolean().default(false),
});

export const CapacityResourceSchema = z.object({
  nanoCpus: z.number().int().nonnegative(),
  memoryBytes: z.number().int().nonnegative(),
});

export const CapacityNodeSchema = z.object({
  nodeId: z.string(),
  hostname: z.string(),
  availableNanoCpus: z.number().int().nonnegative(),
  availableMemoryBytes: z.number().int().nonnegative(),
  existingServiceTasks: z.number().int().nonnegative(),
  maxAdditionalReplicas: z.number().int().nonnegative(),
});

export const CapacityCheckResponseSchema = z.object({
  serviceId: z.string(),
  status: z.enum(['SUFFICIENT', 'INSUFFICIENT', 'UNKNOWN']),
  currentReplicas: z.number().int().nonnegative(),
  targetReplicas: z.number().int().nonnegative(),
  updateOverlapReplicas: z.number().int().nonnegative(),
  requiredAdditionalReplicas: z.number().int().nonnegative(),
  schedulableAdditionalReplicas: z.number().int().nonnegative(),
  unplacedReplicas: z.number().int().nonnegative(),
  eligibleNodeCount: z.number().int().nonnegative(),
  reservation: CapacityResourceSchema,
  reasons: z.array(z.string()),
  unsupportedConstraints: z.array(z.string()),
  nodes: z.array(CapacityNodeSchema),
});

export type CapacityCheckRequest = z.infer<
  typeof CapacityCheckRequestSchema
>;
export type CapacityCheckResponse = z.infer<
  typeof CapacityCheckResponseSchema
>;
