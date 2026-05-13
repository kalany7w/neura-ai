# Neura AI

Plataforma de atendimento WhatsApp multi-tenant, construída do zero. Brand próprio, comercializável. Substitui o uso atual de Chatwoot + kanban da fazer.ai com features melhores (busca textual, filtros por etiqueta clicáveis, SLA visual escalonado, preview da última mensagem, real-time end-to-end).

## Core Value

Atendentes operam conversas WhatsApp dentro de um kanban interativo com tempo real obrigatório, SLA visual e filtros poderosos. Zero dependência de terceiros pagos (Chatwoot, fazer.ai, Twilio).

## Constraints

- **Timeline**: MVP em ~10 semanas (48 dias úteis) — ver `.planning/ROADMAP.md`
- **Tempo real OBRIGATÓRIO**: toda UI atualiza sozinha, sem refresh manual. Mensagens chegam, cards movem, SLA recalcula — tudo via WebSocket em todos browsers abertos. Real-time é implementado incrementalmente em cada fase (Fase 9 é hardening, não implementação inicial).
- **Multi-tenant desde o MVP**: accounts isoladas (`account_id` em toda tabela), middleware Prisma extension força isolamento
- **Permissões granulares** (`admin` / `supervisor` / `agent`) aplicadas em cada CRUD desde a Fase 1
- **Audit log** em ações sensíveis: criar/deletar/atribuir card, mudar role, deletar conta, exportar dados, conectar/desconectar inbox
- **Segurança**: HMAC webhooks, JWT WS, AES-256 nos secrets, audit log, rate limit (login + API), CSP
- **Testes distribuídos**: cada fase entrega testes (unit/integration/E2E), sem fase "adicionar testes" no fim
- **Infra**: VPS + Coolify
- **Self-hosted only no path crítico**: Baileys self-hosted, MinIO em vez de S3. Resend é exceção justificada (email transacional só pra auth/convite, baixo risco e free tier cobre)

## Domínios

- App agentes: `https://app.neura-ai.net`
- API + WebSocket: `https://api.neura-ai.net`
- Landing pública: `https://neura-ai.net` (fase futura)

## Stack

### apps/api — Hono + Prisma + Postgres + Better Auth
- Hono 4.x (HTTP + WebSocket nativo)
- Prisma 5.x ORM (extension global pra `account_id` isolation)
- Postgres 16 (com pgvector se for usar embeddings depois)
- Better Auth (multi-tenant, sessions cookie httpOnly, plugin organization)
- **Resend** (email transacional: signup, convite agente, reset password)
- Pino logger estruturado
- rate-limiter-flexible + Redis
- BullMQ (filas: envio msg WhatsApp, geração thumbnail, reconciliador real-time)
- Audit log helper: `audit(actor, action, resource, payload)`

### apps/web — Next.js 15 + shadcn/ui + dnd-kit
- App Router
- shadcn/ui (componentes)
- Zustand (estado real-time vindo do WS)
- @dnd-kit/core (drag-drop kanban)
- @tanstack/react-query (cache, mutações otimistas)
- next-intl (PT-BR padrão, EN depois)

### apps/waworker — Node + Baileys
- @whiskeysockets/baileys (multi-sessão)
- Auth state criptografado AES-256 em Postgres (não em arquivo plano)
- Worker isolado, comunica com api via Redis pub/sub
- Reconexão automática + circuit breaker

### Infra
- Redis 7 (pub/sub real-time + fila BullMQ + cache + rate limit)
- MinIO (mídia S3-compatible self-hosted)
- Caddy via Coolify (HTTPS automático + proxy)

## Estrutura monorepo

```
neura-ai/
├── apps/
│   ├── api/          # Hono API + WS
│   ├── web/          # Next.js UI agentes
│   └── waworker/     # Baileys worker
├── packages/
│   ├── database/     # Prisma schema + client compartilhado
│   ├── shared/       # Types, schemas Zod, utils
│   └── ui/           # Componentes shadcn compartilhados
├── docker-compose.yml
├── docker-compose.dev.yml
├── turbo.json
├── package.json      # pnpm workspaces
├── PROJECT.md
└── .planning/
    └── ROADMAP.md
```

## Portas reservadas (registradas em `~/.claude/CLAUDE.md`)

Container internas, expostas pelo Caddy do Coolify (sem `ports:` no compose):

- 7301 → `apps/api`
- 7302 → `apps/web`
- 7303 → `apps/waworker` (interno, sem expor)
- Postgres/Redis/MinIO: portas padrão internas, sem expor ao host

## Arquitetura tempo real

```
Cliente WhatsApp → Baileys (waworker)
  ├─ persiste mensagem em Postgres via api REST interna
  └─ publica evento em Redis canal account:<id>:messages

api (Hono) inscrito no Redis pub/sub
  ├─ atualiza estado derivado (last_message_at, unread_count, sla_status)
  ├─ recalcula posição do card no kanban se necessário
  └─ broadcast via WebSocket nos canais conectados

web (Next.js) conectado ao WS desde login
  └─ recebe evento → atualiza Zustand → UI re-renderiza sem refresh
```

### Resiliência
- Eventos idempotentes (ID único)
- WS reconecta automaticamente + refetch delta por timestamp
- Reconciliação periódica 30s (rede de segurança)
- Polling fallback se WS indisponível >60s

### Segurança
- WS autenticado com JWT do Better Auth (token na primeira mensagem)
- Canais isolados por `account_id` (não tem chance de cliente A receber evento de B)
- Webhook outbound: HMAC SHA-256 nos payloads

## Riscos Baileys (operacionais)

- **Banimento de número**: Baileys não tem templates HSM (só WhatsApp Business API oficial). Não usar pra disparo em massa, só atendimento iniciado pelo cliente.
- **Sessão cai**: precisa monitoramento + reconexão. Worker tem healthcheck que reabre sessão se desconectar.
- **Memória por sessão**: ~80-150MB cada. Multi-sessão num worker = planejar escala vertical (VPS com 4-8GB RAM mínimo pra 10-20 sessões).
- **Auth state**: persistido em Postgres criptografado AES-256, não em arquivo plano (rotação de chave possível).

## Conventions

A serem populadas durante o desenvolvimento. Aderir aos padrões do `~/.claude/CLAUDE.md` global:
- Paginação em toda tabela (10/25/50/100, default 25)
- `await` + `try/catch` + toast em toda operação de escrita
- Dialog fecha só em sucesso
- `isSubmitting` em botão de submit
- ENVs completas no Coolify

## GSD Workflow Enforcement

Conforme `~/.claude/CLAUDE.md` global. Cada fase passa por `/gsd:plan-phase` antes de `/gsd:execute-phase`.

## Developer

Kalan (kalany7w no GitHub) — único TI em Caltech, Kresko, XAG. Stack Hono+Next.js. Não usa Rails+Vue do Chatwoot.
