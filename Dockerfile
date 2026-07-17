# Multi-target monorepo Dockerfile (api / web / waworker)
# Build context = repo root. Compose define `target:` por service.
# Builder constrói TODOS os apps numa única camada (compartilhada entre targets
# via cache Docker) — cada target final copia só o que precisa.

# ========== base ==========
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.1.1 --activate
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app

# ========== deps (cache layer com todas deps do workspace) ==========
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/waworker/package.json ./apps/waworker/
COPY packages/database/package.json ./packages/database/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

# ========== builder (gera Prisma + builda os 3 apps de uma vez) ==========
FROM deps AS builder
COPY . .
RUN pnpm db:generate
# Build-time args do web: NEXT_PUBLIC_* são inlinados no bundle client pelo Next
# no `next build` (não bastam em runtime). NEXT_PUBLIC_SENTRY_DSN habilita o Sentry
# do browser. SENTRY_ORG/PROJECT/AUTH_TOKEN (opcionais) sobem os source maps.
ARG NEXT_PUBLIC_SENTRY_DSN=""
ARG SENTRY_ORG=""
ARG SENTRY_PROJECT=""
ARG SENTRY_AUTH_TOKEN=""
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    SENTRY_ORG=$SENTRY_ORG \
    SENTRY_PROJECT=$SENTRY_PROJECT \
    SENTRY_AUTH_TOKEN=$SENTRY_AUTH_TOKEN
# Build all (turbo paraleliza entre packages). 3 targets finais (api/web/waworker)
# reusam a mesma camada via cache do Docker.
RUN pnpm build

# ========== runner: api ==========
FROM base AS api-runner
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/packages/database ./packages/database
COPY --from=builder /app/packages/shared ./packages/shared
COPY package.json pnpm-workspace.yaml ./
EXPOSE 7301
WORKDIR /app/apps/api
# Aplica migrations então sobe servidor
CMD ["sh", "-c", "cd /app && pnpm --filter @neura/database migrate:deploy && cd /app/apps/api && node dist/index.js"]

# ========== runner: waworker ==========
FROM base AS waworker-runner
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/waworker/node_modules ./apps/waworker/node_modules
COPY --from=builder /app/apps/waworker/dist ./apps/waworker/dist
COPY --from=builder /app/apps/waworker/package.json ./apps/waworker/
COPY --from=builder /app/packages/database ./packages/database
COPY --from=builder /app/packages/shared ./packages/shared
COPY package.json pnpm-workspace.yaml ./
WORKDIR /app/apps/waworker
# migrate:deploy é idempotente + protegido por advisory lock no Postgres,
# então rodar em paralelo com o api é seguro. Evita race se o waworker subir
# antes do api aplicar uma migration de schema que ele já depende (ex: wa_auth_keys).
CMD ["sh", "-c", "cd /app && pnpm --filter @neura/database migrate:deploy && cd /app/apps/waworker && node dist/index.js"]

# ========== runner: web (Next.js standalone) ==========
FROM base AS web-runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=builder /app/apps/web/.next ./apps/web/.next
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/apps/web/package.json ./apps/web/
COPY --from=builder /app/apps/web/next.config.mjs ./apps/web/
COPY --from=builder /app/packages/shared ./packages/shared
COPY package.json pnpm-workspace.yaml ./
EXPOSE 7302
WORKDIR /app/apps/web
CMD ["npx", "next", "start", "--port", "7302"]
