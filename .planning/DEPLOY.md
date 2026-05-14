# Deploy — Coolify

Guia operacional para subir Neura AI em produção via Coolify.

## Estrutura

```
neura-ai.net          → Landing (futuro)
app.neura-ai.net      → web (Next.js, container interno :7302)
api.neura-ai.net      → api (Hono + WS, container interno :7301)
```

`waworker` é interno (sem domínio).
`postgres` / `redis` / `minio` rodam como services no mesmo Compose, isolados da rede pública.

## ENV obrigatórias (Coolify Application → Environment Variables)

Gerar secrets antes:
```sh
openssl rand -hex 32  # pra BETTER_AUTH_SECRET
openssl rand -hex 32  # pra ENCRYPTION_KEY
openssl rand -base64 24  # pra POSTGRES_PASSWORD
openssl rand -base64 24  # pra MINIO_ACCESS_KEY
openssl rand -base64 32  # pra MINIO_SECRET_KEY
```

ENV block completo (copiar pro Coolify):

```env
# Database
POSTGRES_USER=neura
POSTGRES_PASSWORD=<gerar>
POSTGRES_DB=neura_ai
DATABASE_URL=postgresql://neura:<senha>@postgres:5432/neura_ai

# Redis
REDIS_URL=redis://redis:6379

# Auth
BETTER_AUTH_SECRET=<openssl rand -hex 32>
BETTER_AUTH_URL=https://api.neura-ai.net
TRUSTED_ORIGINS=https://app.neura-ai.net,https://neura-ai.net

# Crypto (Baileys auth state encryption)
ENCRYPTION_KEY=<openssl rand -hex 32>

# Email transacional
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
RESEND_FROM=noreply@neura-ai.net
RESEND_FROM_NAME=Neura AI

# Rate limit
RATE_LIMIT_LOGIN_MAX=5
RATE_LIMIT_LOGIN_WINDOW_SEC=60

# MinIO (S3-compatible)
MINIO_ENDPOINT=minio
MINIO_PORT=9000
MINIO_ACCESS_KEY=<gerar>
MINIO_SECRET_KEY=<gerar>
MINIO_BUCKET=neura-media
MINIO_USE_SSL=false

# Web (Next.js public)
NEXT_PUBLIC_API_URL=https://api.neura-ai.net
NEXT_PUBLIC_WS_URL=wss://api.neura-ai.net/ws

# Whisper transcription (opcional — vazio desliga transcrição automática de áudio)
OPENAI_API_KEY=
WHISPER_MODEL=whisper-1
WHISPER_API_BASE=https://api.openai.com/v1

# Coolify-generated (Coolify preenche automaticamente — NÃO mexer)
SERVICE_FQDN_API=api.neura-ai.net
SERVICE_FQDN_WEB=app.neura-ai.net
SERVICE_URL_API=https://api.neura-ai.net
SERVICE_URL_WEB=https://app.neura-ai.net
```

## Setup no Coolify

1. **Nova Application** tipo Docker Compose
2. Repository: `kalany7w/neura-ai` (privado — usa SSH deploy key)
3. Branch: `main`
4. Build pack: Docker Compose
5. Compose file: `docker-compose.yml`
6. Cola o ENV block acima
7. **Domains**:
   - service `api` → `api.neura-ai.net` (port: 7301)
   - service `web` → `app.neura-ai.net` (port: 7302)
8. DNS: criar A records pra api/app/neura-ai.net apontando pro VPS Coolify

## Email (Resend)

1. Criar conta em https://resend.com
2. Adicionar domínio `neura-ai.net` (Resend gera DNS records: SPF, DKIM, MX)
3. Verificar domínio
4. Gerar API key → `RESEND_API_KEY`
5. Definir `RESEND_FROM=noreply@neura-ai.net`

## Primeiro deploy

1. Salvar ENVs + Deploy
2. Aguardar build (~5min primeira vez)
3. Migrations rodam automaticamente no boot do `api` (CMD `prisma migrate deploy`)
4. Acessar `https://app.neura-ai.net` → tela de signup
5. Criar primeira conta (vira ADMIN do workspace)

## Backup

- **Postgres**: Coolify nativo (Application → Backups → schedule daily)
- **MinIO**: rclone cron container ou script no host (cópia `minio-data` volume)

## Healthcheck

`https://api.neura-ai.net/health` → `{"status":"ok","checks":{"db":"ok","redis":"ok"}}`

## Troubleshooting

**Workflow scope error no push**: rodar `gh auth refresh -s workflow` localmente

**Build falha "no test files found"**: waworker tem `--passWithNoTests` no script test, deve passar

**Cookies cross-origin (auth não funciona)**: Better Auth precisa `cookieOptions: { sameSite: 'none', secure: true, domain: '.neura-ai.net' }` em prod — ajustar se necessário

**Sessão Baileys cai**: ver logs `waworker` no Coolify. Normal: reconnect automático com backoff. Se múltiplas falhas em sequência, verificar IP do VPS (WhatsApp bane IPs suspeitos)

**Porta conflito**: Coolify usa Caddy nas portas 80/443. Containers expostos só pela rede interna. Não declarar `ports:` no compose.

## Portas reservadas (registradas em ~/.claude/CLAUDE.md)

- 7301: api (Hono REST + WS)
- 7302: web (Next.js)
- 7303: waworker (sem expor — só comunicação interna via Redis)
- Postgres/Redis/MinIO: portas padrão internas, sem expor ao host
