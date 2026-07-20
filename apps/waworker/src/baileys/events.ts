import type { WASocket, ConnectionState, proto, WAMessage, WAMessageKey } from 'baileys';
import { DisconnectReason } from 'baileys';
import QRCode from 'qrcode';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { publishEvent } from '../redis.js';
import type { MessageDirection, MessageType } from '@neura/database';
import { downloadAndStoreMedia } from './media.js';
import { applyInboxRules } from './inbox-rules.js';
import { enqueueTranscribe } from '../queue/transcribe.js';
import { enqueueAi } from '../queue/ai.js';
import { enqueueWelcomeTrigger, enqueueWelcomeParseReply } from '../welcome-trigger.js';

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

    logger.warn({ inboxId: ctx.inboxId, statusCode, isLoggedOut }, 'WhatsApp connection closed');

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
  sock?: WASocket;
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

/**
 * Cache LRU jid → conversationId pra resolver presence.update do Baileys sem hit DB.
 * Populado quando inbound chega. Max 5000 entries (FIFO). Sem TTL — chave fica
 * válida enquanto a conversa estiver aberta.
 */
const JID_CACHE_MAX = 5000;
const jidToConversation = new Map<string, { conversationId: string; workspaceId: string }>();

function jidCachePut(jid: string, value: { conversationId: string; workspaceId: string }) {
  // Re-insert pra atualizar ordem (Map mantém ordem de inserção)
  if (jidToConversation.has(jid)) jidToConversation.delete(jid);
  jidToConversation.set(jid, value);
  if (jidToConversation.size > JID_CACHE_MAX) {
    const oldest = jidToConversation.keys().next().value;
    if (oldest) jidToConversation.delete(oldest);
  }
}

/**
 * jids cujo presence subscribe já foi feito por inbox — evita re-subscribe em
 * cada inbound (Baileys pode rate-limitar e isso é desnecessário).
 */
const subscribedJids = new Map<string, Set<string>>();

/**
 * Limpa estado da sessão ao parar inbox (evita leak de memória entre conexões).
 */
export function clearSessionState(inboxId: string): void {
  subscribedJids.delete(inboxId);
}

interface PresenceContext {
  inboxId: string;
  workspaceId: string;
}

interface PresenceUpdate {
  id: string;
  presences: Record<
    string,
    {
      lastKnownPresence?: 'unavailable' | 'available' | 'composing' | 'recording' | 'paused';
      lastSeen?: number | null;
    }
  >;
}

export async function handlePresenceUpdate(
  ctx: PresenceContext,
  update: PresenceUpdate,
): Promise<void> {
  if (!update?.id) return;
  // Em 1-1 o presences tem 1 entry com a key == jid do contato
  const presences = update.presences ?? {};
  const jids = Object.keys(presences);
  if (jids.length === 0) return;

  const cached = jidToConversation.get(update.id);
  let conversationId = cached?.conversationId;
  if (!conversationId) {
    // Fallback: resolve por phoneNumber em DB
    const phoneNumber = `+${update.id.split('@')[0] ?? ''}`;
    const contact = await prisma.contact.findUnique({
      where: { workspaceId_phoneNumber: { workspaceId: ctx.workspaceId, phoneNumber } },
      select: { id: true },
    });
    if (!contact) return;
    const conv = await prisma.conversation.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        inboxId: ctx.inboxId,
        contactId: contact.id,
        status: { in: ['OPEN', 'PENDING', 'SNOOZED'] },
      },
      orderBy: { lastMessageAt: 'desc' },
      select: { id: true },
    });
    if (!conv) return;
    conversationId = conv.id;
    jidCachePut(update.id, { conversationId, workspaceId: ctx.workspaceId });
  }

  const first = jids[0];
  if (!first) return;
  const state = presences[first]?.lastKnownPresence ?? 'unavailable';
  const isTyping = state === 'composing' || state === 'recording';
  await publishEvent(ctx.workspaceId, 'conversations', 'conversation.typing', {
    conversationId,
    state,
    isTyping,
  });
}

/**
 * Resolve o número de telefone real (E.164) a partir da key da mensagem.
 *
 * Com o rollout de LID do WhatsApp, `remoteJid` chega como `<id>@lid` — um
 * identificador interno que NÃO é o telefone. O número real vem em `remoteJidAlt`
 * (preenchido pelo Baileys v7 quando o endereçamento é por LID). Fallback: o store
 * de mapeamento LID→PN do socket (persistido em WaAuthKey via auth-state).
 *
 * Retorna também `lidDigits` (parte numérica do LID) pra permitir migrar contatos
 * legados gravados com o LID como se fosse telefone (bug pré-v7).
 */
