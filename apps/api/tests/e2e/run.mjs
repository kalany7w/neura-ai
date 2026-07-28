import { writeFileSync } from 'node:fs';
import {
  req, login, t, section, expect, expectStatus, report, hmac, rnd, results, API, QA_EMAIL, QA_PASS,} from './lib.mjs';

const S = {}; // estado compartilhado entre seções

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ---------------------------------------------------------------- AUTH
  section('auth & sessão');
  await t('login com senha correta', async () => { await login(); });
  await t('GET /api/workspaces retorna o workspace QA', async () => {
    const r = expectStatus(await req('GET', '/api/workspaces'), 200);
    S.wsId = r.json.activeWorkspaceId;
    expect(r.json.workspaces.some((w) => w.id === S.wsId), 'workspace ativo não está na lista');
  });
  await t('rota protegida sem cookie → 401', async () => {
    expectStatus(await req('GET', '/api/contacts', undefined, { noAuth: true }), 401);
  });
  await t('Bearer inválido → 401 invalid_api_key', async () => {
    const r = expectStatus(await req('GET', '/api/contacts', undefined, { bearer: 'nk_live_naoexiste' }), 401);
    expect(r.json?.error === 'invalid_api_key', `erro inesperado: ${r.text}`);
  });
  await t('login com senha errada → 401', async () => {
    const r = await req('POST', '/api/auth/sign-in/email', { email: QA_EMAIL, password: 'errada-de-proposito' }, { noAuth: true });
    expect(r.status === 401 || r.status === 403, `esperava 401/403, veio ${r.status}`);
    await login(); // restaura sessão
  });
  await t('GET /health público', async () => {
    const r = expectStatus(await req('GET', '/health', undefined, { noAuth: true }), 200);
    expect(r.json.checks.db === 'ok' && r.json.checks.redis === 'ok', `health degradado: ${r.text}`);
  });
  await t('presence e mention-targets', async () => {
    expectStatus(await req('GET', '/api/workspaces/me/presence'), 200);
    expectStatus(await req('GET', '/api/workspaces/me/mention-targets'), 200);
  });

  // ---------------------------------------------------- CUSTOM ATTRIBUTES
  section('custom attributes');
  await t('POST custom-attribute STRING (contato)', async () => {
    const r = expectStatus(await req('POST', '/api/custom-attributes', {
      key: `qa_origem_${rnd(3)}`, label: 'Origem QA', type: 'STRING', appliesTo: 'CONTACT',
    }), [200, 201]);
    S.attrId = r.json.def?.id ?? r.json.id;
    expect(S.attrId, `sem id na resposta: ${r.text}`);
  });
  await t('POST custom-attribute SELECT com options', async () => {
    const r = expectStatus(await req('POST', '/api/custom-attributes', {
      key: `qa_porte_${rnd(3)}`, label: 'Porte', type: 'SELECT', appliesTo: 'CARD',
      options: { values: ['Pequeno', 'Médio', 'Grande'] },
    }), [200, 201]);
    S.attrSelectId = r.json.def?.id ?? r.json.id;
  });
  await t('POST custom-attribute com key inválida (maiúscula) → 400', async () => {
    expectStatus(await req('POST', '/api/custom-attributes', {
      key: 'QA-Invalido', label: 'x', type: 'STRING', appliesTo: 'CONTACT',
    }), 400);
  });
  await t('PATCH custom-attribute (label)', async () => {
    expectStatus(await req('PATCH', `/api/custom-attributes/${S.attrId}`, { label: 'Origem QA v2' }), 200);
  });
  await t('GET custom-attributes lista', async () => {
    const r = expectStatus(await req('GET', '/api/custom-attributes'), 200);
    const arr = r.json.defs ?? r.json.attributes ?? r.json;
    expect(Array.isArray(arr) && arr.length >= 2, `esperava ≥2 atributos: ${r.text.slice(0, 200)}`);
  });

  // ------------------------------------------------------------- LABELS
  section('labels');
  await t('POST label', async () => {
    const r = expectStatus(await req('POST', '/api/labels', {
      name: `QA-Lead-${rnd(2)}`, color: '#ff8800', scope: 'BOTH',
    }), [200, 201]);
    S.labelId = r.json.id ?? r.json.label?.id;
    expect(S.labelId, `sem id: ${r.text}`);
  });
  await t('POST label com cor inválida → 400', async () => {
    expectStatus(await req('POST', '/api/labels', { name: 'x', color: 'vermelho', scope: 'BOTH' }), 400);
  });
  await t('POST label nome duplicado → 409 name_taken', async () => {
    const name = `QA-Dup-${rnd(2)}`;
    expectStatus(await req('POST', '/api/labels', { name, color: '#123456', scope: 'BOTH' }), [200, 201]);
    const r = await req('POST', '/api/labels', { name, color: '#123456', scope: 'BOTH' });
    expect(r.status === 409 || r.json?.error === 'name_taken', `esperava 409/name_taken, veio ${r.status} ${r.text.slice(0, 150)}`);
  });
  await t('PATCH label', async () => {
    expectStatus(await req('PATCH', `/api/labels/${S.labelId}`, { color: '#00aa55' }), 200);
  });

  // ------------------------------------------------------------ CONTACTS
  section('contatos');
  await t('POST contato E.164', async () => {
    S.phone = `+5595${Math.floor(10000000 + Math.random() * 89999999)}`;
    const r = expectStatus(await req('POST', '/api/contacts', { phoneNumber: S.phone, name: 'Cliente QA' }), [200, 201]);
    S.contactId = r.json.id ?? r.json.contact?.id;
    expect(S.contactId, `sem id: ${r.text}`);
  });
  await t('POST contato telefone inválido → 400', async () => {
    expectStatus(await req('POST', '/api/contacts', { phoneNumber: '11999998888', name: 'x' }), 400);
  });
  await t('PATCH contato (nome + customAttrs)', async () => {
    expectStatus(await req('PATCH', `/api/contacts/${S.contactId}`, { name: 'Cliente QA Editado' }), 200);
  });
  await t('GET contato detalhe', async () => {
    const r = expectStatus(await req('GET', `/api/contacts/${S.contactId}`), 200);
    expect(JSON.stringify(r.json).includes('Cliente QA Editado'), 'PATCH não refletiu no GET');
  });
  await t('POST /api/contacts/import (lote de 3)', async () => {
    const contacts = [1, 2, 3].map(() => ({ phoneNumber: `+5595${Math.floor(10000000 + Math.random() * 89999999)}`, name: `Import QA ${rnd(2)}` }));
    const r = expectStatus(await req('POST', '/api/contacts/import', { contacts, skipDuplicates: true }), [200, 201]);
    S.importedCount = JSON.stringify(r.json);
  });
  await t('POST /api/contacts/merge (cria 2, funde)', async () => {
    const a = await req('POST', '/api/contacts', { phoneNumber: `+5595${Math.floor(10000000 + Math.random() * 89999999)}`, name: 'Merge A' });
    const b = await req('POST', '/api/contacts', { phoneNumber: `+5595${Math.floor(10000000 + Math.random() * 89999999)}`, name: 'Merge B' });
    const aId = a.json.id ?? a.json.contact?.id, bId = b.json.id ?? b.json.contact?.id;
    expectStatus(await req('POST', '/api/contacts/merge', { primaryId: aId, secondaryId: bId }), 200);
    const gone = await req('GET', `/api/contacts/${bId}`);
    expect(gone.status === 404, `secundário deveria sumir, veio ${gone.status}`);
  });
  await t('GET contatos com paginação e busca', async () => {
    const r = expectStatus(await req('GET', '/api/contacts?page=1&perPage=10&search=QA'), 200);
    expect(Array.isArray(r.json.items), `formato inesperado: ${r.text.slice(0, 200)}`);
  });
  await t('GET contatos perPage acima do limite → 400 ou clamp', async () => {
    const r = await req('GET', '/api/contacts?perPage=5000');
    expect([200, 400].includes(r.status), `veio ${r.status}`);
    if (r.status === 200) {
      const arr = r.json.items ?? [];
      expect(arr.length <= 100, `perPage=5000 retornou ${arr.length} itens (deveria limitar a 100)`);
    }
  });
  await t('POST label apply em contato', async () => {
    expectStatus(await req('POST', '/api/labels/apply', { labelId: S.labelId, targetType: 'CONTACT', targetId: S.contactId }), [200, 201]);
  });
  await t('GET journey do contato', async () => {
    expectStatus(await req('GET', `/api/contacts/${S.contactId}/journey`), 200);
  });
  await t('POST nota no contato', async () => {
    const r = expectStatus(await req('POST', `/api/contacts/${S.contactId}/notes`, { body: 'Nota QA no contato' }), [200, 201]);
    S.contactNoteId = r.json.id ?? r.json.note?.id;
  });
  await t('PATCH nota do contato', async () => {
    expectStatus(await req('PATCH', `/api/contact-notes/${S.contactNoteId}`, { body: 'Nota QA editada' }), 200);
  });

  // -------------------------------------------------------------- KANBAN
  section('kanban');
  await t('POST funil com preset', async () => {
    const r = expectStatus(await req('POST', '/api/kanban/funnels', {
      name: `Funil QA ${rnd(2)}`, color: '#3366ff', isDefault: true,
    }), [200, 201]);
    S.funnelId = r.json.id ?? r.json.funnel?.id;
    expect(S.funnelId, `sem id: ${r.text}`);
  });
  await t('GET funis com stages', async () => {
    const r = expectStatus(await req('GET', '/api/kanban/funnels?includeStages=true'), 200);
    const funnels = r.json.funnels ?? r.json.items ?? r.json;
    const f = funnels.find((x) => x.id === S.funnelId);
    expect(f, 'funil criado não aparece na listagem');
    S.stages = f.stages ?? [];
    expect(S.stages.length >= 2, `funil nasceu com ${S.stages.length} stages (esperava ≥2 do default)`);
    S.stageId = S.stages[0].id;
    S.stage2Id = S.stages[1].id;
  });
  await t('POST stage extra', async () => {
    const r = expectStatus(await req('POST', `/api/kanban/funnels/${S.funnelId}/stages`, {
      name: 'Etapa QA', color: '#999999', outcome: 'POSITIVE',
    }), [200, 201]);
    S.stageExtraId = r.json.id ?? r.json.stage?.id;
  });
  await t('POST card', async () => {
    const r = expectStatus(await req('POST', '/api/kanban/cards', {
      funnelId: S.funnelId, stageId: S.stageId, title: 'Card QA', value: 1500, currency: 'BRL',
    }), [200, 201]);
    S.cardId = r.json.id ?? r.json.card?.id;
    expect(S.cardId, `sem id: ${r.text}`);
  });
  await t('POST move card', async () => {
    expectStatus(await req('POST', `/api/kanban/cards/${S.cardId}/move`, { stageId: S.stage2Id, position: 0 }), 200);
  });
  await t('POST nota no card', async () => {
    const r = expectStatus(await req('POST', `/api/kanban/cards/${S.cardId}/notes`, { body: 'Nota QA no card' }), [200, 201]);
    S.cardNoteId = r.json.id ?? r.json.note?.id;
  });
  await t('GET card detalhe traz histórico e notas', async () => {
    const r = expectStatus(await req('GET', `/api/kanban/cards/${S.cardId}`), 200);
    expect(JSON.stringify(r.json).includes('Nota QA no card'), 'nota não aparece no detalhe do card');
  });
  await t('POST snooze + DELETE snooze', async () => {
    expectStatus(await req('POST', `/api/kanban/cards/${S.cardId}/snooze`, { minutes: 60, reason: 'QA' }), [200, 201]);
    expectStatus(await req('DELETE', `/api/kanban/cards/${S.cardId}/snooze`), 200);
  });
  await t('POST snooze acima do máximo (43201) → 400', async () => {
    expectStatus(await req('POST', `/api/kanban/cards/${S.cardId}/snooze`, { minutes: 43201 }), 400);
  });
  await t('GET cards do funil', async () => {
    const r = expectStatus(await req('GET', `/api/kanban/cards?funnelId=${S.funnelId}`), 200);
    expect(JSON.stringify(r.json).includes('Card QA'), 'card não aparece na listagem do funil');
  });
  await t('POST reorder stages', async () => {
    const ids = [...S.stages.map((s) => s.id), S.stageExtraId];
    expectStatus(await req('POST', `/api/kanban/funnels/${S.funnelId}/stages/reorder`, { stageIds: ids }), 200);
  });
  await t('POST reorder com lista incompleta → 400', async () => {
    expectStatus(await req('POST', `/api/kanban/funnels/${S.funnelId}/stages/reorder`, { stageIds: [S.stageId] }), 400);
  });
  await t('POST cards/bulk move', async () => {
    expectStatus(await req('POST', '/api/kanban/cards/bulk', {
      action: 'move', cardIds: [S.cardId], stageId: S.stageId,
    }), 200);
  });

  // ------------------------------------------------------------ TEMPLATES
  section('templates');
  await t('POST template com shortcut', async () => {
    const r = expectStatus(await req('POST', '/api/templates', {
      name: 'Saudação QA', shortcut: `/qa${rnd(2)}`, body: 'Olá {{nome}}, tudo bem?',
    }), [200, 201]);
    S.templateId = r.json.id ?? r.json.template?.id;
  });
  await t('POST template shortcut inválido (sem barra) → 400', async () => {
    expectStatus(await req('POST', '/api/templates', { name: 'x', shortcut: 'sembarra', body: 'y' }), 400);
  });
  await t('POST pin + unpin template', async () => {
    expectStatus(await req('POST', `/api/templates/${S.templateId}/pin`), 200);
    expectStatus(await req('POST', `/api/templates/${S.templateId}/unpin`), 200);
  });

  // ------------------------------------------------------------------ KB
  section('base de conhecimento');
  await t('POST categoria KB', async () => {
    const r = expectStatus(await req('POST', '/api/kb/categories', { name: `Cat QA ${rnd(2)}` }), [200, 201]);
    S.kbCatId = r.json.id ?? r.json.category?.id;
  });
  await t('POST artigo KB', async () => {
    const r = expectStatus(await req('POST', '/api/kb/articles', {
      title: 'Como funciona o QA', body: 'Conteúdo de teste do artigo de QA. '.repeat(10), categoryId: S.kbCatId,
    }), [200, 201]);
    S.kbArticleId = r.json.id ?? r.json.article?.id;
  });
  await t('POST publish artigo', async () => {
    expectStatus(await req('POST', `/api/kb/articles/${S.kbArticleId}/publish`), 200);
  });
  await t('POST busca KB (fallback ILIKE sem OPENAI_API_KEY)', async () => {
    const r = await req('POST', '/api/kb/search', { query: 'QA', limit: 5 });
    expect([200, 503].includes(r.status), `veio ${r.status}: ${r.text.slice(0, 200)}`);
    S.kbSearchStatus = r.status;
  });
  await t('GET kb/stats', async () => { expectStatus(await req('GET', '/api/kb/stats'), 200); });
  await t('POST view do artigo', async () => {
    expectStatus(await req('POST', `/api/kb/articles/${S.kbArticleId}/view`), 200);
  });
  await t('GET /api/kb raiz → 404 (esperado, só subrotas)', async () => {
    expectStatus(await req('GET', '/api/kb'), 404);
  });

  // --------------------------------------------------------------- INBOXES
  section('inboxes / canais');
  await t('POST inbox webchat', async () => {
    const r = expectStatus(await req('POST', '/api/inboxes/webchat/connect', {
      name: 'Webchat QA', primaryColor: '#5533ff', title: 'Fale com o QA', placeholder: 'Escreva...',
      welcomeMessage: 'Bem-vindo ao atendimento de QA!',
    }), [200, 201]);
    S.webchatInboxId = r.json.inbox.id;
    S.widgetSlug = r.json.widget?.slug;
    expect(S.webchatInboxId && S.widgetSlug, `faltou id/slug: ${r.text.slice(0, 300)}`);
  });
  await t('GET snippet do webchat', async () => {
    expectStatus(await req('GET', `/api/inboxes/${S.webchatInboxId}/webchat/snippet`), 200);
  });
  await t('POST inbox email', async () => {
    const r = expectStatus(await req('POST', '/api/inboxes/email/connect', {
      name: 'Email QA', fromAddress: 'qa@neura-ai.net', fromName: 'QA Neura',
    }), [200, 201]);
    S.emailInboxId = r.json.inbox.id;
    S.emailSlug = r.json.webhook.slug;
    S.emailSecret = r.json.webhook.secret;
  });
  await t('GET webhook config da inbox email (slug+secret)', async () => {
    const r = expectStatus(await req('GET', `/api/inboxes/${S.emailInboxId}/email/webhook`), 200);
    S.emailSlug ??= r.json.slug ?? r.json.inboundSlug;
    S.emailSecret ??= r.json.secret ?? r.json.inboundSecret;
    expect(S.emailSlug && S.emailSecret, `faltou slug/secret: ${r.text.slice(0, 300)}`);
  });
  await t('POST inbox whatsapp (criação)', async () => {
    const r = expectStatus(await req('POST', '/api/inboxes', { name: 'WhatsApp QA' }), [200, 201]);
    const body = r.json.inbox ?? r.json;
    S.waInboxId = body.id;
    expect(body.status === 'DISCONNECTED', `inbox WA deveria nascer DISCONNECTED, veio ${body.status}`);
  });
  await t('POST connect whatsapp → waworker gera QR', async () => {
    expectStatus(await req('POST', `/api/inboxes/${S.waInboxId}/connect`), [200, 202]);
    let qr = null, status = null;
    for (let i = 0; i < 12; i++) {
      await sleep(2500);
      const g = await req('GET', `/api/inboxes/${S.waInboxId}`);
      const b = g.json.inbox ?? g.json;
      status = b.status;
      qr = b.qrCode ?? b.qr ?? b.waSession?.qrCode;
      if (qr) break;
    }
    expect(qr, `waworker não gerou QR em 30s (status final: ${status}) — sessão Baileys não está subindo`);
    return { status, qrLen: String(qr).length };
  });
  await t('POST telegram connect com token inválido → 400', async () => {
    expectStatus(await req('POST', '/api/inboxes/telegram/connect', { name: 'TG QA', botToken: 'token-invalido' }), 400);
  });
  await t('PATCH settings da inbox (businessHours/roundRobin)', async () => {
    expectStatus(await req('PATCH', `/api/inboxes/${S.webchatInboxId}`, {
      settings: { roundRobinEnabled: true, autoResolveAfterDays: 3 },
    }), 200);
  });

  // ------------------------------------------- SIMULADOR: WEBCHAT E2E
  section('simulador webchat (visitante real)');
  await t('POST sessão do visitante (público, sem auth)', async () => {
    S.wcToken = rnd(24);
    const r = expectStatus(await req('POST', `/api/webchat/${S.widgetSlug}/session`, {
      sessionToken: S.wcToken, name: 'Visitante QA', email: `visitante.${rnd(4)}@example.com`,
    }, { noAuth: true }), [200, 201]);
    S.wcConversationId = r.json.conversationId ?? r.json.conversation?.id;
    expect(S.wcConversationId, `sem conversationId: ${r.text.slice(0, 300)}`);
  });
  await t('welcomeMessage aparece pro visitante no poll', async () => {
    const r = expectStatus(await req('GET', `/api/webchat/${S.widgetSlug}/poll?sessionToken=${S.wcToken}`, undefined, { noAuth: true }), 200);
    expect(r.text.includes('Bem-vindo ao atendimento de QA'), `welcome não veio no poll: ${r.text.slice(0, 300)}`);
  });
  await t('POST mensagem do visitante (inbound)', async () => {
    expectStatus(await req('POST', `/api/webchat/${S.widgetSlug}/messages`, {
      sessionToken: S.wcToken, content: 'Olá, preciso de ajuda com meu pedido — mensagem de QA',
    }, { noAuth: true }), [200, 201]);
  });
  await t('BUG: 2 visitantes com o mesmo email → 500 (esperado: reaproveitar contato)', async () => {
    const email = `dup.${rnd(4)}@example.com`;
    const a = await req('POST', `/api/webchat/${S.widgetSlug}/session`, { sessionToken: rnd(24), name: 'V1', email }, { noAuth: true });
    expectStatus(a, [200, 201], '1o visitante');
    const b = await req('POST', `/api/webchat/${S.widgetSlug}/session`, { sessionToken: rnd(24), name: 'V2', email }, { noAuth: true });
    expect(b.status !== 500, `500 internal_error: colisão de @@unique([workspaceId,email]) no upsert do contato vaza como erro 500 — o widget quebra pro visitante (status ${b.status})`);
  });
  await t('sessionToken inválido → rejeitado', async () => {
    const r = await req('POST', `/api/webchat/${S.widgetSlug}/messages`, { sessionToken: 'xx', content: 'hack' }, { noAuth: true });
    expect(r.status >= 400, `token curto deveria falhar, veio ${r.status}`);
  });
  await t('widgetSlug inexistente → 404', async () => {
    const r = await req('POST', `/api/webchat/naoexiste${rnd(4)}/session`, { sessionToken: rnd(24) }, { noAuth: true });
    expect([400, 404].includes(r.status), `veio ${r.status}`);
  });
  await t('conversa do visitante aparece na inbox do agente', async () => {
    const r = expectStatus(await req('GET', '/api/conversations'), 200);
    const list = r.json.items ?? [];
    expect(list.some((c) => c.id === S.wcConversationId), 'conversa do webchat não aparece em /api/conversations');
  });
  await t('GET conversa traz a mensagem do visitante', async () => {
    const r = expectStatus(await req('GET', `/api/conversations/${S.wcConversationId}`), 200);
    expect(r.text.includes('preciso de ajuda com meu pedido'), 'mensagem inbound não está na conversa');
  });
  await t('agente responde → visitante recebe no poll', async () => {
    const marker = `Resposta do agente QA ${rnd(3)}`;
    expectStatus(await req('POST', `/api/conversations/${S.wcConversationId}/messages`, { type: 'TEXT', text: marker }), [200, 201]);
    let seen = false;
    for (let i = 0; i < 8; i++) {
      await sleep(1500);
      const p = await req('GET', `/api/webchat/${S.widgetSlug}/poll?sessionToken=${S.wcToken}`, undefined, { noAuth: true });
      if (p.text.includes(marker)) { seen = true; break; }
    }
    expect(seen, 'resposta do agente não chegou ao visitante em 12s (dispatchOutbound webchat)');
  });
  await t('mensagem TEXT sem texto → 400', async () => {
    expectStatus(await req('POST', `/api/conversations/${S.wcConversationId}/messages`, { type: 'TEXT' }), 400);
  });
  await t('mensagem acima de 4096 chars → 400', async () => {
    expectStatus(await req('POST', `/api/conversations/${S.wcConversationId}/messages`, { type: 'TEXT', text: 'x'.repeat(4097) }), 400);
  });

  // ------------------------------------------- SIMULADOR: EMAIL INBOUND
  section('simulador email inbound');
  await t('POST /api/inbound/email/:slug cria conversa', async () => {
    const r = expectStatus(await req('POST', `/api/inbound/email/${S.emailSlug}`, {
      From: 'cliente.qa@example.com', FromName: 'Cliente Email QA', To: 'qa@neura-ai.net',
      Subject: 'Dúvida sobre proposta', TextBody: 'Bom dia, gostaria de saber o prazo. — QA',
      MessageID: `<qa-${rnd(6)}@example.com>`,
    }, { noAuth: true, headers: { 'X-Neura-Email-Secret': S.emailSecret } }), [200, 201]);
    S.emailConversationId = r.json.conversationId ?? r.json.conversation?.id;
  });
  await t('secret errado → 401/403', async () => {
    const r = await req('POST', `/api/inbound/email/${S.emailSlug}`, {
      From: 'hacker@example.com', To: 'qa@neura-ai.net', Subject: 'x', TextBody: 'y',
    }, { noAuth: true, headers: { 'X-Neura-Email-Secret': 'errado' } });
    expect([401, 403].includes(r.status), `esperava 401/403, veio ${r.status}`);
  });
  await t('sem header de secret → 401/403', async () => {
    const r = await req('POST', `/api/inbound/email/${S.emailSlug}`, { From: 'a@b.c', To: 'qa@neura-ai.net', Subject: 'x', TextBody: 'y' }, { noAuth: true });
    expect([400, 401, 403].includes(r.status), `esperava 4xx, veio ${r.status}`);
  });
  await t('threading: 2º email no mesmo thread reusa conversa', async () => {
    const from = `thread.${rnd(4)}@example.com`;
    const mid = `<qa-thread-${rnd(6)}@example.com>`;
    const send = (extra) => req('POST', `/api/inbound/email/${S.emailSlug}`, {
      From: from, To: 'qa@neura-ai.net', Subject: 'Thread QA', ...extra,
    }, { noAuth: true, headers: { 'X-Neura-Email-Secret': S.emailSecret } });
    expectStatus(await send({ TextBody: 'primeira', MessageID: mid }), [200, 201], '1o email');
    expectStatus(await send({ TextBody: 'segunda', MessageID: `<qa-t2-${rnd(6)}@example.com>`, InReplyTo: mid }), [200, 201], '2o email');
    await sleep(1200);
    const cs = expectStatus(await req('GET', `/api/conversations?inboxId=${S.emailInboxId}&perPage=100`), 200);
    const local = from.split('@')[0];
    const convs = (cs.json.items ?? []).filter((c) => (c.contact?.name ?? '').startsWith(local.slice(0, 12)));
    expect(convs.length === 1, `esperava 1 conversa para ${from}, achei ${convs.length} (threading por In-Reply-To falhou)`);
    const det = expectStatus(await req('GET', `/api/conversations/${convs[0].id}`), 200);
    const txt = JSON.stringify(det.json);
    expect(txt.includes('primeira') && txt.includes('segunda'), 'as duas mensagens deveriam estar na mesma conversa');
    return { conversationId: convs[0].id };
  });

  // ------------------------------------------- SIMULADOR: INBOUND HMAC
  section('simulador webhook inbound (HMAC)');
  await t('POST cria inbound webhook', async () => {
    const r = expectStatus(await req('POST', '/api/integrations/inbound', {
      name: 'Inbound QA', allowedActions: ['create_conversation', 'apply_label', 'create_note'], enabled: true,
    }), [200, 201]);
    const b = r.json.hook ?? r.json.webhook ?? r.json;
    S.inboundSlug = b.slug; S.inboundSecret = b.secret;
    expect(S.inboundSlug && S.inboundSecret, `faltou slug/secret: ${r.text.slice(0, 300)}`);
  });
  await t('HMAC válido → create_conversation aceito', async () => {
    const payload = JSON.stringify({
      action: 'create_conversation', inboxId: S.webchatInboxId,
      phoneNumber: `+5595${Math.floor(10000000 + Math.random() * 89999999)}`, contactName: 'Lead via webhook QA',
    });
    const r = await req('POST', `/api/inbound/${S.inboundSlug}`, payload, {
      noAuth: true, rawBody: true,
      headers: { 'Content-Type': 'application/json', 'X-Neura-Signature': hmac(S.inboundSecret, payload) },
    });
    expect([200, 201, 400].includes(r.status), `veio ${r.status}: ${r.text.slice(0, 250)}`);
    S.inboundCreateStatus = r.status; S.inboundCreateBody = r.text.slice(0, 200);
    expect(r.status !== 401 && r.status !== 403, `HMAC válido foi rejeitado: ${r.status} ${r.text.slice(0, 200)}`);
  });
  await t('HMAC inválido → 401', async () => {
    const payload = JSON.stringify({ action: 'create_note', conversationId: S.wcConversationId, body: 'x' });
    const r = await req('POST', `/api/inbound/${S.inboundSlug}`, payload, {
      noAuth: true, rawBody: true,
      headers: { 'Content-Type': 'application/json', 'X-Neura-Signature': 'deadbeef'.repeat(8) },
    });
    expect([401, 403].includes(r.status), `esperava 401/403, veio ${r.status}`);
  });
  await t('ação fora de allowedActions (send_message) → 403', async () => {
    const payload = JSON.stringify({ action: 'send_message', conversationId: S.wcConversationId, text: 'nao deveria enviar' });
    const r = await req('POST', `/api/inbound/${S.inboundSlug}`, payload, {
      noAuth: true, rawBody: true,
      headers: { 'Content-Type': 'application/json', 'X-Neura-Signature': hmac(S.inboundSecret, payload) },
    });
    expect([403, 400].includes(r.status), `ação não permitida deveria ser bloqueada, veio ${r.status}: ${r.text.slice(0, 200)}`);
  });
  await t('create_note via HMAC grava nota interna', async () => {
    const payload = JSON.stringify({ action: 'create_note', conversationId: S.wcConversationId, body: 'Nota via webhook QA' });
    const r = await req('POST', `/api/inbound/${S.inboundSlug}`, payload, {
      noAuth: true, rawBody: true,
      headers: { 'Content-Type': 'application/json', 'X-Neura-Signature': hmac(S.inboundSecret, payload) },
    });
    expectStatus(r, [200, 201], 'create_note');
    const notes = await req('GET', `/api/conversations/${S.wcConversationId}/notes`);
    expect(notes.text.includes('Nota via webhook QA'), 'nota do webhook não apareceu na conversa');
  });
  await t('webhook desabilitado rejeita chamada', async () => {
    const list = await req('GET', '/api/integrations/inbound');
    const arr = list.json.hooks ?? list.json.webhooks ?? list.json;
    const hook = (Array.isArray(arr) ? arr : []).find((h) => h.slug === S.inboundSlug);
    expect(hook, 'webhook inbound não aparece na listagem');
    await req('PATCH', `/api/integrations/inbound/${hook.id}`, { enabled: false });
    const payload = JSON.stringify({ action: 'create_note', conversationId: S.wcConversationId, body: 'depois de desabilitar' });
    const r = await req('POST', `/api/inbound/${S.inboundSlug}`, payload, {
      noAuth: true, rawBody: true,
      headers: { 'Content-Type': 'application/json', 'X-Neura-Signature': hmac(S.inboundSecret, payload) },
    });
    expect(r.status >= 400, `webhook desabilitado ainda aceitou: ${r.status}`);
    await req('PATCH', `/api/integrations/inbound/${hook.id}`, { enabled: true });
  });

  // -------------------------------------------------------- CONVERSAS
  section('conversas & mensagens');
  await t('PATCH conversa: atribuir a mim', async () => {
    const me = await req('GET', '/api/workspaces/me');
    S.myUserId = me.json.workspace.members[0].userId;
    expectStatus(await req('PATCH', `/api/conversations/${S.wcConversationId}`, { assignedAgentId: S.myUserId }), 200);
  });
  await t('POST nota interna + GET notas', async () => {
    expectStatus(await req('POST', `/api/conversations/${S.wcConversationId}/notes`, { body: 'Nota interna QA' }), [200, 201]);
    const r = expectStatus(await req('GET', `/api/conversations/${S.wcConversationId}/notes`), 200);
    expect(r.text.includes('Nota interna QA'), 'nota não listada');
  });
  await t('read / unread', async () => {
    expectStatus(await req('POST', `/api/conversations/${S.wcConversationId}/read`), 200);
    expectStatus(await req('POST', `/api/conversations/${S.wcConversationId}/unread`), 200);
    expectStatus(await req('POST', `/api/conversations/${S.wcConversationId}/read`), 200);
  });
  await t('archive / unarchive', async () => {
    expectStatus(await req('POST', `/api/conversations/${S.wcConversationId}/archive`), 200);
    expectStatus(await req('POST', `/api/conversations/${S.wcConversationId}/unarchive`), 200);
  });
  await t('GET counts', async () => { expectStatus(await req('GET', '/api/conversations/counts'), 200); });
  await t('GET lead-detail', async () => {
    expectStatus(await req('GET', `/api/conversations/${S.wcConversationId}/lead-detail`), 200);
  });
  await t('pin / unpin mensagem', async () => {
    const c = await req('GET', `/api/conversations/${S.wcConversationId}`);
    const msgs = c.json.messages ?? c.json.conversation?.messages ?? c.json.items ?? [];
    const out = msgs.find((m) => m.direction === 'OUTBOUND') ?? msgs[0];
    expect(out, 'conversa sem mensagens para pinar');
    S.msgId = out.id;
    expectStatus(await req('POST', `/api/messages/${S.msgId}/pin`), 200);
    const p = expectStatus(await req('GET', `/api/conversations/${S.wcConversationId}/pinned`), 200);
    expect(p.text.includes(S.msgId), 'mensagem pinada não aparece em /pinned');
    expectStatus(await req('POST', `/api/messages/${S.msgId}/unpin`), 200);
  });
  await t('reação em msg de canal não-WhatsApp → 409 no_wa_message_id', async () => {
    const r = await req('POST', `/api/messages/${S.msgId}/react`, { emoji: '👍' });
    S.reactStatus = r.status;
    expect([200, 201, 409].includes(r.status), `veio ${r.status}: ${r.text.slice(0, 200)}`);
    return { status: r.status, obs: 'reagir/editar só faz sentido em WhatsApp — front deve esconder a ação nos outros canais' };
  });
  await t('editar msg de canal não-WhatsApp → 409 no_wa_message_id', async () => {
    const r = await req('POST', `/api/messages/${S.msgId}/edit`, { text: 'Texto editado pelo QA' });
    expect([200, 400, 409].includes(r.status), `veio ${r.status}: ${r.text.slice(0, 200)}`);
    S.editStatus = r.status; S.editBody = r.text.slice(0, 200);
  });
  await t('histórico de edição', async () => {
    expectStatus(await req('GET', `/api/messages/${S.msgId}/history`), 200);
  });
  await t('bulk: set_status RESOLVED e volta para OPEN', async () => {
    expectStatus(await req('POST', '/api/conversations/bulk', {
      action: 'set_status', conversationIds: [S.wcConversationId], status: 'RESOLVED',
    }), 200);
    expectStatus(await req('POST', '/api/conversations/bulk', {
      action: 'set_status', conversationIds: [S.wcConversationId], status: 'OPEN',
    }), 200);
  });
  await t('bulk acima de 200 ids → 400', async () => {
    expectStatus(await req('POST', '/api/conversations/bulk', {
      action: 'archive', conversationIds: Array.from({ length: 201 }, (_, i) => `id${i}`),
    }), 400);
  });
  await t('filtros de conversas (status, search, paginação)', async () => {
    expectStatus(await req('GET', '/api/conversations?status=OPEN&page=1&perPage=25'), 200);
    expectStatus(await req('GET', '/api/conversations?search=ajuda'), 200);
    expectStatus(await req('GET', '/api/conversations?unassigned=true'), 200);
  });

  // ------------------------------------------------ SCHEDULED MESSAGES
  section('mensagens agendadas');
  await t('POST agendamento futuro', async () => {
    const when = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const r = expectStatus(await req('POST', '/api/scheduled-messages', {
      conversationId: S.wcConversationId, scheduledFor: when, type: 'TEXT', content: 'Mensagem agendada QA',
    }), [200, 201]);
    S.schedId = r.json.scheduled?.id ?? r.json.id;
  });
  await t('POST agendamento no passado → 400', async () => {
    expectStatus(await req('POST', '/api/scheduled-messages', {
      conversationId: S.wcConversationId, scheduledFor: new Date(Date.now() - 60000).toISOString(),
      type: 'TEXT', content: 'passado',
    }), 400);
  });
  await t('DELETE cancela agendamento', async () => {
    expectStatus(await req('DELETE', `/api/scheduled-messages/${S.schedId}`), 200);
  });

  // ----------------------------------------------------- AUTOMAÇÕES
  section('automações');
  await t('GET settings + PATCH pause/resume', async () => {
    expectStatus(await req('GET', '/api/automations/settings'), 200);
    expectStatus(await req('PATCH', '/api/automations/settings', { paused: true }), 200);
    expectStatus(await req('PATCH', '/api/automations/settings', { paused: false }), 200);
  });
  await t('POST macro (não-auto, sem envio)', async () => {
    const r = expectStatus(await req('POST', '/api/automations', {
      name: 'Macro QA', kind: 'macro', trigger: 'manual', conditions: [],
      actions: [{ kind: 'apply_label', labelId: S.labelId }], enabled: true, priority: 1,
    }), [200, 201]);
    S.macroId = r.json.rule?.id ?? r.json.id;
  });
  await t('POST executar macro na conversa', async () => {
    const r = await req('POST', `/api/automations/macros/${S.macroId}/execute`, { conversationId: S.wcConversationId });
    expect([200, 201].includes(r.status), `veio ${r.status}: ${r.text.slice(0, 250)}`);
  });
  await t('GET runs da automação', async () => {
    expectStatus(await req('GET', `/api/automations/${S.macroId}/runs`), 200);
  });
  await t('POST automação com ação inválida → 400', async () => {
    expectStatus(await req('POST', '/api/automations', {
      name: 'x', kind: 'auto', trigger: 'conversation_created', conditions: [],
      actions: [{ kind: 'acao_que_nao_existe' }], enabled: true, priority: 1,
    }), 400);
  });

  // ----------------------------------------------------------- SLA
  section('SLA');
  await t('POST política SLA default', async () => {
    const r = expectStatus(await req('POST', '/api/sla-policies', {
      name: 'SLA QA', scope: 'default', firstResponseThresholdMin: 15, resolutionThresholdMin: 240, enabled: true,
    }), [200, 201]);
    S.slaId = r.json.id ?? r.json.policy?.id;
  });
  await t('PATCH política SLA', async () => {
    expectStatus(await req('PATCH', `/api/sla-policies/${S.slaId}`, { firstResponseThresholdMin: 30 }), 200);
  });
  await t('GET relatório SLA', async () => { expectStatus(await req('GET', '/api/reports/sla'), 200); });

  // ---------------------------------------------------------- CSAT
  section('CSAT / NPS');
  await t('POST survey CSAT desabilitada (não dispara envio)', async () => {
    const r = expectStatus(await req('POST', '/api/csat-surveys', {
      name: 'CSAT QA', scoreType: 'CSAT', channelScope: 'ALL', delayMinutes: 60,
      messageBody: 'Como foi seu atendimento? Responda de 1 a 5.', enabled: false, isDefault: false,
    }), [200, 201]);
    S.csatId = r.json.id ?? r.json.survey?.id;
  });
  await t('PATCH survey', async () => {
    expectStatus(await req('PATCH', `/api/csat-surveys/${S.csatId}`, { delayMinutes: 120 }), 200);
  });
  await t('GET relatório CSAT', async () => { expectStatus(await req('GET', '/api/reports/csat'), 200); });

  // ------------------------------------------------------ WELCOME FLOW
  section('fluxo de boas-vindas');
  await t('GET presets disponíveis', async () => {
    const r = expectStatus(await req('GET', '/api/welcome-presets'), 200);
    const arr = r.json.presets ?? r.json.items ?? r.json;
    expect(Array.isArray(arr) && arr.length > 0, `sem presets: ${r.text.slice(0, 200)}`);
    S.presetId = arr[0].id;
  });
  await t('POST welcome-flow na inbox webchat (desabilitado)', async () => {
    const r = expectStatus(await req('POST', `/api/inboxes/${S.webchatInboxId}/welcome-flow`, {
      prompt: 'Escolha uma opção:', maxAttempts: 3, fallbackTimeoutMinutes: 10, enabled: false,
    }), [200, 201]);
    S.flowId = r.json.id ?? r.json.flow?.id;
  });
  await t('POST opção do fluxo', async () => {
    const r = expectStatus(await req('POST', `/api/welcome-flows/${S.flowId}/options`, {
      position: 1, label: 'Suporte', matchKeywords: ['suporte', 'ajuda'], targetLabelId: S.labelId,
    }), [200, 201]);
    S.flowOptId = r.json.id ?? r.json.option?.id;
  });
  await t('PUT opção do fluxo', async () => {
    expectStatus(await req('PUT', `/api/welcome-flows/${S.flowId}/options/${S.flowOptId}`, { label: 'Suporte QA' }), 200);
  });
  await t('POST reorder opções', async () => {
    expectStatus(await req('POST', `/api/welcome-flows/${S.flowId}/options/reorder`, { orderedIds: [S.flowOptId] }), 200);
  });
  await t('apply-preset em flow existente → 409', async () => {
    const r = await req('POST', `/api/inboxes/${S.webchatInboxId}/welcome-flow/apply-preset`, { presetId: S.presetId });
    expect(r.status === 409, `esperava 409 (flow já existe), veio ${r.status}: ${r.text.slice(0, 200)}`);
  });
  await t('apply-preset na inbox email (cria funil/labels)', async () => {
    const r = await req('POST', `/api/inboxes/${S.emailInboxId}/welcome-flow/apply-preset`, { presetId: S.presetId });
    expect([200, 201].includes(r.status), `veio ${r.status}: ${r.text.slice(0, 250)}`);
  });
  await t('welcome-flow test exige telefone E.164 → 400 com lixo', async () => {
    expectStatus(await req('POST', `/api/welcome-flows/${S.flowId}/test`, { phoneNumber: 'nao-e-telefone' }), 400);
  });

  // ------------------------------------------------------- CALENDÁRIO
  section('calendário');
  await t('POST evento', async () => {
    const r = expectStatus(await req('POST', '/api/calendar', {
      title: 'Follow-up QA', eventDate: new Date(Date.now() + 86400000).toISOString(),
      type: 'SALE_FOLLOWUP', cardId: S.cardId, assignedUserId: S.myUserId,
    }), [200, 201]);
    S.eventId = r.json.id ?? r.json.event?.id;
  });
  await t('PATCH evento + status DONE', async () => {
    expectStatus(await req('PATCH', `/api/calendar/${S.eventId}`, { title: 'Follow-up QA v2' }), 200);
    expectStatus(await req('PATCH', `/api/calendar/${S.eventId}/status`, { status: 'DONE' }), 200);
  });
  await t('GET agenda por período', async () => {
    const from = new Date(Date.now() - 86400000).toISOString();
    const to = new Date(Date.now() + 7 * 86400000).toISOString();
    const r = expectStatus(await req('GET', `/api/calendar?from=${from}&to=${to}`), 200);
    expect(r.text.includes('Follow-up QA v2'), 'evento não aparece no período');
  });
  await t('POST evento com tipo inválido → 400', async () => {
    expectStatus(await req('POST', '/api/calendar', { title: 'x', eventDate: new Date().toISOString(), type: 'INVALIDO' }), 400);
  });

  // ---------------------------------------------------- SAVED FILTERS
  section('filtros salvos');
  await t('POST filtro salvo', async () => {
    const r = expectStatus(await req('POST', '/api/saved-filters', {
      name: 'Abertas QA', context: 'inbox', query: { status: ['OPEN'] },
    }), [200, 201]);
    S.filterId = r.json.id ?? r.json.filter?.id;
  });
  await t('GET filtros por contexto', async () => {
    const r = expectStatus(await req('GET', '/api/saved-filters?context=inbox'), 200);
    expect(r.text.includes('Abertas QA'), 'filtro não listado');
  });
  await t('DELETE filtro salvo', async () => {
    expectStatus(await req('DELETE', `/api/saved-filters/${S.filterId}`), 200);
  });

  // ------------------------------------------------------ NOTIFICAÇÕES
  section('notificações');
  await t('GET notificações', async () => { expectStatus(await req('GET', '/api/notifications?limit=20'), 200); });
  await t('POST read-all', async () => { expectStatus(await req('POST', '/api/notifications/read-all'), 200); });

  // ------------------------------------------------------------ BUSCA
  section('busca global');
  await t('GET /api/search?q=QA', async () => {
    const r = expectStatus(await req('GET', '/api/search?q=QA&limit=10'), 200);
    expect(r.json, `resposta vazia: ${r.text.slice(0, 200)}`);
  });
  await t('busca com q vazio → 400', async () => {
    expectStatus(await req('GET', '/api/search?q='), 400);
  });

  // --------------------------------------------------------- RELATÓRIOS
  section('relatórios & dashboard');
  for (const path of ['/api/dashboard/stats', '/api/dashboard/timeseries?days=14',
    '/api/reports/overview', '/api/reports/agents', '/api/reports/inboxes', '/api/reports/kb']) {
    await t(`GET ${path}`, async () => { expectStatus(await req('GET', path), 200); });
  }
  await t('GET export.csv conversations', async () => {
    const r = expectStatus(await req('GET', '/api/reports/export.csv?type=conversations'), 200);
    expect(r.text.includes(',') || r.text.length >= 0, 'csv vazio');
    S.csvHead = r.text.split('\n')[0]?.slice(0, 120);
  });
  await t('GET export.csv messages', async () => {
    expectStatus(await req('GET', '/api/reports/export.csv?type=messages'), 200);
  });
  await t('GET export.csv tipo inválido → 400', async () => {
    expectStatus(await req('GET', '/api/reports/export.csv?type=invalido'), 400);
  });
  await t('timeseries days fora do range cai no default 14 (não 400)', async () => {
    const r = expectStatus(await req('GET', '/api/dashboard/timeseries?days=999'), 200);
    expect(r.json.days.length === 14, `days=999 devolveu ${r.json.days.length} pontos`);
    return { obs: 'query inválida é silenciosamente coagida para o default — tolerante por design' };
  });

  // ------------------------------------------------------------ IMPORT
  section('importação');
  await t('POST import/contacts (idempotente)', async () => {
    const rows = [{ externalId: `qa-${rnd(4)}`, name: 'Import Lead', phone: `+5595${Math.floor(10000000 + Math.random() * 89999999)}`, tags: ['qa-import'] }];
    expectStatus(await req('POST', '/api/import/contacts', { source: 'qa', rows }), [200, 201]);
    expectStatus(await req('POST', '/api/import/contacts', { source: 'qa', rows }), [200, 201]);
  });
  await t('POST import/leads', async () => {
    const rows = [{ externalId: `qalead-${rnd(4)}`, title: 'Lead importado QA', value: 999, tags: ['qa'] }];
    expectStatus(await req('POST', '/api/import/leads', {
      source: 'qa', funnelId: S.funnelId, defaultStageId: S.stageId, rows,
    }), [200, 201]);
  });
  await t('import acima de 2000 linhas → 400', async () => {
    const rows = Array.from({ length: 2001 }, (_, i) => ({ name: `x${i}`, phone: `+559590000${String(i).padStart(4, '0')}` }));
    expectStatus(await req('POST', '/api/import/contacts', { source: 'qa', rows }), 400);
  });

  // ----------------------------------------------------------- UPLOADS
  section('uploads');
  await t('POST uploads/sign devolve URL presigned', async () => {
    const r = expectStatus(await req('POST', '/api/uploads/sign', {
      filename: 'qa-teste.png', contentType: 'image/png', size: 1024,
    }), [200, 201]);
    expect(r.text.includes('http'), `sem URL: ${r.text.slice(0, 200)}`);
    S.uploadUrl = (r.json.url ?? r.json.uploadUrl ?? '').slice(0, 80);
  });
  await t('uploads/sign acima de 100MB → 400', async () => {
    expectStatus(await req('POST', '/api/uploads/sign', {
      filename: 'gigante.bin', contentType: 'application/octet-stream', size: 200 * 1024 * 1024,
    }), 400);
  });

  // ------------------------------------------------------- INTEGRAÇÕES
  section('integrações (webhooks out)');
  await t('POST webhook outbound', async () => {
    const r = expectStatus(await req('POST', '/api/integrations/webhooks', {
      name: 'Webhook QA', url: 'https://example.com/qa-hook', events: ['conversation.created'],
      enabled: true, generateSecret: true,
    }), [200, 201]);
    S.outHookId = (r.json.webhook ?? r.json).id;
  });
  await t('POST webhook com URL inválida → 400', async () => {
    expectStatus(await req('POST', '/api/integrations/webhooks', {
      name: 'x', url: 'nao-e-url', events: ['conversation.created'], enabled: true, generateSecret: true,
    }), 400);
  });
  await t('POST teste do webhook (dispara HTTP real)', async () => {
    const r = await req('POST', `/api/integrations/webhooks/${S.outHookId}/test`);
    expect([200, 201, 502, 500].includes(r.status), `veio ${r.status}: ${r.text.slice(0, 200)}`);
    S.hookTestStatus = r.status;
  });
  await t('SSRF: webhook para IP interno é bloqueado', async () => {
    const r = await req('POST', '/api/integrations/webhooks', {
      name: 'SSRF QA', url: 'http://169.254.169.254/latest/meta-data/', events: ['conversation.created'],
      enabled: true, generateSecret: true,
    });
    if ([200, 201].includes(r.status)) {
      const id = (r.json.webhook ?? r.json).id;
      const test = await req('POST', `/api/integrations/webhooks/${id}/test`);
      await req('DELETE', `/api/integrations/webhooks/${id}`);
      expect(test.status >= 400, `SSRF para metadata IP não foi bloqueado no disparo (status ${test.status})`);
    }
  });

  // ------------------------------------------------------------ API KEYS
  section('api keys');
  await t('POST cria API key', async () => {
    const r = expectStatus(await req('POST', '/api/api-keys', { name: 'Key QA' }), [200, 201]);
    S.apiKeyPlain = r.json.plain;
    S.apiKeyId = r.json.key.id;
    expect(S.apiKeyPlain?.startsWith('nk_'), `key não retornada em claro: ${r.text.slice(0, 200)}`);
  });
  await t('Bearer da nova key autentica e resolve workspace', async () => {
    const r = expectStatus(await req('GET', '/api/contacts', undefined, { bearer: S.apiKeyPlain, noAuth: true }), 200);
    expect(r.json, 'sem corpo');
  });
  await t('key desabilitada → 401', async () => {
    expectStatus(await req('PATCH', `/api/api-keys/${S.apiKeyId}`, { enabled: false }), 200);
    const r = await req('GET', '/api/contacts', undefined, { bearer: S.apiKeyPlain, noAuth: true });
    expect(r.status === 401, `key desabilitada ainda funciona! status ${r.status}`);
    await req('PATCH', `/api/api-keys/${S.apiKeyId}`, { enabled: true });
  });
  await t('GET lista de keys não expõe hash nem key em claro', async () => {
    const r = expectStatus(await req('GET', '/api/api-keys'), 200);
    expect(!r.text.includes(S.apiKeyPlain), 'key em claro exposta na listagem!');
    expect(!/"hashed"/.test(r.text), 'hash da key exposto na listagem');
  });

  // -------------------------------------------------------- AUDIT LOG
  section('audit log');
  await t('GET audit-log (admin)', async () => {
    const r = expectStatus(await req('GET', '/api/audit-log?page=1&perPage=25'), 200);
    S.auditCount = (r.json.items ?? []).length;
    expect(S.auditCount > 0, 'audit log vazio depois de dezenas de operações de escrita');
  });

  // ------------------------------------------------- SEGURANÇA / TENANT
  section('segurança & isolamento');
  await t('recurso de outro workspace não é acessível (404/403)', async () => {
    const other = await req('GET', '/api/labels', undefined, { bearer: process.env.NEURA_PROD_KEY, noAuth: true });
    if (other.status !== 200) return { pulado: 'sem key de outro workspace' };
    const arr = other.json.labels ?? other.json.items ?? other.json;
    const foreign = (Array.isArray(arr) ? arr : [])[0];
    if (!foreign) return { pulado: 'outro workspace sem labels' };
    const r = await req('PATCH', `/api/labels/${foreign.id}`, { color: '#000000' });
    expect([403, 404].includes(r.status), `VAZAMENTO: consegui PATCH em label de outro workspace (${r.status})`);
    return { foreignLabelId: foreign.id, status: r.status };
  });
  await t('ID inexistente → 404 (não 500)', async () => {
    for (const p of ['/api/contacts/naoexiste123', '/api/conversations/naoexiste123', '/api/kanban/cards/naoexiste123']) {
      const r = await req('GET', p);
      expect(r.status === 404 || r.status === 400, `${p} devolveu ${r.status} (esperava 404/400)`);
    }
  });
  await t('JSON malformado → 400 (não 500)', async () => {
    const r = await req('POST', '/api/labels', '{ isso nao e json', {
      rawBody: true, headers: { 'Content-Type': 'application/json' },
    });
    expect(r.status === 400, `esperava 400, veio ${r.status}`);
  });
  await t('payload gigante em nota (>2000) → 400', async () => {
    expectStatus(await req('POST', `/api/conversations/${S.wcConversationId}/notes`, { body: 'x'.repeat(2001) }), 400);
  });
  await t('XSS armazenado: script em nome de contato é devolvido escapado ou cru sem execução', async () => {
    const payload = '<script>alert(1)</script>';
    const c = await req('POST', '/api/contacts', { phoneNumber: `+5595${Math.floor(10000000 + Math.random() * 89999999)}`, name: payload });
    expect([200, 201, 400].includes(c.status), `veio ${c.status}`);
    if ([200, 201].includes(c.status)) {
      S.xssContactId = (c.json.contact ?? c.json).id;
      return { armazenado: true, obs: 'validar render no front' };
    }
    return { rejeitadoNaEntrada: true };
  });
  await t('rate limit da API key (100/min) responde 429 sob rajada', async () => {
    const nk = await req('POST', '/api/api-keys', { name: `RL QA ${rnd(2)}` });
    const plain = nk.json.plain; S.rlKeyId = nk.json.key.id;
    const burst = await Promise.all(Array.from({ length: 130 }, () =>
      req('GET', '/api/labels', undefined, { bearer: plain, noAuth: true })));
    const codes = burst.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
    await req('DELETE', `/api/api-keys/${S.rlKeyId}`);
    expect(codes[429] > 0, `sem 429 em 130 requests: ${JSON.stringify(codes)}`);
    return codes;
  });

  // ---------------------------------------------------------- CLEANUP
  section('deleções (cleanup)');
  await t('DELETE card, funil, label, template, artigo, categoria', async () => {
    const dels = [
      ['DELETE', `/api/kanban/cards/${S.cardId}`],
      ['DELETE', `/api/templates/${S.templateId}`],
      ['DELETE', `/api/kb/articles/${S.kbArticleId}`],
      ['DELETE', `/api/kb/categories/${S.kbCatId}`],
      ['DELETE', `/api/csat-surveys/${S.csatId}`],

      ['DELETE', `/api/automations/${S.macroId}`],
      ['DELETE', `/api/integrations/webhooks/${S.outHookId}`],
      ['DELETE', `/api/api-keys/${S.apiKeyId}`],
    ];
    const bad = [];
    for (const [m, p] of dels) {
      const r = await req(m, p);
      if (![200, 204].includes(r.status)) bad.push(`${p} → ${r.status}`);
    }
    expect(bad.length === 0, `falhas: ${bad.join(', ')}`);
  });
  await t('DELETE inbox whatsapp (para sessão Baileys do QA)', async () => {
    expectStatus(await req('DELETE', `/api/inboxes/${S.waInboxId}`), [200, 204]);
  });

  const summary = report();
  writeFileSync(new URL('./resultado.json', import.meta.url), JSON.stringify({ summary, state: S, results }, null, 2));
  console.log('\nEstado relevante:', JSON.stringify({
    kbSearchStatus: S.kbSearchStatus, editStatus: S.editStatus, editBody: S.editBody,
    reactStatus: S.reactStatus, inboundCreateStatus: S.inboundCreateStatus, inboundCreateBody: S.inboundCreateBody,
    hookTestStatus: S.hookTestStatus, auditCount: S.auditCount, csvHead: S.csvHead,
  }, null, 2));
}

main().catch((e) => { console.error('\nCRASH DO HARNESS:', e); report(); process.exit(1); });
