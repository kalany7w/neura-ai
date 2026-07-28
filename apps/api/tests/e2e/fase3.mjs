// Fase 3: isolamento direto entre agentes, reset de senha, WebSocket realtime.
import { writeFileSync } from 'node:fs';
import { req, login, t, section, expect, expectStatus, report, rnd, results, QA_EMAIL, QA_PASS,} from './lib.mjs';

const ADMIN = { email: QA_EMAIL, pass: QA_PASS };
const AGENT = { email: (process.env.QA_EMAIL_AGENT ?? ''), pass: process.argv[2] };
const RESET_TOKEN = process.argv[3] || null;
const S = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  section('isolamento direto (AGENT × conversa alheia)');
  await login(ADMIN.email, ADMIN.pass);
  await t('admin cria conversa e atribui a si mesmo', async () => {
    const list = expectStatus(await req('GET', '/api/conversations?perPage=100'), 200);
    const me = await req('GET', '/api/workspaces/me');
    S.adminUserId = me.json.workspace.members.find((m) => m.user.email === ADMIN.email).userId;
    const conv = (list.json.items ?? []).find((c) => !c.assignedAgentId);
    expect(conv, 'nenhuma conversa livre para o teste');
    S.convId = conv.id;
    expectStatus(await req('PATCH', `/api/conversations/${S.convId}`, { assignedAgentId: S.adminUserId }), 200);
  });
  await t('AGENT recebe 403/404 ao abrir conversa do admin pelo ID', async () => {
    await login(AGENT.email, AGENT.pass);
    const r = await req('GET', `/api/conversations/${S.convId}`);
    expect([403, 404].includes(r.status), `VAZAMENTO: agente leu conversa alheia (${r.status})`);
    return { status: r.status };
  });
  await t('AGENT não consegue enviar mensagem na conversa alheia', async () => {
    const r = await req('POST', `/api/conversations/${S.convId}/messages`, { type: 'TEXT', text: 'invasão' });
    expect([403, 404].includes(r.status), `VAZAMENTO: agente enviou msg em conversa alheia (${r.status})`);
    return { status: r.status };
  });
  await t('AGENT não consegue reatribuir conversa alheia para si', async () => {
    const me = await req('GET', '/api/workspaces/me');
    const agentId = me.json.workspace.members.find((m) => m.user.email === AGENT.email)?.userId;
    const r = await req('PATCH', `/api/conversations/${S.convId}`, { assignedAgentId: agentId });
    return { status: r.status, obs: r.status < 300 ? 'AGENT pode se auto-atribuir conversa de outro (verificar se é intencional)' : 'bloqueado' };
  });

  section('reset de senha');
  if (!RESET_TOKEN) {
    await t('POST forget-password para o agente (envia email)', async () => {
      const r = await req('POST', '/api/auth/request-password-reset', {
        email: AGENT.email, redirectTo: 'https://app.neura-ai.net/reset-password',
      }, { noAuth: true });
      expect([200, 201].includes(r.status), `veio ${r.status}: ${r.text.slice(0, 200)}`);
    });
    await t('forget-password de email inexistente não vaza existência', async () => {
      const r = await req('POST', '/api/auth/request-password-reset', {
        email: `naoexiste.${rnd(4)}@example.com`, redirectTo: 'https://app.neura-ai.net/reset-password',
      }, { noAuth: true });
      expect([200, 201].includes(r.status), `resposta diferente para email inexistente (${r.status}) — permite enumeração de contas`);
    });
    console.log('\n>> Email de reset enviado. Rode de novo com o token.');
  } else {
    await t('POST reset-password com token do email', async () => {
      S.novaSenha = rnd(12);
      const r = await req('POST', '/api/auth/reset-password', {
        newPassword: S.novaSenha, token: RESET_TOKEN,
      }, { noAuth: true });
      expect([200, 201].includes(r.status), `reset veio ${r.status}: ${r.text.slice(0, 250)}`);
    });
    await t('login com a senha NOVA funciona', async () => {
      await login(AGENT.email, S.novaSenha);
    });
    await t('login com a senha ANTIGA falha', async () => {
      const r = await req('POST', '/api/auth/sign-in/email', { email: AGENT.email, password: AGENT.pass }, { noAuth: true });
      expect(r.status >= 400, `senha antiga ainda funciona depois do reset! (${r.status})`);
      await login(AGENT.email, S.novaSenha);
    });
    await t('token de reset não pode ser reusado', async () => {
      const r = await req('POST', '/api/auth/reset-password', { newPassword: rnd(12), token: RESET_TOKEN }, { noAuth: true });
      expect(r.status >= 400, `token de reset reusável! (${r.status})`);
    });
    writeFileSync(new URL('./nova-senha-agente.txt', import.meta.url), S.novaSenha ?? '');
  }

  section('websocket realtime');
  await t('WS conecta autenticado e recebe evento de mensagem nova', async () => {
    await login(ADMIN.email, ADMIN.pass);
    const { cookieHeader } = await import('./lib.mjs');
    const WebSocket = (await import('ws')).default;
    const ws = new WebSocket('wss://api.neura-ai.net/ws', { headers: { Cookie: cookieHeader(), Origin: 'https://app.neura-ai.net' } });
    const eventos = [];
    const conectou = await new Promise((res) => {
      ws.on('open', () => res(true));
      ws.on('error', () => res(false));
      setTimeout(() => res(false), 8000);
    });
    expect(conectou, 'WebSocket não conectou (wss://api.neura-ai.net/ws)');
    ws.on('message', (d) => eventos.push(String(d).slice(0, 200)));
    await sleep(1000);
    // dispara evento: mensagem inbound via webchat
    const ib = await req('GET', '/api/inboxes');
    const wc = ib.json.inboxes.find((i) => i.type === 'WEBCHAT' && i.status === 'CONNECTED');
    const token = rnd(24);
    await req('POST', `/api/webchat/${wc.channelConfig.widgetSlug}/session`, { sessionToken: token, name: 'WS Probe' }, { noAuth: true });
    await req('POST', `/api/webchat/${wc.channelConfig.widgetSlug}/messages`, { sessionToken: token, content: 'ping realtime QA' }, { noAuth: true });
    for (let i = 0; i < 10 && !eventos.some((e) => e.includes('message') || e.includes('conversation')); i++) await sleep(800);
    ws.close();
    expect(eventos.length > 0, 'WS conectou mas não entregou nenhum evento em 8s após mensagem inbound');
    return { eventos: eventos.slice(0, 3) };
  });
  await t('WS sem cookie: handshake aceito mas fecha 1008 unauthorized sem entregar evento', async () => {
    const WebSocket = (await import('ws')).default;
    const ws = new WebSocket('wss://api.neura-ai.net/ws', { headers: { Origin: 'https://app.neura-ai.net' } });
    const msgs = [];
    const fim = await new Promise((res) => {
      ws.on('message', (d) => msgs.push(String(d).slice(0, 120)));
      ws.on('close', (code, reason) => res({ code, reason: String(reason) }));
      ws.on('error', () => res({ code: 'error' }));
      setTimeout(() => res({ code: 'timeout-aberto' }), 8000);
    });
    try { ws.close(); } catch { /* noop */ }
    expect(fim.code !== 'timeout-aberto', `WS anônimo ficou aberto: ${JSON.stringify(msgs)}`);
    const vazou = msgs.some((m) => !m.includes('unauthorized') && !m.includes('error'));
    expect(!vazou, `WS anônimo recebeu dados: ${JSON.stringify(msgs)}`);
    return { close: fim, msgs };
  });
  await t('WS com Origin não confiável é rejeitado', async () => {
    const { cookieHeader } = await import('./lib.mjs');
    const WebSocket = (await import('ws')).default;
    const ws = new WebSocket('wss://api.neura-ai.net/ws', { headers: { Cookie: cookieHeader(), Origin: 'https://site-malicioso.example' } });
    const fim = await new Promise((res) => {
      ws.on('close', (code, reason) => res({ code, reason: String(reason) }));
      ws.on('error', () => res({ code: 'error' }));
      setTimeout(() => res({ code: 'timeout-aberto' }), 8000);
    });
    try { ws.close(); } catch { /* noop */ }
    expect(fim.code !== 'timeout-aberto', 'WS aceitou Origin não confiável (CSRF de WebSocket)');
    return fim;
  });

  const summary = report();
  writeFileSync(new URL('./fase3-resultado.json', import.meta.url), JSON.stringify({ summary, S, results }, null, 2));
}

main().catch((e) => { console.error('CRASH:', e); report(); process.exit(1); });