async function resolvePhone(
  sock: WASocket | undefined,
  key: WAMessageKey,
): Promise<{ phoneNumber: string | null; lidDigits: string | null }> {
  const remoteJid = key.remoteJid ?? '';
  if (remoteJid.endsWith('@s.whatsapp.net')) {
    const digits = remoteJid.split('@')[0];
    return { phoneNumber: digits ? `+${digits}` : null, lidDigits: null };
  }
  if (!remoteJid.endsWith('@lid')) {
    return { phoneNumber: null, lidDigits: null };
  }
  const lidDigits = remoteJid.split('@')[0] || null;
  // 1) remoteJidAlt traz o PN quando o endereçamento é por LID.
  let pnJid = key.remoteJidAlt;
  // 2) Fallback: store de mapeamento LID→PN do Baileys.
  if ((!pnJid || !pnJid.endsWith('@s.whatsapp.net')) && sock) {
    try {
      pnJid = (await sock.signalRepository.lidMapping.getPNForLID(remoteJid)) ?? undefined;
    } catch (err) {
      logger.debug({ err, remoteJid }, 'getPNForLID failed (ignored)');
    }
  }
  if (pnJid && pnJid.endsWith('@s.whatsapp.net')) {
    const digits = pnJid.split('@')[0];
    return { phoneNumber: digits ? `+${digits}` : null, lidDigits };
  }
  return { phoneNumber: null, lidDigits };
}

/**
 * Cura contato legado: registros gravados antes do upgrade v7 usaram o LID como
 * telefone. Quando o número real aparece, move conversas, notas e respostas CSAT
 * do contato-LID pro contato real e remove o fantasma. Idempotente e barato:
 * no-op quando não há legado (findUnique indexado retorna null).
 *
 * `Conversation.contactId` é `onDelete: Cascade` — por isso as conversas (e em
 * cascata messages/cards) são migradas ANTES do delete, nunca depois.
 */
async function mergeLegacyLidContact(
  workspaceId: string,
  lidPhone: string,
  realContactId: string,
): Promise<void> {
  const legacy = await prisma.contact.findUnique({
    where: { workspaceId_phoneNumber: { workspaceId, phoneNumber: lidPhone } },
    select: { id: true },
  });
  if (!legacy || legacy.id === realContactId) return;

  await prisma.$transaction([
    prisma.conversation.updateMany({
      where: { contactId: legacy.id },
      data: { contactId: realContactId },
    }),
    prisma.contactNote.updateMany({
      where: { contactId: legacy.id },
      data: { contactId: realContactId },
    }),
    prisma.csatResponse.updateMany({
      where: { contactId: legacy.id },
      data: { contactId: realContactId },
    }),
    // PK composta (contactId,labelId) pode colidir com labels do contato real;
    // são labels do contato-fantasma, então descarta.
    prisma.contactLabel.deleteMany({ where: { contactId: legacy.id } }),
    prisma.contact.delete({ where: { id: legacy.id } }),
  ]);

  logger.info(
    { workspaceId, lidPhone, realContactId },
    'Contato legado (LID) fundido no contato com número real',
  );
}

