import type { SendMessageJob } from '@neura/shared/queue';
import { prisma } from '../db.js';
import { dispatchOutbound } from '../queue.js';
import { publishEvent } from '../redis-pub.js';
import { logger } from '../logger.js';
import { audit, AUDIT_ACTIONS } from './audit.js';
import { applyTagWithRouting } from './auto-routing.js';

type EnqueueOutboundFn = (job: SendMessageJob) => Promise<void>;

interface SendWelcomeDeps {
  enqueueOutbound?: EnqueueOutboundFn;
}

interface ShouldTriggerParams {
  workspaceId: string;
  conversationId: string;
  contactId: string;
}

/**
 * Decide se vale a pena disparar o welcome flow pra essa primeira mensagem.
 * Retorna false se: contato já respondeu antes, conversa já está aguardando
 * resposta, ou inbox não tem flow habilitado com opções.
 */
export async function shouldTriggerWelcome(params: ShouldTriggerParams): Promise<boolean> {
  const { workspaceId, conversationId, contactId } = params;

  const [contact, conversation] = await Promise.all([
    prisma.contact.findFirst({
      where: { id: contactId, workspaceId },
      select: { welcomeRespondedAt: true },
    }),
    prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: {
        inboxId: true,
        isAwaitingWelcomeChoice: true,
      },
    }),
  ]);

  if (!contact || !conversation) return false;
  if (contact.welcomeRespondedAt) return false;
  if (conversation.isAwaitingWelcomeChoice) return false;

  const flow = await prisma.welcomeFlow.findUnique({
    where: { inboxId: conversation.inboxId },
    select: { enabled: true, options: { select: { id: true }, take: 1 } },
  });

  if (!flow || !flow.enabled) return false;
  if (flow.options.length === 0) return false;

  return true;
}

interface SendWelcomeParams {
  workspaceId: string;
  conversationId: string;
}

/**
 * Envia o welcome: persiste Message do bot (AI_AGENT, OUTBOUND, TEXT pra
 * histórico), marca a conversa como awaiting + welcomeSentAt, enfileira
 * outbound INTERACTIVE (listMessage no Baileys). `deps.enqueueOutbound`
 * existe pra testes — em runtime usa `dispatchOutbound`.
 */
export async function sendWelcome(
  params: SendWelcomeParams,
  deps: SendWelcomeDeps = {},
): Promise<void> {
  const { workspaceId, conversationId } = params;
  const enqueue = deps.enqueueOutbound ?? dispatchOutbound;

  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: {
      inboxId: true,
      contact: { select: { id: true, phoneNumber: true, name: true } },
      inbox: { select: { name: true } },
    },
  });
  if (!conv || !conv.contact?.phoneNumber) {
    logger.warn({ conversationId }, 'sendWelcome: conversa ou contato inválido');
    return;
  }

  const flow = await prisma.welcomeFlow.findUnique({
    where: { inboxId: conv.inboxId },
    include: { options: { orderBy: { position: 'asc' } } },
  });
  if (!flow || !flow.enabled || flow.options.length === 0) {
    logger.warn({ conversationId }, 'sendWelcome: flow não habilitado ou sem opções');
    return;
  }

  // Substituir placeholders no prompt
  const prompt = flow.prompt.replace(
    /\{\{contact\.name\}\}/g,
    conv.contact.name || 'cliente',
  );

  // Persistir Message do bot (AI_AGENT, OUTBOUND, armazenado como TEXT no DB pra histórico visível pro agente)
  const msg = await prisma.message.create({
    data: {
      conversationId,
      direction: 'OUTBOUND',
      type: 'TEXT',
      senderType: 'AI_AGENT',
      content: prompt,
      status: 'PENDING',
    },
  });

  // Marcar conversa awaiting
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      isAwaitingWelcomeChoice: true,
      welcomeSentAt: new Date(),
      welcomeAttempts: { increment: 1 },
    },
  });

  // Enfileirar job INTERACTIVE
  const job: SendMessageJob = {
    inboxId: conv.inboxId,
    workspaceId,
    conversationId,
    messageId: msg.id,
    to: conv.contact.phoneNumber,
    type: 'INTERACTIVE',
    text: prompt,
    interactivePayload: {
      title: 'Atendimento',
      body: prompt,
      buttonText: 'Ver opções',
      options: flow.options.map((o) => ({
        rowId: o.id,
        title: o.label,
        description: o.description ?? undefined,
      })),
    },
  };

  await enqueue(job);

  void audit({
    workspaceId,
    actorId: null,
    action: AUDIT_ACTIONS.WELCOME_TRIGGERED,
    resource: `conversation:${conversationId}`,
    metadata: { flowId: flow.id, optionsCount: flow.options.length },
  });

  await publishEvent(workspaceId, 'conversations', 'welcome.triggered', {
    conversationId,
    messageId: msg.id,
  });
}

