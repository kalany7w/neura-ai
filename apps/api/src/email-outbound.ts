/**
 * Email outbound worker — consume queue `outbound-email`.
 * Envia via Resend SDK (mesma chave RESEND_API_KEY do app).
 *
 * Threading: olha replyToId pra carregar Message original, pega seu
 * `emailMessageId` e passa como `In-Reply-To` header — cliente vê thread.
 *
 * Mídia: não suporta anexos no MVP (Resend SDK suporta `attachments[]`, mas
 * precisa fetch do MinIO + buffer base64 — fica pra próxima onda).
 */

import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_OUTBOUND_EMAIL, type SendMessageJob } from '@neura/shared/queue';
import { prisma } from './db';
import { publishEvent } from './redis-pub';
import { logger } from './logger';
import { env } from './env';
import { sendInboxEmail, htmlToPlainText } from './services/email-client';

const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const emailOutboundWorker = new Worker<SendMessageJob>(
  QUEUE_OUTBOUND_EMAIL,
  async (job: Job<SendMessageJob>) => {
    const { inboxId, workspaceId, conversationId, messageId, type, text, kind } = job.data;

    // Operações WhatsApp-specific não se aplicam a email.
    if (kind === 'reaction' || kind === 'edit' || kind === 'revoke') {
      logger.info({ messageId, kind }, 'email outbound: kind not supported, skipping');
      return;
    }
    if (type !== 'TEXT') {
      logger.info({ messageId, type }, 'email outbound: only TEXT supported (media coming later)');
      return;
    }

    const inbox = await prisma.inbox.findUnique({
      where: { id: inboxId },
      select: { id: true, type: true, channelConfig: true, name: true },
    });
    if (!inbox || inbox.type !== 'EMAIL') {
      logger.warn({ inboxId, type: inbox?.type }, 'email-outbound: inbox not EMAIL, skip');
      return;
    }

    const cfg = (inbox.channelConfig as Record<string, unknown> | null) ?? {};
    const fromAddress = cfg.fromAddress as string | undefined;
    const fromName = (cfg.fromName as string | undefined) ?? inbox.name;
    if (!fromAddress) {
      throw new Error(`Inbox ${inboxId} has no fromAddress configured`);
    }

    // Resolve to + threading via conversa
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        contact: { select: { email: true, name: true } },
        // Pega últimas msgs pra deduzir subject (primeira do thread) e In-Reply-To
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { content: true, emailMessageId: true },
        },
      },
    });
    if (!conv?.contact.email) {
      throw new Error(`Conversation ${conversationId} contact has no email`);
    }
    const toAddress = conv.contact.email;

    // Last inbound email com Message-ID — usa como In-Reply-To.
    const lastInbound = await prisma.message.findFirst({
      where: {
        conversationId,
        direction: 'INBOUND',
        emailMessageId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { emailMessageId: true },
    });
    const inReplyTo = lastInbound?.emailMessageId ?? undefined;

    // Subject: deriva da primeira msg do thread OU usa fallback "Re: <preview>"
    let subject = 'Sem assunto';
    const firstMsg = conv.messages[0];
    if (firstMsg?.content) {
      const firstLine = firstMsg.content.split('\n')[0]?.trim();
      if (firstLine) {
        subject = firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine;
      }
    }
    // Se já estamos respondendo (inReplyTo set), prefixa "Re: "
    if (inReplyTo && !/^re:/i.test(subject)) {
      subject = `Re: ${subject}`;
    }

    const bodyText = text ?? '';
    const bodyHtml = textToHtml(bodyText);

    const result = await sendInboxEmail({
      from: `${fromName} <${fromAddress}>`,
      to: toAddress,
      subject,
      text: bodyText,
      html: bodyHtml,
      inReplyTo,
      references: inReplyTo, // simples — só o último (suficiente pra Gmail/Outlook agruparem)
    });

    // Marca message como SENT + grava emailMessageId (surrogate via Resend id).
    const sentAt = new Date();
    const updated = await prisma.message.update({
      where: { id: messageId },
      data: {
        emailMessageId: result.messageId ?? result.id,
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
      emailMessageId: result.messageId,
      sentAt: sentAt.toISOString(),
    });

    logger.info({ messageId: updated.id, to: toAddress }, 'email message sent');

    // Fallback: htmlToPlainText apenas referenciado pra suprimir warning unused-import
    // quando o helper for usado em outras funções futuras.
    void htmlToPlainText;
  },
  { connection: bullConnection, concurrency: 3 },
);

emailOutboundWorker.on('failed', async (job, err) => {
  if (!job) return;
  const attempts = job.attemptsMade ?? 0;
  const max = job.opts?.attempts ?? 1;
  logger.error(
    { err, jobId: job.id, attempts, max, messageId: job.data.messageId },
    'email outbound job failed',
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

/**
 * Converte texto puro em HTML simples (preserva quebras de linha + links auto).
 * Pra MVP — não suporta markdown.
 */
function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Auto-link URLs simples
  const linked = escaped.replace(
    /(https?:\/\/[^\s<>"']+)/g,
    '<a href="$1" target="_blank" rel="noreferrer">$1</a>',
  );
  return `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">${linked}</div>`;
}
