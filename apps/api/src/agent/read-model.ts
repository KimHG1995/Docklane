import { z } from 'zod';

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  component: z.literal('docklane-agent'),
});

export const ManagerQuorumSchema = z.object({
  total: z.number().int().nonnegative(),
  reachable: z.number().int().nonnegative(),
  required: z.number().int().nonnegative(),
  available: z.boolean(),
  leaderCount: z.number().int().nonnegative(),
});

export const NodeSummarySchema = z.object({
  id: z.string(),
  version: z.number().int().nonnegative(),
  specHash: z.string().min(1),
  hostname: z.string(),
  address: z.string(),
  role: z.string(),
  availability: z.string(),
  state: z.string(),
  message: z.string().optional(),
  manager: z.boolean(),
  leader: z.boolean(),
  reachability: z.string().optional(),
  engineVersion: z.string().optional(),
  nanoCpus: z.number().int(),
  memoryBytes: z.number().int(),
  labels: z.record(z.string(), z.string()),
});

export const ClusterResponseSchema = z.object({
  cluster: z.object({
    id: z.string(),
    dockerVersion: z.string(),
    apiVersion: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    managers: ManagerQuorumSchema,
  }),
  nodes: z.array(NodeSummarySchema),
});

export const ServiceSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().int().nonnegative(),
  specHash: z.string().min(1),
  forceUpdate: z.number().int().nonnegative(),
  image: z.string().optional(),
  mode: z.string(),
  desiredReplicas: z.number().int().nonnegative(),
  runningReplicas: z.number().int().nonnegative(),
  updateState: z.string().optional(),
  updateMessage: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const TaskSummarySchema = z.object({
  id: z.string(),
  serviceId: z.string(),
  slot: z.number().int(),
  nodeId: z.string().optional(),
  desiredState: z.string(),
  state: z.string(),
  forceUpdate: z.number().int().nonnegative(),
  message: z.string().optional(),
  error: z.string().optional(),
  containerId: z.string().optional(),
  image: z.string().optional(),
  timestamp: z.string(),
});

export const ServiceDetailResponseSchema = z.object({
  service: ServiceSummarySchema,
  tasks: z.array(TaskSummarySchema),
});

export const ServiceMutationPlanSchema = z.object({
  serviceId: z.string(),
  version: z.number().int().nonnegative(),
  beforeSpecHash: z.string().min(1),
  targetSpecHash: z.string().min(1),
  targetForceUpdate: z.number().int().nonnegative(),
  targetReplicas: z.number().int().nonnegative().optional(),
});

export const ServiceMutationResponseSchema = z.object({
  serviceId: z.string(),
  version: z.number().int().nonnegative(),
  targetSpecHash: z.string().min(1),
  targetForceUpdate: z.number().int().nonnegative(),
  warnings: z.array(z.string()).optional(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type ClusterResponse = z.infer<typeof ClusterResponseSchema>;
export type ServiceSummary = z.infer<typeof ServiceSummarySchema>;
export type TaskSummary = z.infer<typeof TaskSummarySchema>;
export type ServiceDetailResponse = z.infer<typeof ServiceDetailResponseSchema>;
export type ServiceMutationPlan = z.infer<typeof ServiceMutationPlanSchema>;
export type ServiceMutationResponse = z.infer<typeof ServiceMutationResponseSchema>;


export const NodeDetailResponseSchema = z.object({
  node: NodeSummarySchema,
  tasks: z.array(TaskSummarySchema),
  serviceIds: z.array(z.string()),
});

export const NodeMutationPlanSchema = z.object({
  nodeId: z.string(),
  version: z.number().int().nonnegative(),
  beforeSpecHash: z.string().min(1),
  targetSpecHash: z.string().min(1),
  targetAvailability: z.enum(['drain', 'active', 'pause']),
  affectedServiceIds: z.array(z.string()),
  targetLabels: z.record(z.string(), z.string()).optional(),
});

export const NodeMutationResponseSchema = z.object({
  nodeId: z.string(),
  version: z.number().int().nonnegative(),
  targetSpecHash: z.string().min(1),
  targetAvailability: z.enum(['drain', 'active']),
});

export type NodeSummary = z.infer<typeof NodeSummarySchema>;
export type NodeDetailResponse = z.infer<typeof NodeDetailResponseSchema>;
export type NodeMutationPlan = z.infer<typeof NodeMutationPlanSchema>;
export type NodeMutationResponse = z.infer<typeof NodeMutationResponseSchema>;
