import { z } from 'zod';

export const PlacementViolationSchema = z.object({
  taskId: z.string(),
  nodeId: z.string(),
  reason: z.string(),
});

export const ServicePlacementResponseSchema = z.object({
  serviceId: z.string(),
  status: z.enum(['CONVERGED', 'PENDING', 'UNKNOWN']),
  desiredReplicas: z.number().int().nonnegative(),
  runningReplicas: z.number().int().nonnegative(),
  reasons: z.array(z.string()),
  unsupportedConstraints: z.array(z.string()),
  violations: z.array(PlacementViolationSchema),
});

export type ServicePlacementResponse = z.infer<
  typeof ServicePlacementResponseSchema
>;
