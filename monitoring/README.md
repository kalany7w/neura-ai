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

- Grafana: http://localhost:3000 (admin / `GRAFANA_PASSWORD`, default `admin`).
  O datasource Prometheus e o dashboard **"Neura AI — API"** (pasta *Neura*) já
  entram provisionados.
- Prometheus: http://localhost:9090.

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

## Alerta sugerido (opcional)
No Grafana, criar alerta em cima do painel **Erros 5xx (%)** (> 5% por 5min) e
**Latência p95** (> 2s por 5min) → notifica no mesmo canal do `ALERT_WEBHOOK_URL`.
