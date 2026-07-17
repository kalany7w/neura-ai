import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@neura/shared/env';

const workerEnvSchema = baseEnvSchema.extend({
  WAWORKER_PORT: z.coerce.number().int().default(7303),
  // Webhook opcional (Discord/Slack) pra alertas operacionais: queda de sessão,
  // erros não tratados. Sem isso, os alertas só vão pro log (Pino).
  // preprocess: Coolify passa "" quando a var não está setada → trata como ausente.
  ALERT_WEBHOOK_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
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
