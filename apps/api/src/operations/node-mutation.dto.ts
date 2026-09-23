import { z } from 'zod';
import { OperationIdSchema } from './mutation.dto.js';

export const NodeMutationRequestSchema = z.object({
  operationId: OperationIdSchema,
  expectedVersion: z.number().int().nonnegative(),
});

export type NodeMutationRequest = z.infer<typeof NodeMutationRequestSchema>;


const LabelKeySchema = z.string().min(1).max(128);
const LabelValueSchema = z.string().max(4096);

export const NodeLabelsRequestSchema = z
  .object({
    operationId: OperationIdSchema,
    expectedVersion: z.number().int().nonnegative(),
    set: z.record(LabelKeySchema, LabelValueSchema).default({}),
    remove: z.array(LabelKeySchema).max(100).default([]),
  })
  .superRefine((value, ctx) => {
    const setKeys = Object.keys(value.set);
    if (setKeys.length === 0 && value.remove.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'At least one label change is required',
      });
    }
    const remove = new Set(value.remove);
    for (const key of setKeys) {
      if (remove.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: `Label ${key} cannot be set and removed together`,
        });
      }
    }
  });

export type NodeLabelsRequest = z.infer<typeof NodeLabelsRequestSchema>;