interface MarkCompletedParams {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  optionId: string;
}

/**
 * Cliente respondeu uma opção válida. Limpa flag awaiting da conversa e
 * carimba o contato (pra que welcomes futuros — outras conversas — não
 * disparem). Audita + publica evento.
 */
export async function markCompleted(params: MarkCompletedParams): Promise<void> {
  const { workspaceId, conversationId, contactId, optionId } = params;

  await Promise.all([
    prisma.conversation.update({
      where: { id: conversationId },
      data: { isAwaitingWelcomeChoice: false },
    }),
    prisma.contact.update({
      where: { id: contactId },
      data: { welcomeRespondedAt: new Date() },
    }),
  ]);

  void audit({
    workspaceId,
    actorId: null,
    action: AUDIT_ACTIONS.WELCOME_COMPLETED,
    resource: `conversation:${conversationId}`,
    metadata: { optionId },
  });

  await publishEvent(workspaceId, 'conversations', 'welcome.completed', {
    conversationId,
    optionId,
  });
}

interface MarkFailedParams {
  workspaceId: string;
  conversationId: string;
}

/**
 * Esgotou as tentativas sem casar opção. Limpa awaiting, aplica fallbackLabel
 * (se configurado, com roteamento via auto-routing) e libera a conversa
 * pro humano. Audita + publica evento.
 */
export async function markFailed(params: MarkFailedParams): Promise<void> {
  const { workspaceId, conversationId } = params;

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { isAwaitingWelcomeChoice: false },
  });

  // Aplica fallback label se configurado
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { inboxId: true },
  });
  if (!conv) return;

  const flow = await prisma.welcomeFlow.findUnique({
    where: { inboxId: conv.inboxId },
    select: { fallbackLabelId: true },
  });

  if (flow?.fallbackLabelId) {
    await applyTagWithRouting({
      workspaceId,
      conversationId,
      labelId: flow.fallbackLabelId,
      source: 'welcome_flow',
    });
  }

  void audit({
    workspaceId,
    actorId: null,
    action: AUDIT_ACTIONS.WELCOME_FAILED,
    resource: `conversation:${conversationId}`,
    metadata: { fallbackLabelId: flow?.fallbackLabelId ?? null },
  });

  await publishEvent(workspaceId, 'conversations', 'welcome.failed', {
    conversationId,
    fallbackLabelApplied: flow?.fallbackLabelId ?? null,
  });
}

interface RetryAsTextParams {
  workspaceId: string;
  conversationId: string;
}

/**
 * Timeout estourou sem reply: reenvia o prompt em texto plano numerado
 * (1. Compra / 2. Suporte / …) pra clientes em devices que não renderizam
 * listMessage. Idempotente: só dispara 1x por conversa (welcomeFallbackSent).
 */
export async function retryAsText(
  params: RetryAsTextParams,
  deps: SendWelcomeDeps = {},
): Promise<void> {
  const { workspaceId, conversationId } = params;
  const enqueue = deps.enqueueOutbound ?? dispatchOutbound;

  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: {
      inboxId: true,
      welcomeFallbackSent: true,
      contact: { select: { id: true, phoneNumber: true, name: true } },
    },
  });
  if (!conv?.contact?.phoneNumber || conv.welcomeFallbackSent) return;

  const flow = await prisma.welcomeFlow.findUnique({
    where: { inboxId: conv.inboxId },
    include: { options: { orderBy: { position: 'asc' } } },
  });
  if (!flow) return;

  const lines = [
    flow.prompt.replace(/\{\{contact\.name\}\}/g, conv.contact.name || 'cliente'),
    '',
    ...flow.options.map((o) => `${o.position}. ${o.label}`),
    '',
    'Responda com o número da opção desejada.',
  ];
  const textPlain = lines.join('\n');

  const msg = await prisma.message.create({
    data: {
      conversationId,
      direction: 'OUTBOUND',
      type: 'TEXT',
      senderType: 'AI_AGENT',
      content: textPlain,
      status: 'PENDING',
    },
  });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { welcomeFallbackSent: true },
  });

  await enqueue({
    inboxId: conv.inboxId,
    workspaceId,
    conversationId,
    messageId: msg.id,
    to: conv.contact.phoneNumber,
    type: 'TEXT',
    text: textPlain,
  });

  void audit({
    workspaceId,
    actorId: null,
    action: AUDIT_ACTIONS.WELCOME_FALLBACK_SENT,
    resource: `conversation:${conversationId}`,
  });
}
