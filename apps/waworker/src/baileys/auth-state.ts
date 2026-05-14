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

async function persistAuthBlob(inboxId: string, blob: AuthBlob): Promise<void> {
  const json = JSON.stringify(blob, BufferJSON.replacer);
  const encryptedAuthState = encrypt(json);
  await prisma.waSession.upsert({
    where: { inboxId },
    create: { inboxId, encryptedAuthState },
    update: { encryptedAuthState, updatedAt: new Date() },
  });
}

/**
 * Durante handshake o Baileys chama keys.set ~50× em sequência. Persistir a cada
 * chamada é desperdício: encrypt+upsert pesados. Debounce 500ms + flush no creds
 * update mantém durabilidade sem o overhead.
 */
const SAVE_DEBOUNCE_MS = 500;

interface PendingSave {
  blob: AuthBlob;
  timer: NodeJS.Timeout;
  inFlight: Promise<void> | null;
}

const pendingSaves = new Map<string, PendingSave>();

function scheduleSave(inboxId: string, blob: AuthBlob): void {
  const existing = pendingSaves.get(inboxId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    const entry = pendingSaves.get(inboxId);
    if (!entry) return;
    pendingSaves.delete(inboxId);
    entry.inFlight = persistAuthBlob(inboxId, entry.blob).catch((err) => {
      logger.error({ err, inboxId }, 'persistAuthBlob failed');
    });
  }, SAVE_DEBOUNCE_MS);
  pendingSaves.set(inboxId, { blob, timer, inFlight: existing?.inFlight ?? null });
}

/**
 * Força salvamento imediato (usar em creds.update e ao parar sessão).
 */
async function flushSave(inboxId: string, blob: AuthBlob): Promise<void> {
  const existing = pendingSaves.get(inboxId);
  if (existing) {
    clearTimeout(existing.timer);
    pendingSaves.delete(inboxId);
  }
  await persistAuthBlob(inboxId, blob);
}

export async function flushPendingAuthState(inboxId: string): Promise<void> {
  const entry = pendingSaves.get(inboxId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingSaves.delete(inboxId);
  await persistAuthBlob(inboxId, entry.blob).catch(() => {});
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
          // Debounce save: handshake chama isso ~50× em sequência
          scheduleSave(inboxId, blob);
        },
      },
    },
    // creds.update precisa persistir imediatamente (sessão crítica)
    saveCreds: () => flushSave(inboxId, blob),
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
