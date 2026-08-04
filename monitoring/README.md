# Monitoramento — Prometheus + Grafana

Visualiza as métricas do `GET /metrics` da API (ver `.planning/OBSERVABILITY.md`).

```
monitoring/
├── docker-compose.monitoring.yml   # Prometheus + Grafana
├── prometheus/prometheus.yml       # scrape da API
└── grafana/
    ├── provisioning/
    │   ├── datasources/prometheus.yml   # datasource auto
    │   └── dashboards/dashboards.yml    # provider auto
    └── dashboards/neura-api.json        # o dashboard
```

## Subir

```bash
cd monitoring
docker compose -f docker-compose.monitoring.yml up -d
```

- Grafana: http://127.0.0.1:7621 (admin / `GRAFANA_PASSWORD` — **obrigatória**,
  o compose recusa subir sem ela). O datasource Prometheus e o dashboard
  **"Neura AI — API"** (pasta _Neura_) já entram provisionados.
- Prometheus: sem porta no host (não tem autenticação) — o Grafana acessa via
  rede Docker (`http://prometheus:9090`). Na VPS, acesso ao Grafana é via
  Coolify/Caddy com domínio, não por porta exposta.

## Conectar o Prometheus à API

O scrape aponta pra `api:7301`. Duas opções:

1. **Mesma rede docker do app** (recomendado): adicione o serviço `prometheus`
   à rede do `docker-compose.yaml` principal (ou rode ambos com
   `-p neura` numa rede compartilhada) pra o DNS `api` resolver.
2. **Standalone**: troque o target em `prometheus/prometheus.yml` pro host/IP e
   porta expostos da API (ex.: `host.docker.internal:7301` em dev, ou o IP da VPS).

Se `METRICS_TOKEN` estiver setado na API, descomente o bloco `authorization` em
`prometheus/prometheus.yml` e preencha o token.

## Importar o dashboard sem provisioning

Se já tem Grafana + Prometheus, importe só o JSON:
Grafana → Dashboards → New → Import → cole `grafana/dashboards/neura-api.json` →
escolha seu datasource Prometheus.

## Painéis

Conexões WS ativas · Requests/s · Erros 5xx (%) · Eventos real-time/s ·
Latência p50/p95/p99 · Requests/s por rota · Eventos por tipo · WS histórico ·
Memória (RSS/heap) · Event loop lag.

## Alertas nativos do Grafana (provisionados)

Já vêm provisionados em `grafana/provisioning/alerting/`:

- **API — erros 5xx > 5%** (5min) — crítico.
- **API — latência p95 > 2s** (5min) — warning.
- **API — target fora** (scrape down, 2min) — crítico.
- Roteados pro contact point `neura-webhook` → **`$ALERT_WEBHOOK_URL`** (mesmo
  webhook Discord/Slack do app; passado ao container Grafana pelo compose).

Setar `ALERT_WEBHOOK_URL` no ambiente antes do `up -d`:

```bash
ALERT_WEBHOOK_URL='https://discord.com/api/webhooks/...' \
docker compose -f docker-compose.monitoring.yml up -d
```

> Se seu webhook é Slack, troque `type: discord` por `type: slack` em
> `grafana/provisioning/alerting/contactpoints.yml`.

### Fallback via UI

O formato de alert rule provisionado varia entre versões do Grafana. Se as regras
não carregarem, crie na UI (Alerting → Alert rules → New) com estes valores:

- **5xx**: `100 * sum(rate(http_requests_total{status=~"5.."}[5m])) / clamp_min(sum(rate(http_requests_total[5m])), 1)` — `IS ABOVE 5`, for `5m`.
- **p95**: `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))` — `IS ABOVE 2`, for `5m`.
- Contact point: o `neura-webhook` (ou crie um novo apontando pro webhook).
