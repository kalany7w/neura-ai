# Self-hosting guide

Run the whole platform on your own server with Docker Compose. No external services required except an email provider (any SMTP server, or Resend).

## Requirements

- Docker Engine 24+ with Compose v2
- 4 GB RAM recommended (each WhatsApp session uses ~80–150 MB; 2 GB works for 1–3 sessions)
- An SMTP account **or** a [Resend](https://resend.com) API key (transactional email: signup confirmation, agent invites, password reset)
- For public deployments: a domain + reverse proxy (Caddy/nginx/Traefik)

## 1. Configure

```bash
git clone https://github.com/kalany7w/neura-ai.git && cd neura-ai
cp .env.example .env
```

Fill in `.env`:

| Variable | Required | Notes |
|----------|----------|-------|
| `POSTGRES_PASSWORD` | ✅ | Any strong password (user/db default to `neura`/`neura_ai`) |
| `MINIO_ROOT_PASSWORD` | ✅ | MinIO credentials (user defaults to `neura-minio`) |
| `BETTER_AUTH_SECRET` | ✅ | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | ✅ | `openssl rand -hex 32` — encrypts WhatsApp auth state at rest. **Losing it disconnects all WhatsApp sessions.** |
| `MAIL_FROM` | ✅ | Sender address for transactional email |
| `MAIL_FROM_NAME` | — | Sender display name (default `Neura AI`) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` | one provider required | Generic SMTP (option A) |
| `RESEND_API_KEY` | one provider required | Resend (option B). If both set, `MAIL_PROVIDER=smtp\|resend` decides (default `resend`) |
| `BETTER_AUTH_URL` | public deploys | Public URL of the **API** (e.g. `https://api.example.com`) |
| `TRUSTED_ORIGINS` | public deploys | Comma-separated web origins (e.g. `https://app.example.com`) |
| `PUBLIC_API_URL` | public deploys | Public API URL — required for Telegram webhooks |
| `APP_URL` | public deploys | Public web URL — used in email links |
| `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL` | public deploys | Baked into the web bundle at **build** time — rebuild the `web` image after changing |
| `API_PORT` / `WEB_PORT` | — | Host ports (default 7301 / 7302) |
| `OPENAI_API_KEY` | — | Optional — enables Whisper transcription + AI features. Empty = disabled gracefully |
| `WHISPER_MODEL` / `WHISPER_API_BASE` / `OPENAI_CHAT_MODEL` | — | AI defaults: `whisper-1`, OpenAI API, `gpt-4o-mini` |
| `RATE_LIMIT_LOGIN_MAX` / `RATE_LIMIT_LOGIN_WINDOW_SEC` | — | Login rate limit (default 5 / 60s) |
| `MINIO_BUCKET` | — | Media bucket (default `neura-media`) |
| `LOG_LEVEL` | — | `info` default |

Everything else in `.env.example` is for local development only.

## 2. Run

```bash
docker compose -f docker-compose.selfhost.yml up -d --build
```

Six containers start: `api`, `web`, `waworker`, `postgres` (pgvector), `redis`, `minio`. Database migrations run automatically when `api`/`waworker` boot.

Open `http://<server>:7302`, sign up (first user), create a workspace, then **Inboxes → WhatsApp → scan the QR** with the phone that owns the number.

## 3. Public deployment (reverse proxy)

Point two subdomains at the server and proxy them. Caddy example:

```caddyfile
app.example.com {
    reverse_proxy localhost:7302
}
api.example.com {
    reverse_proxy localhost:7301   # WebSocket upgrade is automatic in Caddy
}
```

Then set in `.env` and rebuild:

```env
BETTER_AUTH_URL=https://api.example.com
TRUSTED_ORIGINS=https://app.example.com
PUBLIC_API_URL=https://api.example.com
APP_URL=https://app.example.com
NEXT_PUBLIC_API_URL=https://api.example.com
NEXT_PUBLIC_WS_URL=wss://api.example.com/ws
```

```bash
docker compose -f docker-compose.selfhost.yml up -d --build web api
```

## Email inbound (optional)

The EMAIL inbox type receives mail through a generic parsed-MIME webhook (Postmark-compatible format; works with Resend Inbound, SES + Lambda, Cloudflare Email Workers). Create an EMAIL inbox in the UI — it generates the webhook URL + secret to configure at your provider.

## Telegram (optional)

Create a bot with @BotFather, add a Telegram inbox in the UI with the bot token. Requires `PUBLIC_API_URL` to be publicly reachable (Telegram delivers updates via webhook).

## Operations

- **Logs**: `docker compose -f docker-compose.selfhost.yml logs -f api waworker`
- **Backups**: volumes `postgres-data` (database), `minio-data` (media), `redis-data` (queues). Postgres dump: `docker compose -f docker-compose.selfhost.yml exec postgres pg_dump -U neura neura_ai > backup.sql`
- **Updating**: `git pull && docker compose -f docker-compose.selfhost.yml up -d --build` — migrations apply on boot
- **WhatsApp session drops**: the worker reconnects automatically; if the number was unlinked from the phone, re-scan the QR in Inboxes

## WhatsApp disclaimer

The WhatsApp channel uses Baileys (unofficial protocol client). Meta may ban numbers, particularly for outbound bulk messaging. Use a dedicated number and keep usage to customer-initiated support conversations. See the risk notes in the [README](../README.md).
