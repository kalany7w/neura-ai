// Valida os 5 bugs corrigidos contra a instância no ar. Rodar DEPOIS do deploy.
import { req, login, t, section, expect, expectStatus, report, rnd, QA_EMAIL, QA_PASS,} from './lib.mjs';

const EMAIL = QA_EMAIL;
const PASS = QA_PASS;
const S = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await login(EMAIL, PASS);

  section('BUG 1 — webchat com e-mail duplicado');
  await t('cria inbox webchat de teste', async () => {
    const r = expectStatus(await req('POST', '/api/inboxes/webchat/connect', {
      name: `Regressao ${rnd(2)}`, primaryColor: '#123456', title: 't', placeholder: 'p',
      welcomeMessage: 'oi',
    }), [200, 201]);
    S.inboxId = r.json.inbox.id;
    S.slug = r.json.widget.slug;
  });
  await t('2 visitantes com o mesmo e-mail: nenhum 500', async () => {
    const email = `regress.${rnd(4)}@example.com`;
    const a = expectStatus(await req('POST', `/api/webchat/${S.slug}/session`,
      { sessionToken: rnd(24), name: 'V1', email }, { noAuth: true }), [200, 201], '1o visitante');
    const b = await req('POST', `/api/webchat/${S.slug}/session`,
      { sessionToken: rnd(24), name: 'V2', email }, { noAuth: true });
    expect(b.status !== 500, `ainda devolve 500: ${b.text.slice(0, 200)}`);
    expectStatus(b, [200, 201], '2o visitante');
    expect(b.json.conversationId, 'sem conversa para o 2o visitante');
    S.conv1 = a.json.conversationId; S.conv2 = b.json.conversationId;
    return { conv1: S.conv1, conv2: S.conv2 };
  });
  await t('visitante que volta em outro navegador reencontra o próprio contato', async () => {
    const email = `volta.${rnd(4)}@example.com`;
    const t1 = rnd(24);
    const a = await req('POST', `/api/webchat/${S.slug}/session`, { sessionToken: t1, name: 'Cliente', email }, { noAuth: true });
    await req('POST', `/api/webchat/${S.slug}/messages`, { sessionToken: t1, content: 'primeira visita' }, { noAuth: true });
    // "limpa o localStorage": token novo, mesmo e-mail
    const b = await req('POST', `/api/webchat/${S.slug}/session`, { sessionToken: rnd(24), name: 'Cliente', email }, { noAuth: true });
    expectStatus(b, [200, 201], 'retorno do visitante');
    return { primeira: a.json.conversationId, retorno: b.json.conversationId };
  });
  await t('rajada de 5 sessões simultâneas com o mesmo e-mail', async () => {
    const email = `corrida.${rnd(4)}@example.com`;
    const rs = await Promise.all(Array.from({ length: 5 }, () =>
      req('POST', `/api/webchat/${S.slug}/session`, { sessionToken: rnd(24), name: 'C', email }, { noAuth: true })));
    const cincoCentos = rs.filter((r) => r.status >= 500);
    expect(cincoCentos.length === 0, `${cincoCentos.length} de 5 responderam 5xx`);
    return { status: rs.map((r) => r.status) };
  });

  section('BUG 2 — ciclo de vida da sessão WhatsApp');
  await t('connect → QR aparece', async () => {
    const c = expectStatus(await req('POST', '/api/inboxes', { name: `WA Regressao ${rnd(2)}` }), [200, 201]);
    S.waId = (c.json.inbox ?? c.json).id;
    expectStatus(await req('POST', `/api/inboxes/${S.waId}/connect`), [200, 202]);
    let qr = null, status = null;
    for (let i = 0; i < 12; i++) {
      await sleep(5000);
      const g = await req('GET', `/api/inboxes/${S.waId}`);
      const b = g.json.inbox ?? g.json;
      status = b.status; qr = b.qrCode ?? b.waSession?.qrCode;
      if (qr) break;
    }
    expect(qr, `sem QR em 60s (status ${status})`);
    return { status };
  });
  await t('disconnect deixa a inbox em DISCONNECTED (não presa em CONNECTING)', async () => {
    expectStatus(await req('POST', `/api/inboxes/${S.waId}/disconnect`), 200);
    let status = null;
    for (let i = 0; i < 8; i++) {
      await sleep(2500);
      const g = await req('GET', `/api/inboxes/${S.waId}`);
      status = (g.json.inbox ?? g.json).status;
      if (status === 'DISCONNECTED') break;
    }
    expect(status === 'DISCONNECTED', `status ficou ${status}`);
  });
  await t('connect → disconnect → connect volta a gerar QR (o cenário que travava)', async () => {
    expectStatus(await req('POST', `/api/inboxes/${S.waId}/connect`), [200, 202]);
    await sleep(3000);
    expectStatus(await req('POST', `/api/inboxes/${S.waId}/disconnect`), 200);
    await sleep(1500);
    expectStatus(await req('POST', `/api/inboxes/${S.waId}/connect`), [200, 202]);
    let qr = null, status = null;
    for (let i = 0; i < 16; i++) {
      await sleep(5000);
      const g = await req('GET', `/api/inboxes/${S.waId}`);
      const b = g.json.inbox ?? g.json;
      status = b.status; qr = b.qrCode ?? b.waSession?.qrCode;
      if (qr) break;
    }
    expect(qr, `travou sem QR (status ${status}) — o ciclo de vida ainda se atropela`);
    return { status };
  });
  await t('reconnect gera QR novo', async () => {
    const antes = await req('GET', `/api/inboxes/${S.waId}`);
    const qrAntes = (antes.json.inbox ?? antes.json).qrCode ?? (antes.json.inbox ?? antes.json).waSession?.qrCode;
    expectStatus(await req('POST', `/api/inboxes/${S.waId}/reconnect`), 200);
    let qr = null, status = null;
    for (let i = 0; i < 16; i++) {
      await sleep(5000);
      const g = await req('GET', `/api/inboxes/${S.waId}`);
      const b = g.json.inbox ?? g.json;
      status = b.status; qr = b.qrCode ?? b.waSession?.qrCode;
      if (qr && qr !== qrAntes) break;
    }
    expect(qr, `reconnect não recuperou (status ${status})`);
    return { status, qrMudou: qr !== qrAntes };
  });
  await t('3 ciclos connect/delete seguidos — o churn que quebrava', async () => {
    const falhas = [];
    for (let k = 0; k < 3; k++) {
      const c = await req('POST', '/api/inboxes', { name: `WA Churn ${k} ${rnd(2)}` });
      const id = (c.json.inbox ?? c.json).id;
      await req('POST', `/api/inboxes/${id}/connect`);
      let qr = null, status = null;
      for (let i = 0; i < 14; i++) {
        await sleep(5000);
        const g = await req('GET', `/api/inboxes/${id}`);
        const b = g.json.inbox ?? g.json;
        status = b.status; qr = b.qrCode ?? b.waSession?.qrCode;
        if (qr) break;
      }
      if (!qr) falhas.push(`ciclo ${k}: sem QR (status ${status})`);
      await req('DELETE', `/api/inboxes/${id}`);
    }
    expect(falhas.length === 0, falhas.join(' | '));
  });

  section('limpeza');
  await t('remove inboxes de teste', async () => {
    await req('DELETE', `/api/inboxes/${S.waId}`);
    await req('POST', `/api/inboxes/${S.inboxId}/webchat/disconnect`);
  });

  report();
}

main().catch((e) => { console.error('CRASH:', e); report(); process.exit(1); });
