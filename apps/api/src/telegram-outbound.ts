/**
 * Telegram outbound worker — consume queue `outbound-telegram`.
 * Envia mensagem via Bot API HTTPS (sem precisar de waworker Baileys).
 *
 * Suporta:
 * - 'message' text/mídia (text via sendMessage; mídia via sendPhoto/sendDocument)
 * - 'reaction' / 'edit' / 'revoke': skip (Bot API tem limitações; pode ser
 *   adicionado depois via editMessageText / deleteMessage)
 *
 * Reply: usa reply_to_message_id quando há quotedWaMessageId (que pra Telegram
 * é na verdade o message_id integer do msg original — campo reaproveitado).
 */

import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_OUTBOUND_TELEGRAM, type SendMessageJob } from '@neura/shared/queue';
import { prisma } from './db.js';
import { publishEvent } from './redis-pub.js';
import { logger } from './logger.js';
import { env } from './env.js';
import { decrypt } from './services/crypto.js';
import { sendMessage, sendPhoto, sendDocument } from './services/telegram-client.js';

const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const telegramOutboundWorker = new Worker<SendMessageJob>(
  QUEUE_OUTBOUND_TELEGRAM,
  async (job: Job<SendMessageJob>) => {
    const { inboxId, workspaceId, conversationId, messageId, type, text, mediaUrl, kind } = job.data;

    // Skip operações que Bot API não suporta bem ainda
    if (kind === 'reaction' || kind === 'edit' || kind === 'revoke') {
      logger.info({ messageId, kind }, 'Telegram outbound: kind not yet supported, skipping');
      return;
    }

    const inbox = await prisma.inbox.findUnique({
      where: { id: inboxId },
      select: { id: true, type: true, channelConfig: true, status: true },
    });
    if (!inbox || inbox.type !== 'TELEGRAM') {
      logger.warn({ inboxId, type: inbox?.type }, 'telegram-outbound: inbox not TELEGRAM, skip');
      return;
    }

    const cfg = (inbox.channelConfig as Record<string, unknown> | null) ?? {};
    const tokenEnc = cfg.botTokenEncrypted as string | undefined;
    if (!tokenEnc) {
      throw new Error(`Inbox ${inboxId} has no botToken`);
    }
    const botToken = decrypt(tokenEnc);

    // Resolve chatId via conversation → contact
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        contact: { select: { telegramChatId: true, name: true } },
      },
    });
    const chatId = conv?.contact.telegramChatId;
    if (!chatId) {
      throw new Error(`Conversation ${conversationId} contact has no telegramChatId`);
    }

    let result: { message_id: number };
    if (type === 'IMAGE' && mediaUrl) {
      result = await sendPhoto({ botToken, chatId, photoUrl: mediaUrl, caption: text });
    } else if ((type === 'DOCUMENT' || type === 'VIDEO' || type === 'AUDIO') && mediaUrl) {
      result = await sendDocument({ botToken, chatId, documentUrl: mediaUrl, caption: text });
    } else {
      result = await sendMessage({
        botToken,
        chatId,
        text: text ?? '',
      });
    }

    // Marca message como SENT + grava telegramMessageId
    const sentAt = new Date();
    const updated = await prisma.message.update({
      where: { id: messageId },
      data: {
        telegramMessageId: result.message_id,
        status: 'SENT',
        sentAt,
      },
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: sentAt },
    });

    await publishEvent(workspaceId, 'messages', 'message.status', {
      messageId: updated.id,
      status: 'SENT',
      telegramMessageId: result.message_id,
      sentAt: sentAt.toISOString(),
    });

    logger.info(
      { messageId: updated.id, telegramMessageId: result.message_id },
      'Telegram message sent',
    );
  },
  { connection: bullConnection, concurrency: 3 },
);

telegramOutboundWorker.on('failed', async (job, err) => {
  if (!job) return;
  const attempts = job.attemptsMade ?? 0;
  const max = job.opts?.attempts ?? 1;
  logger.error(
    { err, jobId: job.id, attempts, max, messageId: job.data.messageId },
    'Telegram outbound job failed',
  );
  if (attempts >= max) {
    await prisma.message
      .update({
        where: { id: job.data.messageId },
        data: { status: 'FAILED' },
      })
      .catch(() => {});
    await publishEvent(job.data.workspaceId, 'messages', 'message.status', {
      messageId: job.data.messageId,
      status: 'FAILED',
      error: err?.message ?? 'send failed',
    }).catch(() => {});
  }
});
