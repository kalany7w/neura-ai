# Pendências — Neura AI

Atualizado em 2026-07-21 (revisão do PR #12 `fix/maju-security-hardening` + fixes
aplicados em duas rodadas — a 2ª cobriu ws.ts/AGENT realtime, membership,
métricas, telegram dedup, body limit, graceful shutdown e afins).

## Antes do merge do PR #12 (checklist de deploy — decisão do Kalan)

- [ ] **Conferir inboxes Telegram/Email com secret vazio.** O PR torna os webhooks
      fail-closed: inbox sem secret passa a rejeitar 403 e para de receber no deploy.
- [ ] **ENV novas no Coolify** (o compose passa a referenciar; todas têm default
      vazio/no-op — podem ficar vazias no primeiro deploy): `ALERT_WEBHOOK_URL`,
      `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`,
      `SENTRY_AUTH_TOKEN`, `METRICS_TOKEN`, `API_MEM_LIMIT`, `WEB_MEM_LIMIT`,
      `WAWORKER_MEM_LIMIT`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_ACCESS_KEY`,
      `BACKUP_S3_SECRET_KEY`, `BACKUP_S3_BUCKET`, `BACKUP_INTERVAL_SECONDS`.
- [ ] **Pós-deploy**: verificar que as sessões Baileys reconectaram sozinhas e que
      o rate limit novo de IA (30/min por workspace) não atrapalha uso real.

## Da revisão — não resolvidos (aceitos por ora)

- [ ] **Fairness da fila outbound entre tenants**: fila única FIFO — um disparo
      grande de um workspace atrasa os outros. A ordem POR CONVERSA foi resolvida
      (serialização por chat), mas fairness entre inboxes + métrica/alerta de
      profundidade da fila (`getWaitingCount()` no /health) ficam pra depois.
      Nota da 2ª rodada: um burst de ≥3 msgs pro MESMO chat ocupa os 3 slots do
      worker dormindo na espera da cadeia (head-of-line blocking) — a solução
      definitiva é fila por-chat (BullMQ groups) em vez do lock in-memory.
- [ ] **Serialização do outbound é por-processo**: o lock por chat é um Map em
      memória — se o waworker um dia escalar pra >1 réplica, a garantia de ordem
      cai (precisaria lock via Redis/BullMQ groups). Hoje é instância única.
- [ ] **Escopo de AGENT no realtime usa cache TTL 30s**: mudança de atribuição
      invalida na hora via evento, mas um take-over manual no DB (fora da API)
      pode levar até 30s pra refletir no WS. Aceitável; documentado.
- [ ] **Duplicação de envio no retry do outbound** (pré-existente): sendMessage OK + update no DB falha → job re-tenta → mensagem duplicada no WhatsApp. Precisa
      idempotência (marcar job como enviado no Redis antes do update).
- [ ] **Anúncios de screen reader do dnd-kit em inglês** no kanban (a11y i18n) —
      o coordinateGetter foi corrigido; falta `accessibility={{ announcements }}`
      traduzido PT/ES.
- [ ] **`inbox/[id]/error.tsx` com strings PT-only** (podia usar useT).
- [ ] **Monitoring na VPS**: o compose de monitoring agora é loopback 7621 local;
      pra usar em prod, criar resource no Coolify roteando o Grafana via Caddy com
      domínio + senha forte (`GRAFANA_PASSWORD` é obrigatória).

## Pré-existentes (não são do PR #12)

- [ ] **Compose de prod sem rede `coolify` external** (regra do CLAUDE.md).
      Funciona hoje; alinhar num deploy futuro pra evitar o bug de intermitência
      pós-restart que derrubou a auditoria em maio.
- [ ] **Roadmap/PROJECT.md desatualizados** — código avançou via Ondas 4-8 e agora
      o hardening do PR #12; docs pararam em 2026-05-13.
- [ ] **Rate limit por IP ainda depende do proxy**: `clientIp()` usa o último hop
      do XFF (correto atrás do Caddy/Coolify); se um dia rodar sem proxy, revisar.
