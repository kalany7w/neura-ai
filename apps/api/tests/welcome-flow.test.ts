import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { prisma } from '@neura/database';
import {
  shouldTriggerWelcome,
  sendWelcome,
  markCompleted,
  markFailed,
} from '../src/services/welcome-flow.js';

let workspaceId: string;
let inboxId: string;
let contactId: string;
let conversationId: string;
let flowId: string;
let labelId: string;

beforeAll(async () => {
  // Cleanup das tabelas que vamos usar (em ordem de dependência)
  await prisma.welcomeOption.deleteMany();
  await prisma.welcomeFlow.deleteMany();
  await prisma.conversationLabel.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.cardLabel.deleteMany();
  await prisma.card.deleteMany();
  await prisma.stage.deleteMany();
  await prisma.funnel.deleteMany();
  await prisma.label.deleteMany();
  await prisma.inbox.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.workspace.deleteMany();

  const ws = await prisma.workspace.create({
    data: { name: 'Welcome Flow Test', slug: 'welcome-test' },
  });
  workspaceId = ws.id;

  const inbox = await prisma.inbox.create({
    data: { workspaceId, name: 'WA', type: 'WHATSAPP', status: 'CONNECTED' },
  });
  inboxId = inbox.id;

  const label = await prisma.label.create({
    data: { workspaceId, name: 'Compra', color: '#10b981' },
  });
  labelId = label.id;

  const flow = await prisma.welcomeFlow.create({
    data: {
      workspaceId,
      inboxId,
      prompt: 'Olá! Como podemos ajudar?',
      enabled: true,
      maxAttempts: 2,
      fallbackTimeoutMinutes: 2,
      options: {
        create: [
          { position: 1, label: 'Compra', matchKeywords: ['comprar'], targetLabelId: labelId },
          {
            position: 2,
            label: 'Suporte',
            matchKeywords: ['suporte', 'ajuda'],
            targetLabelId: labelId,
          },
        ],
      },
    },
  });
  flowId = flow.id;
});

// Cleanup welcome-flow rows pra liberar Label.deleteMany() em outros suites
// (welcome_options.targetLabelId tem onDelete: Restrict).
afterAll(async () => {
  await prisma.welcomeOption.deleteMany();
  await prisma.welcomeFlow.deleteMany();
  await prisma.conversationLabel.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.label.deleteMany();
  await prisma.inbox.deleteMany();
  await prisma.workspace.deleteMany();
});

beforeEach(async () => {
  await prisma.conversationLabel.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.contact.deleteMany({ where: { workspaceId } });

  const contact = await prisma.contact.create({
    data: { workspaceId, phoneNumber: '+5511999990001', name: 'Cliente Test' },
  });
  contactId = contact.id;

  const conv = await prisma.conversation.create({
    data: { workspaceId, inboxId, contactId, status: 'OPEN' },
  });
  conversationId = conv.id;
});

describe('shouldTriggerWelcome', () => {
  it('retorna true pra primeira mensagem em conversa nova sem welcome respondido', async () => {
    const result = await shouldTriggerWelcome({ workspaceId, conversationId, contactId });
    expect(result).toBe(true);
  });

  it('retorna false se contato já respondeu welcome antes', async () => {
    await prisma.contact.update({
      where: { id: contactId },
      data: { welcomeRespondedAt: new Date() },
    });
    const result = await shouldTriggerWelcome({ workspaceId, conversationId, contactId });
    expect(result).toBe(false);
  });

  it('retorna false se conversa já está awaiting welcome choice', async () => {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { isAwaitingWelcomeChoice: true },
    });
    const result = await shouldTriggerWelcome({ workspaceId, conversationId, contactId });
    expect(result).toBe(false);
  });

  it('retorna false se inbox não tem flow habilitado', async () => {
    await prisma.welcomeFlow.update({ where: { id: flowId }, data: { enabled: false } });
    const result = await shouldTriggerWelcome({ workspaceId, conversationId, contactId });
    expect(result).toBe(false);

    // Restore pra próximos testes
    await prisma.welcomeFlow.update({ where: { id: flowId }, data: { enabled: true } });
  });
});

describe('sendWelcome', () => {
  it('marca conversa como awaiting + welcomeSentAt + enfileira outbound INTERACTIVE', async () => {
    const enqueueSpy = vi.fn().mockResolvedValue(undefined);
    await sendWelcome({ workspaceId, conversationId }, { enqueueOutbound: enqueueSpy });

    const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
    expect(conv?.isAwaitingWelcomeChoice).toBe(true);
    expect(conv?.welcomeSentAt).not.toBeNull();

    expect(enqueueSpy).toHaveBeenCalledOnce();
    const job = enqueueSpy.mock.calls[0]?.[0];
    expect(job.type).toBe('INTERACTIVE');
    expect(job.interactivePayload.options).toHaveLength(2);
  });
});

describe('markCompleted', () => {
  it('limpa awaiting, marca welcomeRespondedAt no contato, audita', async () => {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { isAwaitingWelcomeChoice: true, welcomeAttempts: 1 },
    });

    await markCompleted({ workspaceId, conversationId, contactId, optionId: 'fake' });

    const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
    expect(conv?.isAwaitingWelcomeChoice).toBe(false);

    const contact = await prisma.contact.findUnique({ where: { id: contactId } });
    expect(contact?.welcomeRespondedAt).not.toBeNull();
  });
});

describe('markFailed', () => {
  it('limpa awaiting + aplica fallbackLabel se configurado', async () => {
    await prisma.welcomeFlow.update({
      where: { id: flowId },
      data: { fallbackLabelId: labelId },
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { isAwaitingWelcomeChoice: true, welcomeAttempts: 2 },
    });

    await markFailed({ workspaceId, conversationId });

    const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
    expect(conv?.isAwaitingWelcomeChoice).toBe(false);

    const links = await prisma.conversationLabel.findMany({ where: { conversationId } });
    expect(links).toHaveLength(1);
    expect(links[0]?.labelId).toBe(labelId);

    // Restore
    await prisma.welcomeFlow.update({ where: { id: flowId }, data: { fallbackLabelId: null } });
  });
});