async function persistInboundMessage(ctx: MessagesContext, msg: WAMessage): Promise<void> {
  if (!msg.key.remoteJid) return;
  if (msg.key.remoteJid === 'status@broadcast') return; // ignora status
  if (msg.key.fromMe) {
    // Mensagem enviada por nós (em outro dispositivo do mesmo número) — opcional refletir
    return;
  }

  const remoteJid = msg.key.remoteJid;
  // Subscribe presença pra começar a receber composing/paused (Baileys exige opt-in)
  // — só 1× por jid por sessão (evita rate-limit no Baileys)
  if (ctx.sock) {
    let set = subscribedJids.get(ctx.inboxId);
    if (!set) {
      set = new Set();
      subscribedJids.set(ctx.inboxId, set);
    }
    if (!set.has(remoteJid)) {
      try {
        await ctx.sock.presenceSubscribe(remoteJid);
        set.add(remoteJid);
      } catch (err) {
        logger.debug({ err, remoteJid }, 'presenceSubscribe failed (ignored)');
      }
    }
  }
  // Resolve o número real. Em endereçamento LID, remoteJid é só identificador
  // interno; o telefone vem de remoteJidAlt / lidMapping (ver resolvePhone).
  const resolved = await resolvePhone(ctx.sock, msg.key);
  // Fallback: se o PN ainda não resolveu (LID sem alt nem mapping), usa o LID como
  // chave temporária pra não perder a mensagem — mergeLegacyLidContact() cura assim
  // que o número real aparecer num inbound seguinte.
  const phoneNumber = resolved.phoneNumber ?? `+${remoteJid.split('@')[0] ?? ''}`;
  const lidDigits = resolved.lidDigits;
  if (phoneNumber === '+') return;

  // Texto da mensagem
  const messageContent = msg.message;
  if (!messageContent) return;

  // Detecta interactive replies do Baileys (listResponseMessage / buttonsResponseMessage)
  // — usado pelo welcome-parser pra mapear opção escolhida via metadata.
  // singleSelectReply.selectedRowId / selectedButtonId carregam o id da opção;
  // title / selectedDisplayText carregam o label legível mostrado ao cliente.
  const interactiveMeta: { interactiveRowId?: string; interactiveDisplayText?: string } = {};
  let interactiveText: string | null = null;
  if (messageContent.listResponseMessage) {
    const r = messageContent.listResponseMessage;
    if (r.singleSelectReply?.selectedRowId) {
      interactiveMeta.interactiveRowId = r.singleSelectReply.selectedRowId;
    }
    if (r.title) interactiveMeta.interactiveDisplayText = r.title;
    interactiveText = r.title ?? '(seleção do menu)';
  } else if (messageContent.buttonsResponseMessage) {
    const r = messageContent.buttonsResponseMessage;
    if (r.selectedButtonId) interactiveMeta.interactiveRowId = r.selectedButtonId;
    if (r.selectedDisplayText) interactiveMeta.interactiveDisplayText = r.selectedDisplayText;
    interactiveText = r.selectedDisplayText ?? '(clique de botão)';
  }

  const text =
    interactiveText ??
    messageContent.conversation ??
    messageContent.extendedTextMessage?.text ??
    messageContent.imageMessage?.caption ??
    messageContent.videoMessage?.caption ??
    null;

  const type = inferMessageType(messageContent);
  const pushName = msg.pushName ?? null;

  // Extrai metadata de location (LOCATION type)
  const loc = messageContent.locationMessage;
  const locationLat =
    type === 'LOCATION' && typeof loc?.degreesLatitude === 'number' ? loc.degreesLatitude : null;
  const locationLon =
    type === 'LOCATION' && typeof loc?.degreesLongitude === 'number' ? loc.degreesLongitude : null;
  const locationName = type === 'LOCATION' ? (loc?.name ?? null) : null;
  const locationAddress = type === 'LOCATION' ? (loc?.address ?? null) : null;

  const txResult = await prisma.$transaction(async (tx) => {
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

    const isNewConversation = !conversation;
    if (!conversation) {
      conversation = await tx.conversation.create({
        data: {
          workspaceId: ctx.workspaceId,
          inboxId: ctx.inboxId,
          contactId: contact.id,
          status: 'OPEN',
        },
      });

      // Auto-cria card no funil default (primeira stage sem outcome POSITIVE/NEGATIVE)
      const defaultFunnel = await tx.funnel.findFirst({
        where: { workspaceId: ctx.workspaceId, isDefault: true },
        include: {
          stages: {
            where: { NOT: { outcome: { in: ['POSITIVE', 'NEGATIVE'] } } },
            orderBy: { order: 'asc' },
            take: 1,
          },
        },
      });
      const firstStage = defaultFunnel?.stages[0];
      if (defaultFunnel && firstStage) {
        const maxPos = await tx.card.aggregate({
          where: { stageId: firstStage.id },
          _max: { position: true },
        });
        await tx.card.create({
          data: {
            workspaceId: ctx.workspaceId,
            funnelId: defaultFunnel.id,
            stageId: firstStage.id,
            conversationId: conversation.id,
            title: contact.name ?? phoneNumber,
            position: (maxPos._max.position ?? -1) + 1,
          },
        });
        // is_new_conversation eventual log via publishEvent fora da tx
      }
    }
    void isNewConversation;

    // Insere mensagem (idempotente via waMessageId)
    const existing = msg.key.id
      ? await tx.message.findFirst({ where: { waMessageId: msg.key.id } })
      : null;
    if (existing) {
      return null; // duplicada, skip rules
    }

    const created = await tx.message.create({
      data: {
        conversationId: conversation.id,
        waMessageId: msg.key.id,
        direction: 'INBOUND' satisfies MessageDirection,
        type,
        content: text,
        locationLat,
        locationLon,
        locationName,
        locationAddress,
        status: 'DELIVERED',
        sentAt: msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000) : new Date(),
        metadata: Object.keys(interactiveMeta).length > 0 ? interactiveMeta : undefined,
      },
    });

    // Welcome flow hooks: detectar primeira inbound (trigger) e awaiting (parse_reply).
    // Count INBOUND nessa conversa: 1 == a recém-criada == primeira inbound.
    const inboundCount = await tx.message.count({
      where: { conversationId: conversation.id, direction: 'INBOUND' },
    });
    const isFirstInbound = inboundCount === 1;
    const isAwaitingWelcomeChoice = conversation.isAwaitingWelcomeChoice;

    // Sync cards linkados — atualiza preview/badge unread/lastMessageAt
    // (slaStatus deixa pro SLA scheduler recalcular)
    const preview = text ? text.slice(0, 60) : `[${type.toLowerCase()}]`;
    await tx.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: created.createdAt,
        lastMessagePreview: preview,
        lastInboundAt: created.createdAt,
        unreadCount: { increment: 1 },
        // Auto-desarquivar quando msg nova chega
        archivedAt: null,
      },
    });
    await tx.card.updateMany({
      where: { conversationId: conversation.id },
      data: {
        lastMessageAt: created.createdAt,
        lastMessagePreview: preview,
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
    await publishEvent(ctx.workspaceId, 'cards', 'card.unread_changed', {
      conversationId: conversation.id,
      lastMessageAt: created.createdAt,
      preview,
    });

    // Fire-and-forget: baixa e armazena mídia em background
    if (type !== 'TEXT' && type !== 'LOCATION' && type !== 'CONTACT' && type !== 'SYSTEM') {
      void downloadStoreAndUpdate(ctx, created.id, msg);
    }

    return {
      isNewConversation,
      conversationId: conversation.id,
      contactId: contact.id,
      contactPhone: phoneNumber,
      contactName: contact.name,
      isFirstInbound,
      isAwaitingWelcomeChoice,
      messageId: created.id,
    };
  });

  if (txResult) {
    // Cura legado: se resolvemos o número real E havia um LID, funde o contato
    // antigo (gravado com o LID como telefone) no contato com número real.
    if (resolved.phoneNumber && lidDigits) {
      void mergeLegacyLidContact(ctx.workspaceId, `+${lidDigits}`, txResult.contactId).catch(
        (err) => logger.error({ err, lidDigits }, 'mergeLegacyLidContact failed'),
      );
    }
    // Cache jid → conversation pra resolver presence.update sem hit DB (LRU)
    jidCachePut(remoteJid, {
      conversationId: txResult.conversationId,
      workspaceId: ctx.workspaceId,
    });
    // Aplica regras da inbox depois da transação (round-robin, saudação, out-of-hours)
    void applyInboxRules({
      workspaceId: ctx.workspaceId,
      inboxId: ctx.inboxId,
      conversationId: txResult.conversationId,
      contactPhone: txResult.contactPhone,
      contactName: txResult.contactName,
      isNewConversation: txResult.isNewConversation,
    });
    // IA Copilot: re-classifica conversa após inbound. Delay 30s funciona como
    // debounce porque jobId determinístico — múltiplos inbounds em sequência
    // colapsam num único classify pegando a versão mais recente do DB.
    void enqueueAi(
      {
        workspaceId: ctx.workspaceId,
        kind: 'classify',
        targetId: txResult.conversationId,
      },
      { delayMs: 30_000 },
    );
    // Welcome flow: primeira inbound da conversa → trigger (worker decide se manda welcome).
    if (txResult.isFirstInbound) {
      void enqueueWelcomeTrigger({
        workspaceId: ctx.workspaceId,
        conversationId: txResult.conversationId,
      }).catch((err) =>
        logger.error(
          { err, conversationId: txResult.conversationId },
          'enqueueWelcomeTrigger failed',
        ),
      );
    }
    // Conversa já recebeu welcome e está aguardando escolha → roteia reply pro parser.
    if (txResult.isAwaitingWelcomeChoice) {
      void enqueueWelcomeParseReply({
        workspaceId: ctx.workspaceId,
        conversationId: txResult.conversationId,
        messageId: txResult.messageId,
      }).catch((err) =>
        logger.error(
          { err, conversationId: txResult.conversationId },
          'enqueueWelcomeParseReply failed',
        ),
      );
    }
  }
}

async function downloadStoreAndUpdate(
  ctx: MessagesContext,
  messageId: string,
  msg: WAMessage,
): Promise<void> {
  try {
    const result = await downloadAndStoreMedia(ctx.workspaceId, messageId, msg);
    if (!result) return;
    const updated = await prisma.message.update({
      where: { id: messageId },
      data: {
        mediaUrl: result.url,
        mediaMimeType: result.mimeType,
        mediaSize: result.size,
        thumbnailUrl: result.thumbnailUrl ?? null,
      },
    });
    await publishEvent(ctx.workspaceId, 'messages', 'message.media_ready', {
      messageId: updated.id,
      mediaUrl: updated.mediaUrl,
      thumbnailUrl: updated.thumbnailUrl,
      mimeType: updated.mediaMimeType,
      size: updated.mediaSize,
    });

    // Áudio: enfileira transcrição (api processa via Whisper)
    if (updated.type === 'AUDIO' && updated.mediaUrl) {
      void enqueueTranscribe({
        workspaceId: ctx.workspaceId,
        messageId: updated.id,
      });
    }
  } catch (err) {
    logger.error({ err, messageId }, 'Failed to download/store media (background)');
  }
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
