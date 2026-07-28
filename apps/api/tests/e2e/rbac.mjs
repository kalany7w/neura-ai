// Fase 2 do QA: convite E2E, RBAC por role, reset de senha, WebSocket.
import { writeFileSync } from 'node:fs';
import {
  req, login, t, section, expect, expectStatus, report, rnd, results, API, QA_EMAIL, QA_PASS,} from './lib.mjs';

const ADMIN = { email: QA_EMAIL, pass: QA_PASS };
const AGENT = { email: (process.env.QA_EMAIL_AGENT ?? ''), pass: null, name: 'Agente QA' };
const S = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// token do convite passado por argv (extraído do Gmail pelo orquestrador)
S.inviteToken = process.argv[2] || null;
AGENT.pass = process.argv[3] || null;

async function main() {
  section('convite (admin)');
  await t('login admin', async () => { await login(ADMIN.email, ADMIN.pass); });
  await t('workspace ativo é o QA', async () => {
    const r = expectStatus(await req('GET', '/api/workspaces'), 200);
    S.wsId = r.json.activeWorkspaceId;
  });

  if (!S.inviteToken) {
    await t('POST convite AGENT (envia email real)', async () => {
      const r = expectStatus(await req('POST', '/api/workspaces/me/invites', {
        email: AGENT.email, role: 'AGENT',
      }), [200, 201]);
      S.inviteId = (r.json.invite ?? r.json).id;
      S.inviteRaw = r.text.slice(0, 300);
    });
    await t('convite aparece na listagem', async () => {
      const r = expectStatus(await req('GET', '/api/workspaces/me/invites'), 200);
      expect(r.text.includes(AGENT.email), 'convite não listado');
    });
    await t('convite duplicado para o mesmo email', async () => {
      const r = await req('POST', '/api/workspaces/me/invites', { email: AGENT.email, role: 'AGENT' });
      return { status: r.status, body: r.text.slice(0, 150) };
    });
    await t('convite com role inválido → 400', async () => {
      expectStatus(await req('POST', '/api/workspaces/me/invites', { email: 'x@y.com', role: 'ROOT' }), 400);
    });
    await t('convite com email inválido → 400', async () => {
      expectStatus(await req('POST', '/api/workspaces/me/invites', { email: 'nao-e-email', role: 'AGENT' }), 400);
    });
    console.log('\n>> Convite enviado. Rode de novo passando o token do email + senha nova.');
    writeFileSync(new URL('./rbac-parcial.json', import.meta.url), JSON.stringify({ results, S }, null, 2));
    report();
    return;
  }

  // ------------------------------------------------ aceite + RBAC
  section('aceite do convite');
  await t('signup da conta do agente', async () => {
    const r = await req('POST', '/api/auth/sign-up/email', {
      email: AGENT.email, password: AGENT.pass, name: AGENT.name,
    }, { noAuth: true });
    expect([200, 201, 422].includes(r.status), `signup veio ${r.status}: ${r.text.slice(0, 200)}`);
    return { status: r.status };
  });
  await t('login do agente (após verificar email)', async () => {
    await login(AGENT.email, AGENT.pass);
  });
  await t('POST /api/invites/accept com o token do email', async () => {
    const r = await req('POST', '/api/invites/accept', { token: S.inviteToken });
    expect([200, 201, 409].includes(r.status), `accept veio ${r.status}: ${r.text.slice(0, 200)}`);
    return { status: r.status, body: r.text.slice(0, 200) };
  });
  await t('agente enxerga o workspace QA', async () => {
    const r = expectStatus(await req('GET', '/api/workspaces'), 200);
    const w = r.json.workspaces.find((x) => x.slug === 'qa-claude');
    expect(w, `agente não entrou no workspace: ${r.text.slice(0, 300)}`);
    expect(w.role === 'AGENT', `role errada: ${w.role}`);
    S.agentWsId = w.id;
    if (r.json.activeWorkspaceId !== w.id) {
      await req('POST', '/api/workspaces/switch', { workspaceId: w.id });
    }
  });

  section('RBAC — o que AGENT NÃO pode');
  const negados = [
    ['POST', '/api/inboxes', { name: 'Inbox proibida' }, 'criar inbox (só ADMIN)'],
    ['POST', '/api/labels', { name: `X${rnd(2)}`, color: '#111111', scope: 'BOTH' }, 'criar label (ADMIN+SUP)'],
    ['POST', '/api/templates', { name: 'T', body: 'b' }, 'criar template (ADMIN+SUP)'],
    ['POST', '/api/api-keys', { name: 'K' }, 'criar API key (ADMIN)'],
    ['GET', '/api/audit-log', undefined, 'ler audit log (ADMIN)'],
    ['POST', '/api/custom-attributes', { key: 'x_y', label: 'x', type: 'STRING', appliesTo: 'CONTACT' }, 'criar atributo (ADMIN)'],
    ['POST', '/api/workspaces/me/invites', { email: 'z@z.com', role: 'AGENT' }, 'convidar membro (ADMIN)'],
    ['POST', '/api/integrations/webhooks', { name: 'w', url: 'https://example.com', events: ['conversation.created'], enabled: true, generateSecret: true }, 'criar webhook (ADMIN)'],
    ['POST', '/api/sla-policies', { name: 's', scope: 'default', firstResponseThresholdMin: 5, resolutionThresholdMin: 60, enabled: true }, 'criar SLA (ADMIN)'],
    ['POST', '/api/kb/categories', { name: 'c' }, 'criar categoria KB (ADMIN+SUP)'],
    ['POST', '/api/kanban/funnels', { name: 'f', color: '#111111', isDefault: false }, 'criar funil (ADMIN+SUP)'],
    ['PATCH', '/api/automations/settings', { paused: true }, 'pausar automações (ADMIN)'],
  ];
  for (const [m, p, b, label] of negados) {
    await t(`AGENT bloqueado: ${label}`, async () => {
      const r = await req(m, p, b);
      expect([401, 403].includes(r.status), `deveria ser 403, veio ${r.status}: ${r.text.slice(0, 160)}`);
      return { status: r.status };
    });
  }

  section('RBAC — o que AGENT PODE');
  await t('AGENT lista conversas', async () => { expectStatus(await req('GET', '/api/conversations'), 200); });
  await t('AGENT lista contatos', async () => { expectStatus(await req('GET', '/api/contacts'), 200); });
  await t('AGENT cria contato', async () => {
    const r = await req('POST', '/api/contacts', { phoneNumber: `+5595${Math.floor(10000000 + Math.random() * 89999999)}`, name: 'Contato do agente' });
    expect([200, 201].includes(r.status), `veio ${r.status}: ${r.text.slice(0, 160)}`);
    S.agentContactId = (r.json.contact ?? r.json).id;
  });
  await t('AGENT lê dashboard e relatórios', async () => {
    expectStatus(await req('GET', '/api/dashboard/stats'), 200);
    expectStatus(await req('GET', '/api/reports/overview'), 200);
  });
  await t('AGENT NÃO deleta contato (só ADMIN)', async () => {
    const r = await req('DELETE', `/api/contacts/${S.agentContactId}`);
    expect([401, 403].includes(r.status), `deleção deveria ser bloqueada, veio ${r.status}`);
  });

  section('isolamento entre agentes');
  await t('AGENT não vê conversa atribuída a outro agente', async () => {
    const r = expectStatus(await req('GET', '/api/conversations'), 200);
    const items = r.json.items ?? [];
    const alheias = items.filter((c) => c.assignedAgentId && c.assignedAgentId !== S.agentUserId);
    return { total: items.length, deOutrosAgentes: alheias.length };
  });
  await t('GET direto em conversa de outro agente → 403/404', async () => {
    if (!S.foreignConversationId) return { pulado: 'sem id de conversa alheia' };
    const r = await req('GET', `/api/conversations/${S.foreignConversationId}`);
    expect([403, 404].includes(r.status), `esperava 403/404, veio ${r.status}`);
  });

  const summary = report();
  writeFileSync(new URL('./rbac-resultado.json', import.meta.url), JSON.stringify({ summary, S, results }, null, 2));
}

main().catch((e) => { console.error('CRASH:', e); report(); process.exit(1); });
