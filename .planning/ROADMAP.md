# Roadmap — Neura AI

10 fases pra MVP em ~10 semanas (48 dias úteis).

## Princípios transversais

- **Real-time é responsabilidade de cada fase** (não da Fase 9). Cada fase 2-8 implementa os eventos WS dela. Fase 9 é hardening (reconnect, stress, observabilidade).
- **Testes distribuídos**: cada fase entrega seus próprios testes (unit, integration ou E2E conforme aplicável). Sem fase final de "adicionar testes".
- **Matriz de permissões** (`admin` / `supervisor` / `agent`) aplicada em cada CRUD:
  - `admin`: tudo
  - `supervisor`: lê todas conversas + cards + relatórios, escreve sem restrição salvo settings de account
  - `agent`: lê/escreve só conversas atribuídas a ele + sem-agente; CRUD próprios cards; sem settings
- **Audit log** em ações sensíveis: criar/deletar/atribuir card, mudar role, deletar conta, exportar dados, conectar/desconectar inbox.

## Resumo (atualizado 2026-05-13)

| #         | Fase                                                                                                           | Estimativa              | Status                                                                                        |
| --------- | -------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| 1         | Scaffold + auth + multi-tenant + email + audit log + permissões + CI                                           | 6d                      | ✅ done                                                                                       |
| 2         | Baileys worker (sessão única → multi) + WS msgs                                                                | 8d                      | ✅ done                                                                                       |
| 3         | Mídia (MinIO + envio/recepção + thumbnails)                                                                    | 5d                      | ✅ done (thumbnails pendentes)                                                                |
| 4         | Inbox UI (conversas + atribuição + notas + templates) + WS atendimento                                         | 5d                      | ✅ done (lista+chat+send+notas internas+templates com shortcuts/placeholders)                 |
| 5         | Contatos + labels + custom attrs + WS labels/contato                                                           | 2.5d                    | ✅ done                                                                                       |
| 6         | Kanban core (funis + stages + drag-drop + modal) + WS cards                                                    | 5d                      | ✅ done + auto-card creation                                                                  |
| 7         | Diferenciais kanban (busca + filtro etiqueta + SLA + preview msg + badges + atribuição inline) + WS SLA/unread | 6d                      | 🟡 SLA periódico + busca + filtro etiqueta + preview + badge done; atribuição inline pendente |
| 8         | Filtros salvos + snooze + histórico contato + WS snooze                                                        | 3.5d                    | ⏳ schema pronto (SavedFilter, CardSnooze), implementação pendente                            |
| 9         | Real-time hardening + observabilidade (reconnect + stress + Pino + alertas)                                    | 5d                      | 🟡 reconnect WS done; observability básica (Pino) done; stress test + alertas pendentes       |
| 10        | Deploy Coolify produção (api.neura-ai.net + app.neura-ai.net)                                                  | 2.5d                    | ✅ done (Dockerfile + compose + DEPLOY.md prontos; falta provisionar no Coolify)              |
| **Total** |                                                                                                                | **48.5d (~10 semanas)** | **~85% done**                                                                                 |

Pendências pra próxima sessão:

- Notas internas + templates de resposta (Fase 4)
- Thumbnails (sharp + ffmpeg) na recepção de mídia (Fase 3)
- Atribuição inline no card kanban (Fase 7)
- Filtros salvos UI + Snooze UI (Fase 8)
- Stress test + alertas Discord/Betterstack (Fase 9)
- Provisionar Coolify + DNS + Resend domain verify (Fase 10 operacional)

---

## Fase 1 — Scaffold + auth + multi-tenant + email + audit log + permissões + CI (6d)

**Objetivo**: Base rodando localmente, login/signup funcionando com email, multi-tenant isolado, audit log ativo, CI verde.

**Entregáveis**:

- Monorepo pnpm + turborepo (`apps/api`, `apps/web`, `apps/waworker`, `packages/database`, `packages/shared`, `packages/ui`)
- `apps/api` Hono com healthcheck + Better Auth + Prisma + Pino
- `apps/web` Next.js 15 com login/signup + dashboard vazio + design system (shadcn instalado)
- Schema Prisma: `Account`, `User`, `UserAccount` (m2m com `role: admin|supervisor|agent`), `Invite`, `AuditLog`
- Middleware multi-tenant: extrai `account_id` da sessão, injeta em queries (Prisma extension global)
- Middleware permissions: cada endpoint checa role via decorator/helper
- Email transacional via **Resend** (signup confirmation, convite agente, reset password)
- Audit log: helper `audit(actor, action, resource, payload)` registra em tabela
- Rate limit no login (5 tentativas/min/IP via rate-limiter-flexible + Redis)
- Docker compose dev (Postgres + Redis)
- GitHub Actions CI (lint + typecheck + build + testes)
- Testes:
  - Unit: helper de permissions, middleware multi-tenant
  - Integration: signup → cria account, login retorna sessão válida, isolamento (User A não lê dados Account 2)

**Critérios aceite**:

- `pnpm dev` sobe api + web localmente
- `pnpm build` builda os 3 apps sem erro
- Signup → email Resend chega → confirma → cria account + user como admin
- Convidar 2º user (role agent) → email convite chega → user clica link → cria conta vinculada à account
- User A da Account 1 NÃO consegue ler dados da Account 2 (testes integration passam)
- Agente NÃO consegue acessar `/settings/account` (403)
- Audit log registra: criar account, convidar user, deletar user
- 5 tentativas de login com senha errada → 429 rate limit
- CI verde no push (lint + typecheck + build + testes)

---

## Fase 2 — Baileys worker + WS msgs (8d)

**Objetivo**: Conectar números WhatsApp via QR, receber/enviar texto, multi-sessão, mensagens chegam na UI em real-time.

**Entregáveis**:

- `apps/waworker` Node + Baileys com suporte multi-sessão (worker process com N sessões)
- Endpoints internos do worker: `POST /sessions`, `GET /sessions/:id/qr`, `DELETE /sessions/:id`, `GET /sessions/:id/status`
- Auth state Baileys persistido em Postgres tabela `WaSession` com encrypted_state (AES-256-GCM, chave em `.env`)
- Tabelas: `Inbox` (= identidade WhatsApp), `Conversation`, `Message`, `WaSession`
- Recepção: evento `messages.upsert` → grava `Message` → publica em Redis canal `account:<id>:messages`
- Envio: api recebe POST /messages → enfileira em Redis (BullMQ) → worker consome → envia via Baileys → atualiza status (pending/sent/delivered/read)
- Reconexão automática (backoff exponencial: 1s, 2s, 4s, 8s, 30s)
- QR code refresh automático se expirar (Baileys gera novo) — publica novo QR via WS
- **WebSocket Hono**: clientes conectam em `wss://api.neura-ai.net/ws` com JWT. Subscreve canal por `account_id`. Recebe eventos: `message.new`, `message.status_changed`, `inbox.qr`, `inbox.status_changed`
- UI: tela `/inboxes` → criar inbox (nome) → QR aparece em tempo real (via WS) → escaneia → status atualiza pra "conectado"
- UI: tela placeholder de conversa que mostra msgs novas chegando (sem responder ainda — isso é Fase 4)
- Audit log: criar/deletar inbox, conectar/desconectar
- Testes:
  - Unit: encrypt/decrypt auth state, BullMQ queue handlers
  - Integration: envio enfileira → worker mock consome → status atualiza
  - E2E mínimo (Playwright): criar inbox → ver QR → mockar evento "conectado" → confirmar UI atualiza

**Critérios aceite**:

- QR aparece na UI em tempo real (sem refresh)
- Escaneia QR → status muda pra "conectado" em todos browsers abertos
- Cliente manda msg pelo celular → aparece no DB em <2s → aparece na UI sem refresh em <1s adicional
- Envio via UI/API → mensagem chega no celular do cliente em <2s
- Worker reinicia → sessão reconecta sem novo QR
- 2 inboxes simultâneas funcionam no mesmo worker process
- AES-256 funciona (state criptografado em DB ilegível sem chave)

---

## Fase 3 — Mídia (5d)

