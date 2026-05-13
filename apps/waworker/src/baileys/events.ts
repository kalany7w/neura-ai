import type {
  WASocket,
  ConnectionState,
  proto,
  WAMessage,
} from '@whiskeysockets/baileys';
import { DisconnectReason } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { prisma } from '../db';
import { logger } from '../logger';
import { publishEvent } from '../redis';
import type { MessageDirection, MessageType } from '@neura/database';

type ConnectionUpdate = Partial<ConnectionState>;

interface ConnectionContext {
  inboxId: string;
  workspaceId: string;
  sock: WASocket;
  onLoggedOut?: () => Promise<void>;
}

export async function handleConnectionUpdate(
  ctx: ConnectionContext,
  update: ConnectionUpdate,
): Promise<void> {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    const dataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 1 });
    const expiresAt = new Date(Date.now() + 60_000); // QR válido ~60s
    await prisma.waSession.upsert({
      where: { inboxId: ctx.inboxId },
      create: { inboxId: ctx.inboxId, qrCode: dataUrl, qrExpiresAt: expiresAt },
      update: { qrCode: dataUrl, qrExpiresAt: expiresAt, updatedAt: new Date() },
    });
    await prisma.inbox.update({
      where: { id: ctx.inboxId },
      data: { status: 'AWAITING_QR' },
    });
    await publishEvent(ctx.workspaceId, 'inboxes', 'inbox.qr', {
      inboxId: ctx.inboxId,
      qrCode: dataUrl,
      expiresAt,
    });
    logger.info({ inboxId: ctx.inboxId }, 'QR code generated');
  }

  if (connection === 'open') {
    const phoneNumber = ctx.sock.user?.id?.split(':')[0] ?? null;
    await prisma.waSession.update({
      where: { inboxId: ctx.inboxId },
      data: {
        phoneNumber: phoneNumber ? `+${phoneNumber}` : null,
        qrCode: null,
        qrExpiresAt: null,
        lastConnectedAt: new Date(),
        lastError: null,
      },
    });
    await prisma.inbox.update({
      where: { id: ctx.inboxId },
      data: { status: 'CONNECTED' },
    });
    await publishEvent(ctx.workspaceId, 'inboxes', 'inbox.status', {
      inboxId: ctx.inboxId,
      status: 'CONNECTED',
      phoneNumber: phoneNumber ? `+${phoneNumber}` : null,
    });
    logger.info({ inboxId: ctx.inboxId, phoneNumber }, 'WhatsApp connected');
  }

  if (connection === 'close') {
    const errOutput = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
      ?.output;
    const statusCode = errOutput?.statusCode;
    const isLoggedOut = statusCode === DisconnectReason.loggedOut;

    logger.warn(
      { inboxId: ctx.inboxId, statusCode, isLoggedOut },
      'WhatsApp connection closed',
    );

    if (isLoggedOut) {
      await prisma.inbox.update({
        where: { id: ctx.inboxId },
        data: { status: 'DISCONNECTED' },
      });
      await prisma.waSession.update({
        where: { inboxId: ctx.inboxId },
        data: { encryptedAuthState: null, lastError: 'logged_out' },
      });
      await publishEvent(ctx.workspaceId, 'inboxes', 'inbox.status', {
        inboxId: ctx.inboxId,
        status: 'DISCONNECTED',
        reason: 'logged_out',
      });
      ctx.onLoggedOut?.();
    } else {
      // Reconexão será orquestrada pelo manager (backoff exp)
      await prisma.inbox.update({
        where: { id: ctx.inboxId },
        data: { status: 'CONNECTING' },
      });
      await publishEvent(ctx.workspaceId, 'inboxes', 'inbox.status', {
        inboxId: ctx.inboxId,
        status: 'CONNECTING',
      });
    }
  }
}

interface MessagesContext {
  inboxId: string;
  workspaceId: string;
}

interface UpsertPayload {
  messages: WAMessage[];
  type: 'notify' | 'append';
}

export async function handleMessagesUpsert(
  ctx: MessagesContext,
  payload: UpsertPayload,
): Promise<void> {
  if (payload.type !== 'notify') return; // só mensagens novas

  for (const msg of payload.messages) {
    try {
      await persistInboundMessage(ctx, msg);
    } catch (err) {
      logger.error({ err, msgId: msg.key.id }, 'Failed to persist inbound message');
    }
  }
}

