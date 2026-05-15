# Coolify — Pacote pra colar (gerado 2026-05-14, atualizado 2026-05-15)

Sequência exata pra subir o Neura AI em produção via Coolify. Secrets já gerados — basta colar.

> ⚠️ **Os secrets abaixo são únicos pra este deploy.** Não compartilhe nem reutilize em outro projeto. Se vazaram, regenere com `openssl rand -hex 32` antes de colar no Coolify.

---

## 1. DNS — fazer primeiro

Aponta os 3 subdomínios pro IP do VPS Coolify (registros A):

| Host | Tipo | Valor |
|---|---|---|
| `app.neura-ai.net` | A | `<IP do VPS>` |
| `api.neura-ai.net` | A | `<IP do VPS>` |
| `neura-ai.net` | A | `<IP do VPS>` (opcional, landing futura) |

Propagação: ~5min em provedores comuns. Verifique com `dig app.neura-ai.net +short`.

---

## 2. Resend — verificar domínio

1. Conta em https://resend.com
2. **Domains → Add Domain** → `neura-ai.net`
3. Adicionar os DNS records que o Resend mostrar (SPF TXT, DKIM CNAME/TXT, MX opcional). Wait propagação.
4. **API Keys → Create** → copiar o `re_...` → substituir no bloco ENV abaixo (`RESEND_API_KEY`).
5. Free tier: 3000 emails/mês, suficiente pro MVP.

---

## 3. Coolify — Application

1. **+ New Resource → Application**
2. Type: **Public Repository** ou **GitHub App** (se você instalou GitHub App no Coolify)
3. Repository URL: `https://github.com/kalany7w/neura-ai` (privado — usa deploy key SSH; copie a chave SSH que o Coolify gera e adicione em GitHub → Repo → Settings → Deploy keys com write disabled)
4. Branch: `main`
5. Build Pack: **Docker Compose**
6. Docker Compose File: `docker-compose.yaml`
7. Salva (não deploy ainda).

### Domains (na mesma application)

Em **Services**, mapear domínios pros containers internos:

| Serviço | Domínio | Porta interna |
|---|---|---|
| `api` | `https://api.neura-ai.net` | `7301` |
| `web` | `https://app.neura-ai.net` | `7302` |

Caddy do Coolify resolve SSL via Let's Encrypt automaticamente.

---

## 4. ENV — cola tudo de uma vez

Em **Environment Variables → bulk edit**, cola o bloco inteiro abaixo. **Não delete nada** — o Coolify gera algumas variáveis sozinho e elas precisam ficar.

