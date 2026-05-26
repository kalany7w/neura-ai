/**
 * Telegram webhook receiver — público (sem auth), validado por:
 * - slug na URL (random 32 hex, criado no connect)
 * - X-Telegram-Bot-Api-Secret-Token header (random 48 hex)
 *
 * Recebe Update do Telegram, processa Message inbound, cria Contact + Conversation + Message.
 */

import { Hono } from 'hono';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { publishEvent } from '../redis-pub.js';
import { aiQueue } from '../queue.js';
import { patchFirstResponse } from '../services/sla-compute.js';
import { enqueueWelcomeProcess } from '../welcome-worker.js';
import type { TgUpdate, TgMessage } from '../services/telegram-client.js';

export const telegramRouter = new Hono();

telegramRouter.post('/webhook/:slug', async (c) => {
  const slug = c.req.param('slug');

  // Acha inbox pelo slug (channelConfig.webhookSlug)
  // Prisma JSONB query: usa $queryRaw porque path filter precisa SQL nativo
  const inboxes = await prisma.$queryRaw<
    Array<{
      id: string;
      workspaceId: string;
      status: string;
      channelConfig: unknown;
    }>
  >`
    SELECT "id", "workspaceId", "status", "channelConfig"
    FROM "inboxes"
    WHERE "type" = 'TELEGRAM'
      AND "channelConfig"->>'webhookSlug' = ${slug}
    LIMIT 1
  `;
  const inbox = inboxes[0];
  if (!inbox) {
    logger.warn({ slug }, 'Telegram webhook: slug not found');
    return c.json({ ok: false }, 404);
  }

  const cfg = (inbox.channelConfig as Record<string, unknown> | null) ?? {};
  const expectedSecret = cfg.secretToken as string | undefined;
  const headerSecret = c.req.header('X-Telegram-Bot-Api-Secret-Token');
  if (expectedSecret && headerSecret !== expectedSecret) {
    logger.warn({ inboxId: inbox.id }, 'Telegram webhook: invalid secret token');
    return c.json({ ok: false }, 403);
  }

  if (inbox.status !== 'CONNECTED') {
    // Aceita mesmo desconectado pra não perder updates — só loga
    logger.warn({ inboxId: inbox.id, status: inbox.status }, 'Telegram webhook on disconnected inbox');
  }

  const update = (await c.req.json().catch(() => null)) as TgUpdate | null;
  if (!update) return c.json({ ok: false }, 400);

  // Responde rápido pro Telegram não fazer retry. Processa em background.
  void processUpdate(inbox.workspaceId, inbox.id, update).catch((err) => {
    logger.error({ err, inboxId: inbox.id }, 'Telegram update processing failed');
  });

  return c.json({ ok: true });
});