async function persistInboundMessage(ctx: MessagesContext, msg: WAMessage): Promise<void> {
  if (!msg.key.remoteJid) return;
  if (msg.key.remoteJid === 'status@broadcast') return; // ignora status
  if (msg.key.fromMe) {
    // Mensagem enviada por nós (em outro dispositivo do mesmo número) — opcional refletir
    return;
  }

  const remoteJid = msg.key.remoteJid;
  // Extrai número (formato 5511999999999@s.whatsapp.net)
  const phoneRaw = remoteJid.split('@')[0];
  if (!phoneRaw) return;
  const phoneNumber = `+${phoneRaw}`;

  // Texto da mensagem
  const messageContent = msg.message;
  if (!messageContent) return;

  const text =
    messageContent.conversation ??
    messageContent.extendedTextMessage?.text ??
    messageContent.imageMessage?.caption ??
    messageContent.videoMessage?.caption ??
    null;

  const type = inferMessageType(messageContent);
  const pushName = msg.pushName ?? null;

  await prisma.$transaction(async (tx) => {
    // Upsert contact
    const contact = await tx.contact.upsert({
      where: {
        workspaceId_phoneNumber: { workspaceId: ctx.workspaceId, phoneNumber },
      },
      create: {
        workspaceId: ctx.workspaceId,
        phoneNumber,
        name: pushName,
      },
      update: {
        // Atualiza pushName se vazio
        name: pushName ?? undefined,
      },
    });

    // Find/create conversation OPEN
    let conversation = await tx.conversation.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        inboxId: ctx.inboxId,
        contactId: contact.id,
        status: { in: ['OPEN', 'PENDING', 'SNOOZED'] },
      },
      orderBy: { lastMessageAt: 'desc' },
    });

    if (!conversation) {
      conversation = await tx.conversation.create({
        data: {
          workspaceId: ctx.workspaceId,
          inboxId: ctx.inboxId,
          contactId: contact.id,
          status: 'OPEN',
        },
      });
    }

    // Insere mensagem (idempotente via waMessageId)
    const existing = msg.key.id
      ? await tx.message.findFirst({ where: { waMessageId: msg.key.id } })
      : null;
    if (existing) return;

    const created = await tx.message.create({
      data: {
        conversationId: conversation.id,
        waMessageId: msg.key.id,
        direction: 'INBOUND' satisfies MessageDirection,
        type,
        content: text,
        status: 'DELIVERED',
        sentAt: msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000) : new Date(),
      },
    });

    await tx.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: created.createdAt,
        unreadCount: { increment: 1 },
      },
    });

    // Eventos real-time
    await publishEvent(ctx.workspaceId, 'messages', 'message.new', {
      conversationId: conversation.id,
      message: created,
    });
    await publishEvent(ctx.workspaceId, 'conversations', 'conversation.updated', {
      conversationId: conversation.id,
      lastMessageAt: created.createdAt,
      unreadDelta: 1,
    });
  });
}

function inferMessageType(content: proto.IMessage): MessageType {
  if (content.imageMessage) return 'IMAGE';
  if (content.videoMessage) return 'VIDEO';
  if (content.audioMessage) return 'AUDIO';
  if (content.documentMessage) return 'DOCUMENT';
  if (content.locationMessage) return 'LOCATION';
  if (content.contactMessage || content.contactsArrayMessage) return 'CONTACT';
  if (content.stickerMessage) return 'STICKER';
  return 'TEXT';
}

interface UpdatePayload {
  key: WAMessage['key'];
  update: Partial<WAMessage>;
}

export async function handleMessagesUpdate(
  ctx: MessagesContext,
  updates: UpdatePayload[],
): Promise<void> {
  for (const u of updates) {
    if (!u.key.id) continue;
    const msg = await prisma.message.findFirst({ where: { waMessageId: u.key.id } });
    if (!msg) continue;

    const status = inferStatusFromUpdate(u.update);
    if (!status) continue;

    const updated = await prisma.message.update({
      where: { id: msg.id },
      data: {
        status,
        deliveredAt: status === 'DELIVERED' ? new Date() : msg.deliveredAt,
        readAt: status === 'READ' ? new Date() : msg.readAt,
      },
    });
    await publishEvent(ctx.workspaceId, 'messages', 'message.status', {
      messageId: updated.id,
      status: updated.status,
    });
  }
}

function inferStatusFromUpdate(update: Partial<WAMessage>): 'DELIVERED' | 'READ' | null {
  const status = update.status;
  if (typeof status !== 'number') return null;
  // 3 = DELIVERY_ACK, 4 = READ na enum do Baileys
  if (status >= 4) return 'READ';
  if (status >= 3) return 'DELIVERED';
  return null;
}