```env
# === Database ===
POSTGRES_USER=neura
POSTGRES_PASSWORD=tk1WReaBLhAOC1znDyyfqtgyjZp8JHb8
POSTGRES_DB=neura_ai
DATABASE_URL=postgresql://neura:tk1WReaBLhAOC1znDyyfqtgyjZp8JHb8@postgres:5432/neura_ai

# === Redis ===
REDIS_URL=redis://redis:6379

# === Runtime ===
NODE_ENV=production
LOG_LEVEL=info

# === Ports (internos — Coolify roteia via Caddy) ===
API_PORT=7301
WEB_PORT=7302
WAWORKER_PORT=7303

# === Better Auth ===
BETTER_AUTH_SECRET=034393ab9827ed02f6c7804d9b2ab69b4ed8d71faf3fac057865341da75499ce
BETTER_AUTH_URL=https://api.neura-ai.net
TRUSTED_ORIGINS=https://app.neura-ai.net,https://neura-ai.net

# === URLs públicas (obrigatórias pra Telegram webhook + emails transacionais) ===
# PUBLIC_API_URL é o endpoint HTTPS público que o Telegram chama de volta (setWebhook).
# APP_URL é fallback (links em emails de invite/reset etc.).
PUBLIC_API_URL=https://api.neura-ai.net
APP_URL=https://app.neura-ai.net

# === Crypto (AES-256-GCM pra auth state Baileys) ===
ENCRYPTION_KEY=e1486083b01763b1f17b78565b55be67ec3cb8c27b33b1a0a8e4571e616e7395

# === Email transacional (Resend) ===
# Substitui pelo re_xxx gerado no passo 2.
RESEND_API_KEY=re_REPLACE_ME
RESEND_FROM=noreply@neura-ai.net
RESEND_FROM_NAME=Neura AI

# === Rate limit ===
RATE_LIMIT_LOGIN_MAX=5
RATE_LIMIT_LOGIN_WINDOW_SEC=60

# === MinIO (S3-compatible interno) ===
MINIO_ENDPOINT=minio
MINIO_PORT=9000
MINIO_ACCESS_KEY=c28dd671eedd3ba9f1893984b98a6d8f
MINIO_SECRET_KEY=lAdvK4MxF1lHxg24TipF449o0MgibXfTiX7GR2gl
MINIO_BUCKET=neura-media
MINIO_USE_SSL=false

# === Web (Next.js public) ===
NEXT_PUBLIC_API_URL=https://api.neura-ai.net
NEXT_PUBLIC_WS_URL=wss://api.neura-ai.net/ws

# === OpenAI (opcional — deixa vazio se não quiser usar agora) ===
# Mesma chave habilita 6 features (todas degradam silenciosamente sem key):
#   1) Whisper — transcrição automática de áudios inbound (~$0.006/min)
#   2) Sugestões de resposta no composer (gpt-4o-mini, ~$0.0005/sug)
#   3) Auto-classify de conversa — intent/urgency/sentiment, trigger 30s pós-inbound (~$0.0003)
#   4) Auto-summarize on-demand — botão "Resumir" no header (~$0.0003)
#   5) Next-action suggestions — botão "Sugerir ações" com whitelist anti-alucinação (~$0.0004)
#   6) Forecast IA por card kanban — probabilidade de fechar + reasoning (~$0.0005/card)
OPENAI_API_KEY=
WHISPER_MODEL=whisper-1
WHISPER_API_BASE=https://api.openai.com/v1
OPENAI_CHAT_MODEL=gpt-4o-mini

# === Coolify-generated (Coolify preenche automaticamente — NÃO mexer) ===
SERVICE_FQDN_API=api.neura-ai.net
SERVICE_FQDN_WEB=app.neura-ai.net
SERVICE_URL_API=https://api.neura-ai.net
SERVICE_URL_WEB=https://app.neura-ai.net
```

---

## 5. Deploy

1. Clica **Deploy**.
2. Build leva ~5min (primeira vez — instala pnpm + Prisma + Next build). Depois ~2min.
3. Migrations rodam automaticamente no boot do `api` (`prisma migrate deploy` no `CMD`).
4. Acompanha logs do `api` até ver `🚀 Neura API ready` e do `waworker` até `✅ waworker ready`.

### Verificação

| Check | URL | Esperado |
|---|---|---|
| API health | `https://api.neura-ai.net/health` | `{"status":"ok","checks":{"db":"ok","redis":"ok"}}` |
| Web carrega | `https://app.neura-ai.net/login` | Tela de login |
| WSS handshake | DevTools → Network → `wss://...` | 101 Switching Protocols após login |

---

## 6. Primeiro acesso

1. Acessa `https://app.neura-ai.net/signup` → cria conta (vira ADMIN do workspace).
2. Email verificado por Resend (em prod `requireEmailVerification=true`).
3. **Onboarding**: cria o primeiro workspace.
4. **Inboxes**: cria inbox WhatsApp → escaneia QR no celular (WhatsApp → Aparelhos conectados).
5. **Convidar agentes**: `/settings/members` (apenas ADMIN).

---

## 7. Backup

- **Postgres**: Coolify nativo. Application → Backups → schedule daily 03:00 UTC. Retém 7 dias.
- **MinIO**: cron container `restic` ou `rclone` apontando pro volume `minio-data`. (Coolify ainda não tem backup nativo de volumes de service — script de host serve.)

---

## 8. Troubleshooting

