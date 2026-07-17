/**
 * Stress test do real-time (Fase 9 do roadmap).
 *
 * Fluxo testado: publica evento no Redis (canal do workspace) → subscriber WS da
 * API faz fan-out pros N clientes conectados. Mede taxa de entrega e latência
 * (publish → recebido no cliente).
 *
 * Critério de aceite do roadmap: 100 msgs/10s → 100% entregue, p95 < 2s.
 *
 * REQUER o stack rodando (API + Redis) e um usuário de teste com workspace.
 * Uso:
 *   LOGIN_EMAIL=a@b.com LOGIN_PASSWORD=... \
 *   API_URL=http://localhost:7301 REDIS_URL=redis://localhost:6379 \
 *   CLIENTS=10 MESSAGES=100 DURATION_MS=10000 \
 *   pnpm --filter @neura/api stress:realtime
 */
import Redis from 'ioredis';
import WebSocket from 'ws';

const API_URL = process.env.API_URL ?? 'http://localhost:7301';
const WS_URL = process.env.WS_URL ?? API_URL.replace(/^http/, 'ws') + '/ws';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const EMAIL = process.env.LOGIN_EMAIL;
const PASSWORD = process.env.LOGIN_PASSWORD;
const CLIENTS = Number(process.env.CLIENTS ?? 10);
const MESSAGES = Number(process.env.MESSAGES ?? 100);
const DURATION_MS = Number(process.env.DURATION_MS ?? 10_000); // janela pra publicar as M msgs
const WAIT_MS = Number(process.env.WAIT_MS ?? 10_000); // espera extra por recebimentos após publicar
const MAX_P95_MS = Number(process.env.MAX_P95_MS ?? 2_000);
const MIN_DELIVERY = Number(process.env.MIN_DELIVERY ?? 1.0);

function die(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

if (!EMAIL || !PASSWORD) {
  die(
    'Faltam LOGIN_EMAIL e LOGIN_PASSWORD (usuário de teste com workspace).\n' +
      'Ex.: LOGIN_EMAIL=a@b.com LOGIN_PASSWORD=... pnpm --filter @neura/api stress:realtime',
  );
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function login(): Promise<string> {
  const res = await fetch(`${API_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) die(`Login falhou (${res.status}): ${await res.text()}`);
  const setCookies =
    (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  if (!cookie.includes('session')) die('Login não retornou cookie de sessão');
  return cookie;
}

async function getWorkspaceId(cookie: string): Promise<string> {
  const res = await fetch(`${API_URL}/api/workspaces`, { headers: { cookie } });
  if (!res.ok) die(`GET /api/workspaces falhou (${res.status})`);
  const data = (await res.json()) as {
    workspaces: Array<{ id: string }>;
    activeWorkspaceId: string | null;
  };
  const id = data.activeWorkspaceId ?? data.workspaces[0]?.id;
  if (!id) die('Usuário não tem workspace');
  return id;
}

interface ClientState {
  ws: WebSocket;
  received: Map<number, number>; // seq → latência ms
}

async function main(): Promise<void> {
  console.log(`Stress real-time — ${CLIENTS} clientes × ${MESSAGES} msgs (janela ${DURATION_MS}ms)`);
  const cookie = await login();
  const workspaceId = await getWorkspaceId(cookie);
  console.log(`Logado. workspace=${workspaceId}`);

  const clients: ClientState[] = [];
  await Promise.all(
    Array.from({ length: CLIENTS }, (_, i) => {
      return new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${WS_URL}`, { headers: { cookie } });
        const state: ClientState = { ws, received: new Map() };
        clients.push(state);
        const to = setTimeout(() => reject(new Error(`cliente ${i} não conectou`)), 10_000);
        ws.on('message', (buf: Buffer) => {
          try {
            const msg = JSON.parse(buf.toString()) as {
              event?: string;
              payload?: { stress?: boolean; seq?: number; publishedAt?: number };
            };
            if (msg.event === 'connected') {
              clearTimeout(to);
              resolve();
              return;
            }
            const p = msg.payload;
            if (p?.stress && typeof p.seq === 'number' && typeof p.publishedAt === 'number') {
              if (!state.received.has(p.seq)) {
                state.received.set(p.seq, Date.now() - p.publishedAt);
              }
            }
          } catch {
            /* ignora */
          }
        });
        ws.on('error', (err) => reject(err));
      });
    }),
  );
  console.log(`${clients.length} clientes conectados. Publicando…`);

  const pub = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  const channel = `workspace:${workspaceId}:messages`;
  const gap = MESSAGES > 1 ? DURATION_MS / (MESSAGES - 1) : 0;
  const t0 = Date.now();
  for (let seq = 0; seq < MESSAGES; seq++) {
    const body = JSON.stringify({
      event: 'stress.msg',
      payload: { stress: true, seq, publishedAt: Date.now() },
      ts: Date.now(),
    });
    await pub.publish(channel, body);
    if (gap > 0 && seq < MESSAGES - 1) await sleep(gap);
  }
  const publishMs = Date.now() - t0;
  console.log(`Publicadas ${MESSAGES} msgs em ${publishMs}ms. Aguardando recebimentos (${WAIT_MS}ms)…`);

  // Espera até todos receberem tudo ou o timeout.
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const totalReceived = clients.reduce((s, c) => s + c.received.size, 0);
    if (totalReceived >= CLIENTS * MESSAGES) break;
    await sleep(100);
  }

  const latencies: number[] = [];
  let received = 0;
  for (const c of clients) {
    received += c.received.size;
    for (const l of c.received.values()) latencies.push(l);
  }
  latencies.sort((a, b) => a - b);
  const expected = CLIENTS * MESSAGES;
  const delivery = expected > 0 ? received / expected : 0;
  const throughput = publishMs > 0 ? (MESSAGES / publishMs) * 1000 : 0;

  console.log('\n──────── RESULTADO ────────');
  console.log(`Entrega:     ${received}/${expected} (${(delivery * 100).toFixed(1)}%)`);
  console.log(`Latência:    p50 ${pct(latencies, 50)}ms · p95 ${pct(latencies, 95)}ms · p99 ${pct(latencies, 99)}ms · max ${latencies.at(-1) ?? 0}ms`);
  console.log(`Throughput:  ${throughput.toFixed(0)} msgs/s (publicação)`);
  console.log('───────────────────────────');

  for (const c of clients) c.ws.close();
  await pub.quit();

  const p95 = pct(latencies, 95);
  const ok = delivery >= MIN_DELIVERY && p95 <= MAX_P95_MS;
  console.log(
    ok
      ? `\n✓ PASS (entrega ≥ ${(MIN_DELIVERY * 100).toFixed(0)}% e p95 ≤ ${MAX_P95_MS}ms)\n`
      : `\n✗ FAIL (entrega ${(delivery * 100).toFixed(1)}% / p95 ${p95}ms vs alvo ${(MIN_DELIVERY * 100).toFixed(0)}% / ${MAX_P95_MS}ms)\n`,
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
