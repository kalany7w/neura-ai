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

### 5. Métricas Prometheus — LIGADO
- `GET /metrics` na API (formato Prometheus), via `prom-client` (`apps/api/src/metrics.ts`).
- Métricas: default de processo/Node (memória, CPU, event-loop lag, GC) +
  `http_requests_total` e `http_request_duration_seconds` (histograma → p50/p95 e
  taxa de 5xx, por método/rota/status) + `ws_active_connections` (gauge) +
  `realtime_events_published_total` (por tipo de evento).
- Rota label = padrão casado (`/api/conversations/:id`) → baixa cardinalidade.
- Protegido por `METRICS_TOKEN` se setado (`Authorization: Bearer <token>`); vazio =
  aberto (assumir rede interna / restringir no proxy). Já no compose e `.env.example`.
- **Scrape config exemplo** (prometheus.yml):
  ```yaml
  scrape_configs:
    - job_name: neura-api
      metrics_path: /metrics
      authorization: { credentials: '<METRICS_TOKEN>' }
      static_configs: [{ targets: ['api:7301'] }]
  ```

### 6. Stress test do real-time — script pronto
- `apps/api/scripts/stress-realtime.mts` (`pnpm --filter @neura/api stress:realtime`).
- Loga N clientes WS, publica M eventos no Redis (canal do workspace) e mede a
  taxa de entrega + latência (publish → recebido) com p50/p95/p99. PASS/FAIL vs
  alvos (default: 100% entrega, p95 < 2s — o critério da Fase 9 do roadmap).
- REQUER stack rodando (API + Redis) e um usuário de teste com workspace:
  ```bash
  LOGIN_EMAIL=a@b.com LOGIN_PASSWORD=... \
  CLIENTS=10 MESSAGES=100 DURATION_MS=10000 \
  pnpm --filter @neura/api stress:realtime
  ```
- Vars: API_URL, WS_URL, REDIS_URL, CLIENTS, MESSAGES, DURATION_MS, WAIT_MS,
  MAX_P95_MS, MIN_DELIVERY.

### 7. Dashboard Grafana + Prometheus — pronto
- `monitoring/` (ver `monitoring/README.md`): dashboard provisionado (10 painéis
  sobre o /metrics) + Prometheus + Grafana num compose à parte.

### 8. Uptime externo — endpoints prontos, falta dar de alta o monitor
Serviço externo (Betterstack / UptimeRobot / Pingdom) batendo nos endpoints, pra
detectar queda mesmo se o processo inteiro morrer (o alerta interno não sairia).

**O que monitorar** (HTTP monitor, intervalo 1–3min, espera 200):
| URL | Verifica | 503 quando |
|-----|----------|------------|
| `https://api.neura-ai.net/health` | API + Postgres + Redis | db ou redis fora |
| `https://api.neura-ai.net/health/worker` | waworker (via heartbeat no Redis, TTL 60s) | worker morto/travado |
| `https://app.neura-ai.net/` | web (Next) | web fora |

- O **waworker não tem URL pública** → agora ele escreve um heartbeat no Redis a
  cada 15s e a API expõe `/health/worker` (503 se o heartbeat > 60s). Assim o
  worker fica observável externamente pela API.
- **Setup** (ex.: Betterstack → Monitors → Create): 3 monitores HTTP com os URLs
  acima, expected status 200, e alerta no mesmo destino do `ALERT_WEBHOOK_URL`
  (email/Discord/Slack). Opcional: keyword check no body (`"status":"ok"`).
- UptimeRobot free cobre os 3 (5min de intervalo no free).

## Ainda pendente (backlog de observabilidade)
- Dar de alta os 3 monitores no serviço escolhido (tarefa de ops, sem código).
- Alertas nativos do Grafana (5xx > 5% / p95 > 2s) → mesmo canal do webhook.
