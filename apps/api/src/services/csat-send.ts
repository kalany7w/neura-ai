/**
 * Envia o survey CSAT pra uma conversa específica. Idempotente: se já enviou
 * (csatSentAt set) ou conversa não está mais RESOLVED, skip silencioso.
 *
 * Fluxo:
 * 1. Carrega conversation + inbox + contact + survey
 * 2. Valida estado (RESOLVED + survey enabled + canal compatível)
 * 3. Renderiza placeholders no messageBody via template-render
 * 4. Cria Message OUTBOUND PENDING
 * 5. dispatchOutbound enfileira na queue do canal (Baileys / Telegram / Resend)
 * 6. Marca csatSentAt + csatAwaitingResponseUntil (janela 7d pra resposta)
 * 7. Incrementa survey.sentCount
 */

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { dispatchOutbound } from '../queue.js';
import { publishEvent } from '../redis-pub.js';
import { renderTemplate } from '@neura/shared/template-render';

const AWAITING_WINDOW_DAYS = 7;

interface SendResult {
  status: 'sent' | 'skipped';
  reason?: string;
}

export async function sendCsatSurvey(
  workspaceId: string,
  conversationId: string,
  surveyId: string,
): Promise<SendResult> {
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: {
      id: true,
      status: true,
      inboxId: true,
      csatSentAt: true,
      assignedAgentId: true,
      inbox: { select: { type: true, status: true, name: true } },
      contact: { select: { name: true, phoneNumber: true, email: true } },
    },
  });
  if (!conv) return { status: 'skipped', reason: 'conversation_not_found' };
  if (conv.status !== 'RESOLVED') {
    return { status: 'skipped', reason: 'conversation_no_longer_resolved' };
  }
  if (conv.csatSentAt) {
    return { status: 'skipped', reason: 'already_sent' };
  }
  if (conv.inbox.status !== 'CONNECTED') {
    return { status: 'skipped', reason: 'inbox_not_connected' };
  }

  const survey = await prisma.csatSurvey.findFirst({
    where: { id: surveyId, workspaceId },
  });
  if (!survey || !survey.enabled) {
    return { status: 'skipped', reason: 'survey_disabled' };
  }
  if (survey.channelScope !== 'ALL' && survey.channelScope !== conv.inbox.type) {
    return { status: 'skipped', reason: 'channel_mismatch' };
  }

  // Email exige contact.email; outros canais validamos no worker outbound.
  if (conv.inbox.type === 'EMAIL' && !conv.contact.email) {
    return { status: 'skipped', reason: 'no_contact_email' };
  }

  const renderedBody = renderTemplate(survey.messageBody, {
    contact: {
      name: conv.contact.name,
      phoneNumber: conv.contact.phoneNumber,
    },
    inbox: { name: conv.inbox.name },
  });

  const msg = await prisma.message.create({
    data: {
      conversationId: conv.id,
      direction: 'OUTBOUND',
      type: 'TEXT',
      content: renderedBody,
      status: 'PENDING',
    },
  });

  const now = new Date();
  const awaitingUntil = new Date(now.getTime() + AWAITING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  await prisma.conversation.update({
    where: { id: conv.id },
    data: {
      csatSurveyId: survey.id,
      csatSentAt: now,
      csatAwaitingResponseUntil: awaitingUntil,
      lastMessageAt: msg.createdAt,
      lastOutboundAt: msg.createdAt,
      lastMessagePreview: renderedBody.slice(0, 80),
    },
  });

  await prisma.csatSurvey
    .update({
      where: { id: survey.id },
      data: { sentCount: { increment: 1 } },
    })
    .catch(() => {});

  await dispatchOutbound({
    inboxId: conv.inboxId,
    workspaceId,
    conversationId: conv.id,
    messageId: msg.id,
    to: conv.contact.phoneNumber ?? '',
    type: 'TEXT',
    text: renderedBody,
  });

  await publishEvent(workspaceId, 'messages', 'message.new', {
    conversationId: conv.id,
    message: msg,
  });
  await publishEvent(workspaceId, 'conversations', 'conversation.csat_sent', {
    conversationId: conv.id,
    surveyId: survey.id,
  });

  logger.info(
    {
      conversationId: conv.id,
      surveyId: survey.id,
      channel: conv.inbox.type,
    },
    'CSAT survey sent',
  );

  return { status: 'sent' };
}

/**
 * Resolve qual survey usar pra essa conversa. Prioridade:
 * 1. Survey com channelScope = inbox.type específico, enabled
 * 2. Survey com channelScope = ALL + isDefault, enabled
 * 3. Qualquer survey com channelScope = ALL, enabled (1º criado)
 * Retorna null se nenhum aplica.
 */
export async function resolveSurveyForConversation(
  workspaceId: string,
  inboxType: 'WHATSAPP' | 'TELEGRAM' | 'EMAIL' | 'WEBCHAT',
): Promise<{ id: string } | null> {
  // Tenta canal específico primeiro
  const channelSpecific = await prisma.csatSurvey.findFirst({
    where: { workspaceId, enabled: true, channelScope: inboxType },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: { id: true },
  });
  if (channelSpecific) return channelSpecific;

  // Fallback: survey ALL (com isDefault prioritário)
  const fallback = await prisma.csatSurvey.findFirst({
    where: { workspaceId, enabled: true, channelScope: 'ALL' },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: { id: true },
  });
  return fallback;
}

