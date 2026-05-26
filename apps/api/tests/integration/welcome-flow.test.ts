import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { prisma } from '@neura/database';
import { shouldTriggerWelcome, sendWelcome } from '../../src/services/welcome-flow.js';
import { parseReply } from '../../src/services/welcome-parser.js';
import { applyTagWithRouting } from '../../src/services/auto-routing.js';

let workspaceId: string;
let inboxId: string;
let contactId: string;
let conversationId: string;
let flowId: string;
let labelCompra: string;
let labelSuporte: string;
let funnelVendas: string;
let stageVendasLead: string;
let funnelSuporte: string;
let stageSuporteTriagem: string;

beforeAll(async () => {
  // Cleanup
  await prisma.cardLabel.deleteMany();
  await prisma.card.deleteMany();
  await prisma.welcomeOption.deleteMany();
  await prisma.welcomeFlow.deleteMany();
  await prisma.conversationLabel.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.stage.deleteMany();
  await prisma.funnel.deleteMany();
  await prisma.label.deleteMany();
  await prisma.inbox.deleteMany();
  await prisma.workspace.deleteMany();

  const ws = await prisma.workspace.create({
    data: { name: 'E2E Welcome Test', slug: 'e2e-welcome' },
  });
  workspaceId = ws.id;

  const inbox = await prisma.inbox.create({
    data: { workspaceId, name: 'WA E2E', type: 'WHATSAPP', status: 'CONNECTED' },
  });
  inboxId = inbox.id;

  const fv = await prisma.funnel.create({ data: { workspaceId, name: 'Vendas' } });
  funnelVendas = fv.id;
  const sv = await prisma.stage.create({
    data: { funnelId: funnelVendas, name: 'Lead', order: 0 },
  });
  stageVendasLead = sv.id;

  const fs = await prisma.funnel.create({ data: { workspaceId, name: 'Suporte' } });
  funnelSuporte = fs.id;
  const ss = await prisma.stage.create({
    data: { funnelId: funnelSuporte, name: 'Triagem', order: 0 },
  });
  stageSuporteTriagem = ss.id;

  const lc = await prisma.label.create({
    data: {
      workspaceId,
      name: 'Compra',
      color: '#10b981',
      routesToFunnelId: funnelVendas,
      routesToStageId: stageVendasLead,
    },
  });
  labelCompra = lc.id;

  const ls = await prisma.label.create({
    data: {
      workspaceId,
      name: 'Suporte',
      color: '#f59e0b',
      routesToFunnelId: funnelSuporte,
      routesToStageId: stageSuporteTriagem,
    },
  });
  labelSuporte = ls.id;

  const flow = await prisma.welcomeFlow.create({
    data: {
      workspaceId,
      inboxId,
      prompt: 'Olá! Como podemos ajudar?',
      enabled: true,
      maxAttempts: 2,
      options: {
        create: [
          {
            position: 1,
            label: 'Compra',
            matchKeywords: ['comprar', 'quero comprar'],
            targetLabelId: labelCompra,
            targetFunnelId: funnelVendas,
            targetStageId: stageVendasLead,
          },
          {
            position: 2,
            label: 'Suporte',
            matchKeywords: ['ajuda', 'suporte'],
            targetLabelId: labelSuporte,
            targetFunnelId: funnelSuporte,
            targetStageId: stageSuporteTriagem,
          },
        ],
      },
    },
  });
  flowId = flow.id;
});

beforeEach(async () => {
  await prisma.cardLabel.deleteMany();
  await prisma.card.deleteMany();
  await prisma.conversationLabel.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.contact.deleteMany({ where: { workspaceId } });

  const contact = await prisma.contact.create({
    data: { workspaceId, phoneNumber: '+5511987654321', name: 'Cliente E2E' },
  });
  contactId = contact.id;

  const conv = await prisma.conversation.create({
    data: { workspaceId, inboxId, contactId, status: 'OPEN' },
  });
  conversationId = conv.id;
});

describe('Welcome flow E2E', () => {
  it('fluxo completo: trigger → send → reply "1" → tag + card no funil Vendas', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);

    // 1. Trigger
    expect(await shouldTriggerWelcome({ workspaceId, conversationId, contactId })).toBe(true);

    // 2. Send
    await sendWelcome({ workspaceId, conversationId }, { enqueueOutbound: enqueue });
    expect(enqueue).toHaveBeenCalledOnce();

    const conv1 = await prisma.conversation.findUnique({ where: { id: conversationId } });
    expect(conv1?.isAwaitingWelcomeChoice).toBe(true);

    // 3. Cliente responde "1"
    const flow = await prisma.welcomeFlow.findUnique({
      where: { id: flowId },
      include: { options: true },
    });
    const match = await parseReply(
      { kind: 'text', text: '1' },
      flow!.options.map((o) => ({
        id: o.id,
        position: o.position,
        label: o.label,
        matchKeywords: o.matchKeywords,
      })),
    );
    expect(match).not.toBeNull();
    expect(match!.label).toBe('Compra');

    // 4. Apply routing
    const matchedOpt = flow!.options.find((o) => o.id === match!.id);
    await applyTagWithRouting({
      workspaceId,
      conversationId,
      labelId: matchedOpt!.targetLabelId,
      source: 'welcome_flow',
    });

    // 5. Verifica side effects
    const cards = await prisma.card.findMany({ where: { conversationId } });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.funnelId).toBe(funnelVendas);

    const labels = await prisma.conversationLabel.findMany({ where: { conversationId } });
    expect(labels).toHaveLength(1);
    expect(labels[0]?.labelId).toBe(labelCompra);
  });

  it('fluxo paralelo: cliente já tem card em Vendas + responde "suporte" → card paralelo em Suporte', async () => {
    // Setup: simula que conversa já tem card em Vendas
    await prisma.card.create({
      data: {
        workspaceId,
        conversationId,
        funnelId: funnelVendas,
        stageId: stageVendasLead,
        title: 'Card pré-existente',
      },
    });

    const flow = await prisma.welcomeFlow.findUnique({
      where: { id: flowId },
      include: { options: true },
    });
    const match = await parseReply(
      { kind: 'text', text: 'suporte' },
      flow!.options.map((o) => ({
        id: o.id,
        position: o.position,
        label: o.label,
        matchKeywords: o.matchKeywords,
      })),
    );
    expect(match?.label).toBe('Suporte');

    const matchedOpt = flow!.options.find((o) => o.id === match!.id);
    await applyTagWithRouting({
      workspaceId,
      conversationId,
      labelId: matchedOpt!.targetLabelId,
      source: 'welcome_flow',
    });

    const cards = await prisma.card.findMany({ where: { conversationId } });
    expect(cards).toHaveLength(2);
    const funnelIds = cards.map((c) => c.funnelId);
    expect(funnelIds).toContain(funnelVendas);
    expect(funnelIds).toContain(funnelSuporte);
  });
});