| Sintoma | Causa provável | Fix |
|---|---|---|
| Login falha "cookie not set" | `secure: true` + `sameSite: 'none'` precisa HTTPS válido | Cert do Caddy demorou: aguarde, ou force renew |
| WS desconecta toda hora | `TRUSTED_ORIGINS` errado ou WS upgrade barrado | Confere ENV bate exatamente com domínio HTTPS |
| Resend retorna `domain not verified` | DNS records SPF/DKIM ainda não propagaram | `dig +short txt _dkim.resend.neura-ai.net` |
| Build trava "no test files found" | OK, esperado em `@neura/waworker` (usa `--passWithNoTests`) | Ignorar |
| Container `api` reinicia em loop | `migrate deploy` falhou — schema dessincronizado | Logs do api; mais comum: `DATABASE_URL` aponta pra DB antigo. Solução: novo Coolify project = novo volume |
| Baileys cai e não reconecta | IP do VPS marcado como suspeito pelo WhatsApp | Tenta outro VPS / use proxy residencial |

---

## 9. Ativar IA (opcional, mesma chave habilita tudo)

1. Conta em https://platform.openai.com
2. **API keys → Create** → copia `sk-...`
3. Coolify → ENV → `OPENAI_API_KEY=sk-...` → Deploy
4. Logs do `api` mostram `Whisper transcribe worker started` + `AI worker started`.
5. Features ativas: Whisper (áudios inbound), sugestões de resposta (✨ composer),
   auto-classify (badges intent/urgency), summarize/next-action (botões no header chat),
   forecast IA (kanban — probabilidade por card + KPI "Receita prevista").
6. Custo médio por conversa ativa: ~$0.002 (classify + summarize + 1 forecast).

---

## 10. Conectar Telegram (opcional)

1. No Telegram, abre `@BotFather` → `/newbot` → escolhe nome + username terminando em `bot`.
2. Copia o token `123456:ABC-DEF...`
3. No Neura: `/inboxes` → **Conectar Telegram** → cola nome + token → Conectar.
4. Backend valida via `getMe`, gera slug + secret, configura webhook
   em `${PUBLIC_API_URL}/api/telegram/webhook/<slug>` automaticamente.
5. Mande qualquer mensagem pro bot — chega no /inbox do workspace.

> ⚠️ `PUBLIC_API_URL` precisa ser HTTPS acessível ao Telegram (Coolify Caddy
> resolve isso em prod). Em dev local, use ngrok.

---

## 11. Conectar Email (opcional)

1. No Neura: `/inboxes` → **Conectar Email** → preenche nome + endereço from + nome humano → Criar.
2. O Neura mostra um diálogo com **Webhook URL** + **Header secret**.
3. Configure o provedor de email pra encaminhar inbound pro webhook acima:
   - **Resend Inbound**: Dashboard → Inbound → Add address → forward to webhook URL.
   - **Postmark**: Servers → Inbound stream → Webhook URL + Custom Header `X-Neura-Email-Secret: <secret>`.
   - **AWS SES + Lambda**: Receipt rule → Lambda parsea MIME → POST com payload Postmark-style.
   - **Cloudflare Email Workers**: Worker parsea `message` → `fetch(url, { method: 'POST', headers, body })`.
4. Quando email chegar → vira conversation no /inbox (auto-card no funil default).
5. Outbound: composer envia via Resend SDK (mesma `RESEND_API_KEY` do app, domínio `RESEND_FROM` precisa estar verificado).

> ⚠️ Domínio do `fromAddress` precisa estar verificado no Resend (SPF + DKIM)
> pra emails saírem sem cair em spam. Resend Dashboard → Domains → Add.

---

## 12. Portas reservadas

Pra referência (host-exposed reservadas em `~/.claude/CLAUDE.md`):

- `7301`: api Hono REST + WS (não exposta — Caddy proxy)
- `7302`: web Next.js (não exposta — Caddy proxy)
- `7303`: waworker (interno, sem expor)
- Postgres/Redis/MinIO: portas padrão internas, isoladas

**Coolify regra**: `docker-compose.yaml` não declara `ports:` em service nenhum. Apenas roteamento via Caddy.
