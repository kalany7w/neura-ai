// Garante envs mínimas pra testes que carregam módulos com Zod env validation.
// Em CI estas envs já vêm do workflow; em local rodar com `pnpm test` + .env presente.
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/neura_ai_test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.BETTER_AUTH_SECRET ??= '0'.repeat(64);
process.env.BETTER_AUTH_URL ??= 'http://localhost:7301';
process.env.TRUSTED_ORIGINS ??= 'http://localhost:7302';
process.env.ENCRYPTION_KEY ??= '0'.repeat(64);
process.env.RESEND_API_KEY ??= 're_test_fake_key';
process.env.RESEND_FROM ??= 'noreply@neura-ai.net';
process.env.RESEND_FROM_NAME ??= 'Neura AI Test';