async function processUpdate(
  workspaceId: string,
  inboxId: string,
  update: TgUpdate,
): Promise<void> {
  const msg = update.message ?? update.edited_message;
  if (!msg) return;

  // Mapeia tipo do conteúdo
  const { contentType, contentText } = inferContent(msg);

  // Upsert Contact por telegramChatId
  const chatId = String(msg.chat.id);
  const tgUser = msg.from;
  const displayName =
    [tgUser?.first_name, tgUser?.last_name].filter(Boolean).join(' ').trim() ||
    msg.chat.first_name ||
    msg.chat.username ||
    `Telegram ${chatId}`;

  const contact = await prisma.contact.upsert({
    where: {
      workspaceId_telegramChatId: { workspaceId, telegramChatId: chatId },
    },
    create: {
      workspaceId,
      telegramChatId: chatId,
      name: displayName,
    },
    update: { name: displayName },
  });

  // Find/create Conversation OPEN/PENDING/SNOOZED
  let conversation = await prisma.conversation.findFirst({
    where: {
      workspaceId,
      inboxId,
      contactId: contact.id,
      status: { in: ['OPEN', 'PENDING', 'SNOOZED'] },
    },
    orderBy: { lastMessageAt: 'desc' },
  });
  const isNewConversation = !conversation;
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        workspaceId,
        inboxId,
        contactId: contact.id,
        status: 'OPEN',
      },
    });

    // Auto-cria card no funil default
    const defaultFunnel = await prisma.funnel.findFirst({
      where: { workspaceId, isDefault: true },
      include: { stages: { orderBy: { order: 'asc' }, take: 1 } },
    });
    if (defaultFunnel?.stages[0]) {
      await prisma.card.create({
        data: {
          workspaceId,
          funnelId: defaultFunnel.id,
          stageId: defaultFunnel.stages[0].id,
          conversationId: conversation.id,
          title: displayName,
          position: 0,
        },
      });
    }
  }

  // Cria Message INBOUND
  const created = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      telegramMessageId: msg.message_id,
      direction: 'INBOUND',
      type: contentType,
      content: contentText,
      status: 'DELIVERED',
      sentAt: new Date(msg.date * 1000),
    },
  });

  // Atualiza cache da conversation
  const preview = contentText ? contentText.slice(0, 60) : `[${contentType.toLowerCase()}]`;
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      lastMessageAt: created.createdAt,
      lastMessagePreview: preview,
      lastInboundAt: created.createdAt,
      unreadCount: { increment: 1 },
      archivedAt: null,
    },
  });
  await prisma.card.updateMany({
    where: { conversationId: conversation.id },
    data: {
      lastMessageAt: created.createdAt,
      lastMessagePreview: preview,
      unreadCount: { increment: 1 },
    },
  });

  // WS events
  await publishEvent(workspaceId, 'messages', 'message.new', {
    conversationId: conversation.id,
    message: created,
  });
  await publishEvent(workspaceId, 'conversations', 'conversation.updated', {
    conversationId: conversation.id,
    lastMessageAt: created.createdAt,
    unreadDelta: 1,
  });
  if (isNewConversation) {
    await publishEvent(workspaceId, 'conversations', 'conversation.created', {
      conversationId: conversation.id,
      contactId: contact.id,
      inboxId,
    });
  }

  // IA Copilot: enfileira classify (debounce 30s)
  void aiQueue
    .add(
      'classify',
      { workspaceId, kind: 'classify', targetId: conversation.id },
      { jobId: `classify__${conversation.id}`, delay: 30_000 },
    )
    .catch(() => {});
  // SLA breach reset não precisa aqui — patchFirstResponse limpa ao agente responder
  void patchFirstResponse; // no-op import keeper

  // Welcome flow hook: se conversa está awaiting choice, rotear msg pro parser.
  const convCheck = await prisma.conversation.findFirst({
    where: { id: conversation.id, workspaceId },
    select: { isAwaitingWelcomeChoice: true },
  });
  if (convCheck?.isAwaitingWelcomeChoice) {
    await enqueueWelcomeProcess({
      workspaceId,
      conversationId: conversation.id,
      kind: 'parse_reply',
      messageId: created.id,
    });
  }
}

function inferContent(msg: TgMessage): {
  contentType:
    | 'TEXT'
    | 'IMAGE'
    | 'VIDEO'
    | 'AUDIO'
    | 'DOCUMENT'
    | 'STICKER'
    | 'LOCATION'
    | 'SYSTEM';
  contentText: string | null;
} {
  if (msg.text) return { contentType: 'TEXT', contentText: msg.text };
  if (msg.photo && msg.photo.length > 0) {
    return { contentType: 'IMAGE', contentText: msg.caption ?? null };
  }
  if (msg.video) return { contentType: 'VIDEO', contentText: msg.caption ?? null };
  if (msg.voice || msg.audio) {
    return { contentType: 'AUDIO', contentText: msg.caption ?? null };
  }
  if (msg.document) {
    return {
      contentType: 'DOCUMENT',
      contentText: msg.caption ?? msg.document.file_name ?? null,
    };
  }
  if (msg.sticker) {
    return { contentType: 'STICKER', contentText: msg.sticker.emoji ?? null };
  }
  if (msg.location) {
    return {
      contentType: 'LOCATION',
      contentText: `${msg.location.latitude},${msg.location.longitude}`,
    };
  }
  return { contentType: 'TEXT', contentText: null };
}
