import { z } from 'zod';
import { isBoundedIdentifier, isDisplayName } from './cluster-registration.types.js';

export const RegisterClusterRequestSchema = z.object({
  swarmClusterId: z.string().refine(isBoundedIdentifier),
  displayName: z.string().refine(isDisplayName),
}).strict();
