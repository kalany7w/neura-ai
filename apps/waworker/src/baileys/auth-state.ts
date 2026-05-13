import {
  initAuthCreds,
  BufferJSON,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { prisma } from '../db';
import { encrypt, decrypt } from '../crypto';
import { logger } from '../logger';

interface AuthBlob {
  creds: AuthenticationCreds;
  keys: Record<string, Record<string, unknown>>;
}

async function loadAuthBlob(inboxId: string): Promise<AuthBlob> {
  const ws = await prisma.waSession.findUnique({ where: { inboxId } });
  if (ws?.encryptedAuthState) {
    try {
      const json = decrypt(ws.encryptedAuthState);
      return JSON.parse(json, BufferJSON.reviver) as AuthBlob;
    } catch (err) {
      logger.error({ err, inboxId }, 'Failed to decrypt auth state — reinit');
    }
  }
  return { creds: initAuthCreds(), keys: {} };
}

async function saveAuthBlob(inboxId: string, blob: AuthBlob): Promise<void> {
  const json = JSON.stringify(blob, BufferJSON.replacer);
  const encryptedAuthState = encrypt(json);
  await prisma.waSession.upsert({
    where: { inboxId },
    create: { inboxId, encryptedAuthState },
    update: { encryptedAuthState, updatedAt: new Date() },
  });
}

/**
 * Cria AuthenticationState compatível com Baileys, persistido criptografado em Postgres.
 * Inspirado em `useMultiFileAuthState` mas com encrypted DB storage.
 */
export async function makeEncryptedAuthState(inboxId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const blob = await loadAuthBlob(inboxId);

  return {
    state: {
      creds: blob.creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(
          type: T,
          ids: string[],
        ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
          const data: Record<string, SignalDataTypeMap[T]> = {};
          for (const id of ids) {
            let val = blob.keys[type]?.[id] as SignalDataTypeMap[T] | undefined;
            if (type === 'app-state-sync-key' && val) {
              val = proto.Message.AppStateSyncKeyData.fromObject(
                val as object,
              ) as unknown as SignalDataTypeMap[T];
            }
            if (val !== undefined) data[id] = val;
          }
          return data;
        },
        set: async (data: {
          [category in keyof SignalDataTypeMap]?: { [id: string]: SignalDataTypeMap[category] | null };
        }) => {
          for (const category in data) {
            const items = data[category as keyof SignalDataTypeMap];
            if (!items) continue;
            blob.keys[category] = blob.keys[category] ?? {};
            for (const id in items) {
              const value = items[id];
              if (value === null) {
                delete blob.keys[category]![id];
              } else {
                blob.keys[category]![id] = value;
              }
            }
          }
          await saveAuthBlob(inboxId, blob);
        },
      },
    },
    saveCreds: () => saveAuthBlob(inboxId, blob),
  };
}

/**
 * Limpa auth state (logout/desconectar). Usado quando inbox é deletada ou banida.
 */
export async function clearAuthState(inboxId: string): Promise<void> {
  await prisma.waSession.update({
    where: { inboxId },
    data: { encryptedAuthState: null, qrCode: null, qrExpiresAt: null, phoneNumber: null },
  }).catch(() => {
    // Sessão pode não existir
  });
}
