import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { prisma } from '@neura/database';
import { applyTagWithRouting } from '../src/services/auto-routing.js';

let workspaceId: string;
let inboxId: string;
let contactId: string;
let conversationId: string;
let labelId: string;
let funnelId: string;
let stageId: string;

beforeAll(async () => {
  // Cleanup
  await prisma.cardLabel.deleteMany();
  await prisma.card.deleteMany();
  await prisma.conversationLabel.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.stage.deleteMany();
  await prisma.funnel.deleteMany();
  await prisma.label.deleteMany();
  await prisma.inbox.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.workspace.deleteMany();

  const ws = await prisma.workspace.create({
    data: { name: 'Auto-routing Test WS', slug: 'auto-routing-test' },
  });
  workspaceId = ws.id;

  const inbox = await prisma.inbox.create({
    data: { workspaceId, name: 'WA Test', type: 'WHATSAPP', status: 'CONNECTED' },
  });
  inboxId = inbox.id;

  const funnel = await prisma.funnel.create({
    data: { workspaceId, name: 'Vendas' },
  });
  funnelId = funnel.id;

  const stage = await prisma.stage.create({
    data: { funnelId, name: 'Lead', order: 0 },
  });
  stageId = stage.id;

  const label = await prisma.label.create({
    data: {
      workspaceId,
      name: 'Compra',
      color: '#10b981',
      routesToFunnelId: funnelId,
      routesToStageId: stageId,
    },
  });
  labelId = label.id;

  const contact = await prisma.contact.create({
    data: { workspaceId, phoneNumber: '+5511999998888', name: 'Test Contact' },
  });
  contactId = contact.id;

  const conv = await prisma.conversation.create({
    data: { workspaceId, inboxId, contactId, status: 'OPEN' },
  });
  conversationId = conv.id;
});

afterEach(async () => {
  await prisma.cardLabel.deleteMany();
  await prisma.card.deleteMany();
  await prisma.conversationLabel.deleteMany();
});

describe('applyTagWithRouting', () => {
  it('aplica label na conversa', async () => {
    await applyTagWithRouting({
      workspaceId,
      conversationId,
      labelId,
      source: 'welcome_flow',
    });

    const links = await prisma.conversationLabel.findMany({ where: { conversationId } });
    expect(links).toHaveLength(1);
    expect(links[0]?.labelId).toBe(labelId);
  });

  it('cria card no funil destino quando label tem routing', async () => {
    await applyTagWithRouting({
      workspaceId,
      conversationId,
      labelId,
      source: 'welcome_flow',
    });

    const cards = await prisma.card.findMany({ where: { conversationId } });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.funnelId).toBe(funnelId);
    expect(cards[0]?.stageId).toBe(stageId);
  });

  it('é idempotente — chamar 2x não cria 2 cards', async () => {
    await applyTagWithRouting({ workspaceId, conversationId, labelId, source: 'welcome_flow' });
    await applyTagWithRouting({ workspaceId, conversationId, labelId, source: 'welcome_flow' });

    const cards = await prisma.card.findMany({ where: { conversationId } });
    expect(cards).toHaveLength(1);
  });

  it('cria card paralelo se label rotear pra outro funil', async () => {
    const funnel2 = await prisma.funnel.create({
      data: { workspaceId, name: 'Suporte' },
    });
    const stage2 = await prisma.stage.create({
      data: { funnelId: funnel2.id, name: 'Triagem', order: 0 },
    });
    const label2 = await prisma.label.create({
      data: {
        workspaceId,
        name: 'Manutenção',
        color: '#f59e0b',
        routesToFunnelId: funnel2.id,
        routesToStageId: stage2.id,
      },
    });

    await applyTagWithRouting({ workspaceId, conversationId, labelId, source: 'welcome_flow' });
    await applyTagWithRouting({
      workspaceId,
      conversationId,
      labelId: label2.id,
      source: 'welcome_flow',
    });

    const cards = await prisma.card.findMany({ where: { conversationId } });
    expect(cards).toHaveLength(2);
    expect(new Set(cards.map((c) => c.funnelId))).toEqual(new Set([funnelId, funnel2.id]));
  });

  it('não cria card se label não tem routing configurado', async () => {
    const labelSemRouting = await prisma.label.create({
      data: { workspaceId, name: 'VIP', color: '#a855f7' },
    });

    await applyTagWithRouting({
      workspaceId,
      conversationId,
      labelId: labelSemRouting.id,
      source: 'manual_tag',
    });

    const cards = await prisma.card.findMany({ where: { conversationId } });
    expect(cards).toHaveLength(0);

    const links = await prisma.conversationLabel.findMany({ where: { conversationId } });
    expect(links).toHaveLength(1);
  });
});