**Objetivo**: Envio e recepção de imagem, vídeo, áudio, documento, com storage MinIO.

**Entregáveis**:

- MinIO no docker-compose (bucket `neura-media` por account, key/secret no Coolify)
- Upload presigned URL (web pede URL → api gera assinada → web sobe direto no MinIO)
- Worker baixa mídia recebida do WhatsApp em **streaming** (não buffer inteiro) → sobe no MinIO → salva `media_url` no `Message`
- Thumbnails: imagem (sharp) e vídeo (ffmpeg via fluent-ffmpeg). Gerados async (BullMQ).
- UI: preview inline de imagem/vídeo/áudio/doc no chat, com lightbox pra fullscreen
- Player de áudio (transcrição opcional via Whisper na Fase futura)
- Limites de upload: imagem 16MB, vídeo 64MB, áudio 16MB, doc 100MB. Validação client + server.
- Streaming chunked pra arquivos grandes (não estoura memória do worker)
- WS evento `message.media_ready` quando thumbnail termina (atualiza preview sem refresh)
- Testes:
  - Unit: validador de limites, mime type detection
  - Integration: upload presigned → MinIO recebe → thumbnail gerado → URL acessível
  - E2E: agente envia imagem → MinIO armazena → cliente recebe (mockado)

**Critérios aceite**:

- Cliente manda foto → thumbnail aparece em <3s + lightbox abre em alta
- Cliente manda áudio → player toca no chat
- Agente envia imagem (drag-drop) → upload em background sem travar UI → cliente recebe
- Arquivo 200MB → bloqueado client-side + server-side com toast claro
- Mídia armazenada em MinIO isolada por `account_id` (path `accounts/<id>/...`)

---

## Fase 4 — Inbox UI + WS atendimento (5d)

**Objetivo**: Tela de atendimento ao vivo. Responder, atribuir, notas, templates. Tudo em tempo real.

**Entregáveis**:

- Tela `/inbox`: lista de conversas (paginada 25), filtros (status, agente, inbox, sem-agente, busca)
- Conversa aberta: histórico (lazy load), input rich text + anexos, indicador "digitando" do cliente
- Atribuir agente (dropdown com permissão por role) → mudar status (open/pending/resolved/snoozed)
- Notas internas (toggle "nota privada" no input — só agentes da account veem)
- Templates de resposta (canned responses por account, placeholders `{{contact.name}}`, atalho `/nome`)
- Marca msg como lida quando agente abre conversa (POST → atualiza `Message.read_at`)
- Indicador "digitando…" via Baileys `presence.update`
- **WS eventos**: `conversation.assigned`, `conversation.status_changed`, `conversation.note_added`, `message.read`, `conversation.typing`
- Audit log: atribuir/desatribuir agente, mudar status, deletar nota
- Permissões: agent só vê conversas atribuídas a ele OU sem agente. Supervisor/admin vê todas.
- Testes:
  - Integration: atribuir agente → conversation.assigned event publicado
  - E2E: 2 browsers, agente A atribui conversa a agente B → agente B vê em <1s sem refresh

**Critérios aceite**:

- Agente abre inbox, vê 25 conversas paginadas, abre uma, responde, msg sai pra WhatsApp
- Atribui pra outro agente → outro agente vê notificação em real-time
- Filtra "sem agente" → só não-atribuídas
- Nota privada visível só por agentes da account, cliente nunca recebe
- Template `/saudacao` expande pra "Olá {{contact.name}}, tudo bem?" com nome preenchido
- Agent não vê conversas de outros agentes (testa com 2 users)

---

## Fase 5 — Contatos + labels + custom attrs + WS (2.5d)

**Objetivo**: Cadastro robusto de contatos, etiquetas, atributos customizados, com sync real-time.

**Entregáveis**:

- Tela `/contacts`: lista paginada, busca (nome/telefone/email), filtro por label
- Criação/edição: nome, telefone (validação E.164), email, avatar, custom attrs
- Labels CRUD (cor + nome + `applies_to: contact|conversation|both`) por account
- Custom attribute definitions (`string|number|date|select` + options se select)
- Aplicar label a conversa **e** a contato (separadamente)
- Merge de contatos duplicados (mesmo telefone E.164) — unifica histórico de conversas
- Histórico de conversas por contato (timeline)
- **WS eventos**: `label.applied`, `label.removed`, `contact.updated`, `contact.merged`
- Permissões: agent edita só contatos com conversa atribuída a ele; supervisor/admin todos
- Testes:
  - Unit: normalização E.164
  - Integration: merge contatos unifica conversations

**Critérios aceite**:

- Criar contato manual + automático (msg de novo número cria contato)
- Aplicar "VIP" no contato → vê o label nos próximos cards do kanban
- Buscar por nome ou telefone <500ms (índice no banco)
- Merge 2 contatos com mesmo número → conversations unidas, contato secundário deletado, audit log registra

---

## Fase 6 — Kanban core + WS (5d)

**Objetivo**: Funis com stages, cards = conversas, drag-drop, modal de edição, atualização real-time entre browsers.

**Entregáveis**:

- Schema: `Funnel`, `Stage` (com `is_won|is_lost`), `Card` (linkado a `Conversation`), `CardLabel`, `CardProduct`
- Tela `/kanban`: seletor de funil, board com stages, cards
- Drag-drop card entre stages (@dnd-kit, mutação otimista + revert se 4xx)
- Modal edição: title, description (rich), value+products, agentes, labels, contatos, conversations, schedule, custom attrs
- Auto-criação de card quando conversa nova chega (configurável por inbox → funil/stage default)
- Won/Lost stages laterais (não aparecem no flow normal)
- Stages CRUD: cor, ordem, nome, won/lost flag
- **WS eventos**: `card.created`, `card.moved`, `card.updated`, `card.deleted`, `stage.updated`
- Audit log: criar/mover/deletar card, mudar stage do funil
- Permissões: agent vê só cards de conversas atribuídas; supervisor/admin todos
- Testes:
  - Integration: mover card via API → card.moved event publicado
  - E2E: 2 browsers, mover card no A → reflete no B em <1s

**Critérios aceite**:

- Cria funil "Vendas" com stages "Lead → Qualificação → Proposta → Fechado"
- Conversa nova de inbox X cria card auto no stage Lead do funil X (regra configurável)
- Drag-drop persiste + mostra em outros browsers em <1s sem refresh
- Modal edição salva todos campos atomicamente

---

## Fase 7 — Diferenciais kanban + WS (6d)

**Objetivo**: Features que faltam no fazer.ai e fazem diferença real no dia a dia.

**Entregáveis**:

- **Busca textual** no board: input filtra cards por título, nome contato, telefone, label, número da conversa
- **Filtro por etiqueta clicável**: chip de label no card → click → toggle no filtro
- **SLA visual**: cor da borda do card escalona por tempo sem resposta do agente (verde <15min, amarelo 15-30min, vermelho 30-60min, piscando >1h). Limiares configuráveis por funil.
- **Preview da última mensagem** no card: snippet 60 chars + ícone direção (cliente↔agente) + timestamp relativo ("4d", "21h")
- **Badge não-lidas** no card (conta msgs não lidas pelo agente atribuído)
- **Atribuição inline**: clica no avatar do agente no card → dropdown → troca sem abrir modal. Idem labels.
- Worker periódico calcula SLA a cada minuto e publica `card.sla_changed` apenas pros cards que mudaram de banda
- **WS eventos**: `card.sla_changed`, `card.unread_changed`, `card.last_message_preview_changed`
- Testes:
  - Unit: SLA calc (boundary tests: 14m59s = verde, 15m = amarelo, etc.)
  - E2E: card sem resposta agente por X tempo → muda cor sem refresh

**Critérios aceite**:

- Busca "joão" filtra board em tempo real
- Clica label "VIP" → board mostra só cards com VIP
- Card 45min sem resposta agente fica vermelho sozinho (sem refresh)
- Preview da última msg atualiza quando msg nova chega
- Avatar inline troca agente sem abrir modal (permissão por role)

---

## Fase 8 — Filtros salvos + snooze + histórico contato + WS (3.5d)

**Entregáveis**:

