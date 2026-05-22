import makeWASocket, {
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
} from '@whiskeysockets/baileys';
import { pino } from 'pino';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { publishEvent } from '../redis.js';
import { makeEncryptedAuthState } from './auth-state.js';
import {
  handleConnectionUpdate,
  handleMessagesUpsert,
  handleMessagesUpdate,
  handlePresenceUpdate,
} from './events.js';

const baileysLogger = pino({ level: 'silent' });

export interface SessionHandle {
  inboxId: string;
  workspaceId: string;
  sock: WASocket;
  stop: () => void;
}

export interface StartSessionOptions {
  onLoggedOut?: (inboxId: string) => Promise<void>;
  onClosed?: (inboxId: string, isLoggedOut: boolean) => void;
}

export async function startSession(
  inboxId: string,
  options: StartSessionOptions = {},
): Promise<SessionHandle> {
  const inbox = await prisma.inbox.findUnique({
    where: { id: inboxId },
    select: { id: true, workspaceId: true, name: true },
  });
  if (!inbox) throw new Error(`Inbox ${inboxId} not found`);

  const { state, saveCreds } = await makeEncryptedAuthState(inboxId);
  const { version } = await fetchLatestBaileysVersion();

  logger.info({ inboxId, version }, 'Starting Baileys session');

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      // Cache em memória write-through pras signal keys.
      // Reduz hit no DB em ~95% durante handshake/decrypt sem mudar persistência.
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    logger: baileysLogger,
    printQRInTerminal: false,
    browser: ['Neura AI', 'Chrome', '1.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  const ctx = {
    inboxId: inbox.id,
    workspaceId: inbox.workspaceId,
    sock,
    onLoggedOut: options.onLoggedOut ? () => options.onLoggedOut!(inbox.id) : undefined,
  };

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (update) => {
    await handleConnectionUpdate(ctx, update);
    if (update.connection === 'close') {
      const isLoggedOut =
        (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
          ?.statusCode === 401;
      options.onClosed?.(inbox.id, isLoggedOut);
    }
  });
  sock.ev.on('messages.upsert', (payload) =>
    handleMessagesUpsert({ inboxId: inbox.id, workspaceId: inbox.workspaceId, sock }, payload),
  );
  sock.ev.on('messages.update', (payload) =>
    handleMessagesUpdate(
      { inboxId: inbox.id, workspaceId: inbox.workspaceId },
      payload as Parameters<typeof handleMessagesUpdate>[1],
    ),
  );
  sock.ev.on('presence.update', (payload) =>
    handlePresenceUpdate(
      { inboxId: inbox.id, workspaceId: inbox.workspaceId },
      payload as Parameters<typeof handlePresenceUpdate>[1],
    ),
  );

  await prisma.inbox.update({
    where: { id: inboxId },
    data: { status: 'CONNECTING' },
  });
  await publishEvent(inbox.workspaceId, 'inboxes', 'inbox.status', {
    inboxId,
    status: 'CONNECTING',
  });

  return {
    inboxId,
    workspaceId: inbox.workspaceId,
    sock,
    stop() {
      try {
        sock.end(undefined);
      } catch (err) {
        logger.warn({ err, inboxId }, 'Error stopping socket');
      }
    },
  };
}
