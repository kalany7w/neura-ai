# Observabilidade — Neura AI

## O que já está ligado (sem dependência externa)

### 1. Health server do waworker
- `apps/waworker/src/index.ts` sobe um HTTP server em `WAWORKER_PORT` (7303) com `/health`.
- Responde 200 + `{ status, activeSessions, sessionIds }`. Provar que responde = event loop vivo (detecta worker "de pé mas travado").
- `docker-compose.yaml` tem healthcheck do waworker batendo nesse endpoint (via `node fetch`, sem depender de wget). Coolify reinicia o container se ficar unhealthy.

### 2. Alertas operacionais (webhook Discord/Slack, opcional)
- `ALERT_WEBHOOK_URL` (env, opcional). Sem ela, tudo cai só no log (Pino).
- Helper: `apps/waworker/src/alert.ts` e `apps/api/src/services/alert.ts` — `sendAlert(level, title, detail)`. Payload dual `{ content, text }` funciona em Discord E Slack.
- **Disparos hoje:**
  - Sessão Baileys caiu e esgotou os retries de reconexão (`manager.ts`).
  - Sessão Baileys falhou ao iniciar (retries esgotados).
  - Inbox WhatsApp deslogado (precisa novo QR).
  - `unhandledRejection` / `uncaughtException` na API e no waworker.

### 3. Handlers globais de erro
- API e waworker capturam `unhandledRejection` (loga+alerta) e `uncaughtException` (alerta e encerra pro container reiniciar limpo).

## Próximo passo: Sentry (requer instalar deps no seu ambiente)

Não foi ligado aqui porque adiciona dependências (`@sentry/*`) que não dá pra instalar de forma limpa no clone. Passos pra ativar:

**API + waworker (`@sentry/node`):**
```bash
pnpm --filter @neura/api add @sentry/node
pnpm --filter @neura/waworker add @sentry/node
```
No topo de cada entrypoint (`apps/api/src/index.ts`, `apps/waworker/src/index.ts`), ANTES de tudo:
```ts
import * as Sentry from '@sentry/node';
if (env.SENTRY_DSN) Sentry.init({ dsn: env.SENTRY_DSN, tracesSampleRate: 0.1, environment: env.NODE_ENV });
```
E em `sendAlert`, adicionar `Sentry.captureException`/`captureMessage` quando `level !== 'warn'`.

**Web (`@sentry/nextjs`):**
```bash
pnpm --filter @neura/web add @sentry/nextjs
npx @sentry/wizard@latest -i nextjs   # gera sentry.client/server/edge.config.ts + instrumentation
```

Adicionar `SENTRY_DSN` (e `NEXT_PUBLIC_SENTRY_DSN` no web) ao env schema, ao `docker-compose.yaml` e ao `.env.example`.

## Ainda pendente (backlog de observabilidade)
- Métricas Prometheus (`/metrics`) com `prom-client`: conexões WS ativas, eventos/s, latência p50/p95, erros 5xx.
- Uptime externo (Betterstack/UptimeRobot) batendo em `api.neura-ai.net/health`.
- Stress test do real-time (script: N msgs em T segundos → todas aparecem <2s).
