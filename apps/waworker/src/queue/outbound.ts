import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_OUTBOUND, type SendMessageJob } from '@neura/shared/queue';
import { sessionManager } from '../baileys/manager.js';
import { prisma } from '../db.js';
import { publishEvent } from '../redis.js';
import { logger } from '../logger.js';
import { env } from '../env.js';
import { getMediaBuffer, keyFromUrl } from '../storage.js';

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Delay aleatório em [min, max) ms — evita padrão robótico de disparo. */
function jitter(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

/**
 * Anti-ban WhatsApp: simula digitação humana antes de um envio de conteúdo.
 * Manda presença "composing", espera um tempo proporcional ao tamanho do texto
 * (com teto), depois "paused". Falhas de presença não bloqueiam o envio.
 *
 * Isto é a maior mitigação de banimento do lado do worker: número que dispara
 * mensagens instantâneas em sequência é sinalizado como bot pelo WhatsApp.
 */
async function humanTypingPause(
  sock: { sendPresenceUpdate: (p: 'composing' | 'paused', jid: string) => Promise<unknown> },
  jid: string,
  contentLength: number,
): Promise<void> {
  try {
    await sock.sendPresenceUpdate('composing', jid);
  } catch {
    /* presença é best-effort */
  }
  const base = jitter(700, 1600);
  const perChar = Math.min(contentLength * 25, 4000);
  await sleep(Math.min(base + perChar, 6500));
  try {
    await sock.sendPresenceUpdate('paused', jid);
  } catch {
    /* idem */
  }
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
    // Filtro multi-canal: waworker só processa inboxes WHATSAPP.
    // Outros tipos (TELEGRAM, EMAIL) são processados por workers no api side.
    const inboxMeta = await prisma.inbox.findUnique({
      where: { id: inboxId },
      select: { type: true },
    });
    if (inboxMeta && inboxMeta.type !== 'WHATSAPP') {
      // Não é nosso job — silenciosamente ignora. Outro worker pega.
      logger.debug({ inboxId, type: inboxMeta.type }, 'skip non-WHATSAPP outbound job');
      return;
    }
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

    // Path interativo (listMessage do Baileys) — welcome flow e similar.
    // Em falha (Meta deprecou listMessage em alguns clients), fallback pra texto
    // numerado preservando o audit trail (DB recebe o texto que foi efetivamente enviado).
    if (type === 'INTERACTIVE' && job.data.interactivePayload) {
      const payload = job.data.interactivePayload;
      const { title, body, footer, buttonText, options } = payload;

      // Baileys listMessage: máximo 10 rows
      const rows = options.slice(0, 10).map((o) => ({
        title: o.title,
        description: o.description ?? '',
        rowId: o.rowId,
      }));

      try {
        const sentMsg = await handle.sock.sendMessage(jid, {
          text: body,
          footer,
          title,
          buttonText,
          sections: [{ title: 'Opções', rows }],
          listType: 1, // SINGLE_SELECT
        } as never); // Baileys types incompletos pra listMessage

        const sentAt = new Date();
        await prisma.message.update({
          where: { id: messageId },
          data: {
            status: 'SENT',
            waMessageId: sentMsg?.key?.id ?? null,
            sentAt,
          },
        });
        await prisma.conversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: sentAt },
        });
        await publishEvent(workspaceId, 'messages', 'message.status', {
          messageId,
          status: 'SENT',
          waMessageId: sentMsg?.key?.id ?? null,
          sentAt,
        });
        return;
      } catch (err) {
        logger.error({ err, messageId }, 'Failed to send INTERACTIVE — falling back to text');
        // Fallback: re-enviar como texto plano numerado
        const textFallback = `${body}\n\n${options
          .map((o, i) => `${i + 1}. ${o.title}`)
          .join('\n')}\n\nResponda com o número da opção.`;

        const fallbackMsg = await handle.sock.sendMessage(jid, { text: textFallback });
        const sentAt = new Date();
        await prisma.message.update({
          where: { id: messageId },
          data: {
            status: 'SENT',
            content: textFallback,
            waMessageId: fallbackMsg?.key?.id ?? null,
            sentAt,
          },
        });
        await prisma.conversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: sentAt },
        });
        await publishEvent(workspaceId, 'messages', 'message.status', {
          messageId,
          status: 'SENT',
          waMessageId: fallbackMsg?.key?.id ?? null,
          sentAt,
        });
        return;
      }
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

    // Anti-ban: pausa de digitação humana antes de mandar conteúdo real.
    await humanTypingPause(handle.sock, jid, (text ?? '').length);

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
  {
    connection: bullConnection,
    // Concorrência menor + limiter global: teto de segurança anti-ban que soma
    // ao limiter por-inbox do lado da API (30/min). Números diferentes seguem
    // paralelos, mas a vazão total do worker fica suave.
    concurrency: 3,
    limiter: { max: 8, duration: 1000 },
  },
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
