import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@neura/shared/env';

// Coolify exposes declared compose envs as "" when unset — treat empty as absent
// pra que `.optional()` funcione corretamente em vars opcionais.
const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

const apiEnvSchema = baseEnvSchema.extend({
  API_PORT: z.coerce.number().int().default(7301),
  // Webhook opcional (Discord/Slack) pra alertas operacionais (erros não tratados).
  ALERT_WEBHOOK_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  TRUSTED_ORIGINS: z.string().transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean)),
  ENCRYPTION_KEY: z.string().length(64, 'ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),
  RESEND_API_KEY: z.string().startsWith('re_'),
  RESEND_FROM: z.string().email(),
  RESEND_FROM_NAME: z.string().default('Neura AI'),
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().default(5),
  RATE_LIMIT_LOGIN_WINDOW_SEC: z.coerce.number().default(60),
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.coerce.number().int().default(9000),
  MINIO_ACCESS_KEY: z.string().default('minioadmin'),
  MINIO_SECRET_KEY: z.string().default('minioadmin'),
  MINIO_BUCKET: z.string().default('neura-media'),
  MINIO_USE_SSL: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // Whisper transcription (opcional — se vazio, transcrição é desligada)
  OPENAI_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  WHISPER_MODEL: z.string().default('whisper-1'),
  WHISPER_API_BASE: z.string().url().default('https://api.openai.com/v1'),
  // Sugestões de resposta com IA (mesma chave do Whisper). Default: gpt-4o-mini
  // (~$0.15/1M tokens input — sugestão típica custa <$0.0005 por chamada).
  OPENAI_CHAT_MODEL: z.string().default('gpt-4o-mini'),
  // URL pública da API pra Telegram registrar webhook (ex: https://api.neura-ai.net)
  // Obrigatório quando se conecta inbox Telegram.
  PUBLIC_API_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  // URL do app (web), usada como fallback se PUBLIC_API_URL não setada.
  APP_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
});

export const env = loadEnv(apiEnvSchema);
export type Env = typeof env;
