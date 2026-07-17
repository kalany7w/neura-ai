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

### 4. Sentry (error tracking) — LIGADO, ativa com DSN
- **api + waworker** (`@sentry/node`): init em `apps/{api,waworker}/src/instrument.ts` (primeiro import do entrypoint). Captura unhandledRejection/uncaughtException com stack trace automaticamente. `sendAlert` também faz `captureMessage` pros eventos de negócio (queda de sessão etc.).
- **web** (`@sentry/nextjs`): `sentry.server.config.ts`, `sentry.edge.config.ts`, `src/instrumentation.ts` (+ `onRequestError`), `src/instrumentation-client.ts`; `next.config.mjs` envolvido com `withSentryConfig`.
- **Tudo no-op sem DSN.** Pra ativar:
  - `SENTRY_DSN` (api/waworker/web server) — já no compose e `.env.example`.
  - `NEXT_PUBLIC_SENTRY_DSN` (browser) — **precisa estar no BUILD do web** (build arg no Docker), não só no runtime. Hoje o compose não passa como build arg; adicionar `ARG NEXT_PUBLIC_SENTRY_DSN` no `Dockerfile` (target web) + `build.args` no compose pra o client-side capturar.
  - Source maps (opcional): `SENTRY_ORG` + `SENTRY_PROJECT` + `SENTRY_AUTH_TOKEN` no build do web.
- Verificado: `next build` do web passa com o wrap do Sentry (sem DSN = passthrough).

## Ainda pendente (backlog de observabilidade)
- Métricas Prometheus (`/metrics`) com `prom-client`: conexões WS ativas, eventos/s, latência p50/p95, erros 5xx.
- Uptime externo (Betterstack/UptimeRobot) batendo em `api.neura-ai.net/health`.
- Stress test do real-time (script: N msgs em T segundos → todas aparecem <2s).
