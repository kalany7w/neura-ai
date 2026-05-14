import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_OUTBOUND, type SendMessageJob } from '@neura/shared/queue';
import { sessionManager } from '../baileys/manager';
import { prisma } from '../db';
import { publishEvent } from '../redis';
import { logger } from '../logger';
import { env } from '../env';
import { getMediaBuffer, keyFromUrl } from '../storage';

// BullMQ exige conexão dedicada com maxRetriesPerRequest=null
const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

function toJid(to: string): string {
  if (to.includes('@')) return to;
  const digits = to.replace(/^\+/, '').replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

async function fetchMediaBuffer(mediaUrl: string): Promise<Buffer> {
  const key = keyFromUrl(mediaUrl);
  if (!key) throw new Error(`Cannot resolve S3 key from URL: ${mediaUrl}`);
  return getMediaBuffer(key);
}

export const outboundWorker = new Worker<SendMessageJob>(
  QUEUE_OUTBOUND,
  async (job: Job<SendMessageJob>) => {
    const {
      inboxId,
      workspaceId,
      conversationId,
      messageId,
      to,
      type,
      text,
      mediaUrl,
      mimeType,
      fileName,
      quotedWaMessageId,
      quotedParticipant,
      kind,
      targetWaMessageId,
      reactionEmoji,
      editedBy,
    } = job.data;
    const handle = sessionManager.get(inboxId);
    if (!handle) {
      throw new Error(`No active session for inbox ${inboxId}`);
    }
    const jid = toJid(to);

    // Reaction path: payload diferente, sem persistência de Message own
    if (kind === 'reaction' && targetWaMessageId) {
      await handle.sock.sendMessage(jid, {
        react: {
          text: reactionEmoji ?? '', // vazio = remove
          key: {
            id: targetWaMessageId,
            remoteJid: jid,
            fromMe: false,
          },
        },
      });
      await publishEvent(workspaceId, 'messages', 'reaction.sent', {
        messageId,
        emoji: reactionEmoji ?? null,
      });
      return;
    }

    // Edit path: re-envia mesma key com texto novo (Baileys edit API)
    // WhatsApp limita edição a ~15min; falha silenciosa se rejeitado.
    if (kind === 'edit' && targetWaMessageId) {
      await handle.sock.sendMessage(jid, {
        text: text ?? '',
        edit: {
          id: targetWaMessageId,
          remoteJid: jid,
          fromMe: true,
        },
      });
      // Snapshot do content atual ANTES do update — sem essa linha o histórico
      // perde a versão anterior pra sempre. Falha aqui não bloqueia a edição.
      const editedAt = new Date();
      try {
        const before = await prisma.message.findUnique({
          where: { id: messageId },
          select: { content: true },
        });
        if (before?.content) {
          await prisma.messageEdit.create({
            data: {
              messageId,
              previousContent: before.content,
              editedBy: editedBy ?? null,
              editedAt,
            },
          });
        }
      } catch (snapshotErr) {
        logger.warn(
          { snapshotErr, messageId },
          'Failed to snapshot previous content — edit continues',
        );
      }
      const updated = await prisma.message.update({
        where: { id: messageId },
        data: { content: text ?? '', editedAt },
      });
      await publishEvent(workspaceId, 'messages', 'message.edited', {
        messageId: updated.id,
        conversationId,
        content: text ?? '',
        editedAt,
      });
      return;
    }

    // Revoke ("apagar pra todos") — WhatsApp limita a ~7min após envio
    if (kind === 'revoke' && targetWaMessageId) {
      await handle.sock.sendMessage(jid, {
        delete: {
          id: targetWaMessageId,
          remoteJid: jid,
          fromMe: true,
        },
      });
      const deletedAt = new Date();
      const updated = await prisma.message.update({
        where: { id: messageId },
        data: { deletedAt },
      });
      await publishEvent(workspaceId, 'messages', 'message.deleted', {
        messageId: updated.id,
        conversationId,
        deletedAt,
      });
      return;
    }

    // Monta `quoted` se foi um reply — Baileys exige WAMessage stub mínimo
    const quoted = quotedWaMessageId
      ? ({
          key: {
            id: quotedWaMessageId,
            remoteJid: jid,
            fromMe: false,
            participant: quotedParticipant,
          },
          message: { conversation: '' }, // body fica vazio; Baileys usa só o ID
        } as never)
      : undefined;
    const sendOpts = quoted ? { quoted } : {};

    let result: { key: { id?: string | null } } | undefined;
    if (type === 'TEXT') {
      result = await handle.sock.sendMessage(jid, { text: text ?? '' }, sendOpts);
    } else {
      if (!mediaUrl) throw new Error(`Media job ${messageId} missing mediaUrl`);
      const buffer = await fetchMediaBuffer(mediaUrl);
      const caption = text ?? undefined;
      switch (type) {
        case 'IMAGE':
          result = await handle.sock.sendMessage(
            jid,
            { image: buffer, caption, mimetype: mimeType },
            sendOpts,
          );
          break;
        case 'VIDEO':
          result = await handle.sock.sendMessage(
            jid,
            { video: buffer, caption, mimetype: mimeType },
            sendOpts,
          );
          break;
        case 'AUDIO':
          result = await handle.sock.sendMessage(
            jid,
            { audio: buffer, mimetype: mimeType ?? 'audio/ogg; codecs=opus', ptt: false },
            sendOpts,
          );
          break;
        case 'DOCUMENT':
          result = await handle.sock.sendMessage(
            jid,
            {
              document: buffer,
              mimetype: mimeType ?? 'application/octet-stream',
              fileName: fileName ?? 'arquivo',
              caption,
            },
            sendOpts,
          );
          break;
      }
    }

    const waMessageId = result?.key?.id ?? null;
    const sentAt = new Date();
    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { waMessageId, status: 'SENT', sentAt },
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: sentAt },
    });
    await publishEvent(workspaceId, 'messages', 'message.status', {
      messageId: updated.id,
      status: 'SENT',
      waMessageId,
      sentAt,
    });
  },
  { connection: bullConnection, concurrency: 5 },
);

outboundWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, messageId: job.data.messageId }, 'Outbound message sent');
});

outboundWorker.on('failed', async (job, err) => {
  if (!job) return;
  const attempts = job.attemptsMade ?? 0;
  const max = job.opts?.attempts ?? 1;
  logger.error({ err, jobId: job.id, attempts, max }, 'Outbound job failed');
  if (attempts >= max) {
    await prisma.message
      .update({
        where: { id: job.data.messageId },
        data: { status: 'FAILED', error: err.message.slice(0, 500) },
      })
      .catch(() => {});
    await publishEvent(job.data.workspaceId, 'messages', 'message.status', {
      messageId: job.data.messageId,
      status: 'FAILED',
      error: err.message,
    });
  }
});
