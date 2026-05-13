import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@neura/shared/env';

const apiEnvSchema = baseEnvSchema.extend({
  API_PORT: z.coerce.number().int().default(7301),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  TRUSTED_ORIGINS: z.string().transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean)),
  ENCRYPTION_KEY: z.string().length(64, 'ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),
  RESEND_API_KEY: z.string().startsWith('re_'),
  RESEND_FROM: z.string().email(),
  RESEND_FROM_NAME: z.string().default('Neura AI'),
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().default(5),
  RATE_LIMIT_LOGIN_WINDOW_SEC: z.coerce.number().default(60),
});

export const env = loadEnv(apiEnvSchema);
export type Env = typeof env;
