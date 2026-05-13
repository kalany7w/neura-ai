import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@neura/shared/env';

const workerEnvSchema = baseEnvSchema.extend({
  WAWORKER_PORT: z.coerce.number().int().default(7303),
  ENCRYPTION_KEY: z.string().length(64, 'ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),
});

export const env = loadEnv(workerEnvSchema);
export type Env = typeof env;
