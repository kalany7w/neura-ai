import { createMiddleware } from 'hono/factory';
import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

/**
 * Métricas Prometheus da API. Scrape em GET /metrics (protegido por METRICS_TOKEN
 * se setado). Cobre o que a auditoria pediu: taxa de 5xx, latência p50/p95
 * (via histograma), conexões WS ativas e eventos real-time publicados — além das
 * métricas default de processo/Node (memória, CPU, event-loop lag, GC).
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

const labelNames = ['method', 'route', 'status'] as const;

const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'Total de requests HTTP por método, rota e status',
  labelNames,
  registers: [registry],
});

const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duração das requests HTTP em segundos',
  labelNames,
  // Buckets ajustados a uma API web (5ms → 5s).
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const wsConnections = new Gauge({
  name: 'ws_active_connections',
  help: 'Conexões WebSocket ativas no momento',
  registers: [registry],
});

export const eventsPublished = new Counter({
  name: 'realtime_events_published_total',
  help: 'Eventos real-time publicados no Redis por tipo',
  labelNames: ['event'],
  registers: [registry],
});

/** Middleware Hono que mede contagem + duração de cada request (label por rota casada). */
export function metricsMiddleware() {
  return createMiddleware(async (c, next) => {
    const start = performance.now();
    try {
      await next();
    } finally {
      // routePath = padrão casado (ex.: /api/conversations/:id) → baixa cardinalidade.
      const route = c.req.routePath || 'unmatched';
      const labels = { method: c.req.method, route, status: String(c.res.status) };
      httpRequests.inc(labels);
      httpDuration.observe(labels, (performance.now() - start) / 1000);
    }
  });
}
