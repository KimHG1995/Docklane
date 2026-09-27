import { z } from 'zod';

const NameSchema = z.string().trim().min(1).max(255);
const IdentifierSchema = z.string().trim().min(1).max(255);
const DigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/i, 'imageDigest must be a sha256 digest');

export const CreateApplicationRequestSchema = z.object({
  name: NameSchema,
  description: z.string().trim().max(2000).nullable().optional(),
});

export const CreateDeploymentTargetRequestSchema = z.object({
  environment: IdentifierSchema,
  dockerServiceId: IdentifierSchema,
  serviceName: NameSchema,
  routingMode: z.literal('INGRESS').default('INGRESS'),
});

export const CreateReleaseRequestSchema = z
  .object({
    version: IdentifierSchema,
    imageRepository: z.string().trim().min(1).max(512),
    imageTag: z.string().trim().min(1).max(255).nullable().optional(),
    imageDigest: DigestSchema.nullable().optional(),
    gitCommit: z.string().trim().min(1).max(128).nullable().optional(),
    buildNumber: z.string().trim().min(1).max(128).nullable().optional(),
  })
  .refine(
    (value) => Boolean(value.imageTag || value.imageDigest),
    'Either imageTag or imageDigest is required',
  );

export type CreateApplicationRequest = z.infer<
  typeof CreateApplicationRequestSchema
>;
export type CreateDeploymentTargetRequest = z.infer<
  typeof CreateDeploymentTargetRequestSchema
>;
export type CreateReleaseRequest = z.infer<typeof CreateReleaseRequestSchema>;

export type ResolvedReleaseRequest = Omit<
  CreateReleaseRequest,
  'imageDigest'
> & {
  imageDigest: string;
};
