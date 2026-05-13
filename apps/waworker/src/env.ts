import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@neura/shared/env';

const workerEnvSchema = baseEnvSchema.extend({
  WAWORKER_PORT: z.coerce.number().int().default(7303),
  ENCRYPTION_KEY: z.string().length(64, 'ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.coerce.number().int().default(9000),
  MINIO_ACCESS_KEY: z.string().default('minioadmin'),
  MINIO_SECRET_KEY: z.string().default('minioadmin'),
  MINIO_BUCKET: z.string().default('neura-media'),
  MINIO_USE_SSL: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
});

export const env = loadEnv(workerEnvSchema);
export type Env = typeof env;
