import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@neura/shared/env';

// Coolify exposes declared compose envs as "" when unset — treat empty as absent
// pra que `.optional()` funcione corretamente em vars opcionais.
const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

const apiEnvSchema = baseEnvSchema.extend({
  API_PORT: z.coerce.number().int().default(7301),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  TRUSTED_ORIGINS: z.string().transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean)),
  ENCRYPTION_KEY: z.string().length(64, 'ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),
  // --- Mail (transacional + canal EMAIL) ---
  // Provider por auto-detect: SMTP_HOST setado → smtp; RESEND_API_KEY → resend.
  // Ambos setados → MAIL_PROVIDER decide (default resend, compat com prod).
  MAIL_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['resend', 'smtp']).optional()),
  RESEND_API_KEY: z.preprocess(emptyToUndefined, z.string().startsWith('re_').optional()),
  SMTP_HOST: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.preprocess(emptyToUndefined, z.string().optional()),
  SMTP_PASS: z.preprocess(emptyToUndefined, z.string().optional()),
  SMTP_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // From padrão dos transacionais. MAIL_FROM/MAIL_FROM_NAME têm precedência;
  // RESEND_FROM/RESEND_FROM_NAME mantidos como alias (ENV de prod já usa).
  MAIL_FROM: z.preprocess(emptyToUndefined, z.string().email().optional()),
  MAIL_FROM_NAME: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  RESEND_FROM: z.preprocess(emptyToUndefined, z.string().email().optional()),
  RESEND_FROM_NAME: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
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

const apiEnvSchemaChecked = apiEnvSchema.superRefine((v, ctx) => {
  if (!v.RESEND_API_KEY && !v.SMTP_HOST) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MAIL_PROVIDER'],
      message: 'Configure um provedor de e-mail: SMTP_HOST (SMTP genérico) ou RESEND_API_KEY (Resend)',
    });
  }
  if (!v.MAIL_FROM && !v.RESEND_FROM) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MAIL_FROM'],
      message: 'Defina MAIL_FROM (ou o alias RESEND_FROM) com o endereço remetente dos e-mails transacionais',
    });
  }
  if (v.MAIL_PROVIDER === 'smtp' && !v.SMTP_HOST) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SMTP_HOST'],
      message: 'MAIL_PROVIDER=smtp exige SMTP_HOST',
    });
  }
  if (v.MAIL_PROVIDER === 'resend' && !v.RESEND_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['RESEND_API_KEY'],
      message: 'MAIL_PROVIDER=resend exige RESEND_API_KEY',
    });
  }
});

export const env = loadEnv(apiEnvSchemaChecked);
export type Env = typeof env;