- Filtros salvos: combinação atual (busca + labels + agente + status + funil) salva com nome ("Meus em espera > 1h"). Per user.
- Snooze: clica card → "lembrar X" → opções (em 1h / amanhã 9h / próx segunda / custom) → card esconde até hora → reaparece com badge "snooze terminou"
- Histórico do contato: clica contato → modal com todas conversations anteriores (timeline ordenada)
- Worker periódico checa snoozes vencidos a cada 30s → reativa + publica `card.snooze_expired`
- **WS eventos**: `card.snoozed`, `card.snooze_expired`, `filter.saved`
- Testes:
  - Integration: snooze 5s → worker reativa em <30s
  - E2E: snooze card → some → reaparece com badge

**Critérios aceite**:

- Salvar "Sem agente", recarregar página, aplicar filtro → mesmos critérios
- Snooze pra +2min → card some → reaparece em 2-2.5min com badge laranja
- Histórico mostra todas conversations do contato em ordem cronológica

---

## Fase 9 — Real-time hardening + observabilidade (5d)

**Objetivo**: Endurecer o real-time (cada fase já implementou sua parte; agora resilência), adicionar observabilidade pra operação em produção.

**Entregáveis**:

- Reconexão WS automática com backoff (1s, 2s, 4s, 8s, 30s; jitter pra não cascatear)
- Refetch delta após reconexão (cliente envia `last_event_id` ou timestamp → servidor retorna diff)
- Worker reconciliador 30s: percorre estado vs DB, publica eventos perdidos
- Tela status conexão no header (verde conectado / amarelo reconectando / vermelho desconectado)
- Heartbeat ping-pong WS (30s) — fecha conexões zumbis
- **Observabilidade**:
  - Pino structured logs (JSON) com `correlation_id` em toda request
  - Métricas básicas em endpoint `/metrics` (Prometheus format): WS conexões ativas, eventos publicados/s, latência p50/p95, erros 5xx
  - Alertas via Betterstack (opcional) ou Discord webhook: queda de sessão Baileys, taxa erro >5%, latência p95 >2s
- Stress test: script Node que cria N conversas + envia M msgs em T segundos → verifica todas aparecem na UI
- Testes:
  - Integration: cliente WS desconecta → reconecta → recebe delta
  - Stress: 100 msgs em 10s → todas aparecem com latência <2s

**Critérios aceite**:

- 2 browsers: ação num reflete no outro em <1s
- Desconecta wifi 30s → reconecta → estado completo restaura sem refresh manual
- Stress 100 msgs/10s → 100% aparece, latência p95 <2s
- Discord recebe alerta se sessão Baileys cair >5min

---

## Fase 10 — Deploy Coolify produção (2.5d)

**Entregáveis**:

- Coolify projeto `neura-ai`
- 3 apps: `api` (api.neura-ai.net), `web` (app.neura-ai.net), `waworker` (interno, sem domínio)
- Postgres + Redis + MinIO como services no Coolify
- ENVs completas (incluindo `SERVICE_URL_*`, `SERVICE_FQDN_*` autogeradas Coolify, Resend API key, AES-256 key, JWT secret, etc.)
- DNS: A records pra api.neura-ai.net e app.neura-ai.net apontando pro VPS
- Healthchecks corretos por imagem (sem chutar `curl` em imagens distroless)
- Logs Pino → Betterstack (free tier)
- Backup automático Postgres (Coolify nativo) + MinIO (rclone cron pra B2/S3)
- Migration `prisma migrate deploy` no startup do container api
- Seed opcional pra primeira account/admin (`PRISMA_SEED_ADMIN_EMAIL` em ENV)
- Testes:
  - Smoke test pós-deploy: curl `/health` retorna 200, login flow E2E

**Critérios aceite**:

- `https://api.neura-ai.net/health` retorna 200 com cert válido
- `https://app.neura-ai.net` carrega login
- Fluxo end-to-end: signup → confirma email → cria account → conecta inbox (escaneia QR) → cliente manda msg → aparece na UI em real-time
- Coolify "Deploy" rebuilda os 3 apps em <5min
- Backups Postgres rodam diariamente, MinIO semanal
