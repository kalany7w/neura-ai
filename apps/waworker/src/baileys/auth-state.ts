import {
  initAuthCreds,
  BufferJSON,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from 'baileys';
import { prisma } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';
import { logger } from '../logger.js';

/**
 * Auth state do Baileys com persistência write-through em Postgres.
 *
 * Arquitetura (igual `useMultiFileAuthState` oficial + pedidozap-saas):
 *   - `creds` (noiseKey, signedIdentityKey, registrationId, me.id, etc.)
 *     vai em `WaSession.encryptedAuthState` como blob JSON+AES.
 *     Atualizado no `creds.update` (raro).
 *   - Signal keys (pre-key, session, sender-key, app-state-sync-key)
 *     vão em `WaAuthKey`, 1 row por key, AES por valor.
 *     Upsert/delete direto no `keys.set` — SEM debounce.
 *
 * Por que sem debounce: durante handshake/decryptação, o Baileys avança o
 * ratchet do Signal Protocol e chama `keys.set`. Se o processo morre antes do
 * flush, o servidor WhatsApp avançou mas o disco ficou pra trás → Bad MAC em
 * todas as decryptações futuras. Write-through elimina essa janela.
 *
 * Para performance, o caller deve envolver `state.keys` em
 * `makeCacheableSignalKeyStore` (cache em memória write-through).
 */

interface LegacyAuthBlob {
  creds: AuthenticationCreds;
  keys?: Record<string, Record<string, unknown>>;
}

interface CredsBlob {
  creds: AuthenticationCreds;
}

async function readKey(inboxId: string, keyName: string): Promise<unknown | null> {
  const row = await prisma.waAuthKey.findUnique({
    where: { inboxId_keyName: { inboxId, keyName } },
    select: { keyData: true },
  });
  if (!row) return null;
  try {
    const json = decrypt(row.keyData);
    return JSON.parse(json, BufferJSON.reviver);
  } catch (err) {
    logger.error({ err, inboxId, keyName }, 'Failed to decrypt key, treating as missing');
    return null;
  }
}

async function writeKey(inboxId: string, keyName: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value, BufferJSON.replacer);
  const keyData = encrypt(json);
  await prisma.waAuthKey.upsert({
    where: { inboxId_keyName: { inboxId, keyName } },
    create: { inboxId, keyName, keyData },
    update: { keyData },
  });
}

async function deleteKey(inboxId: string, keyName: string): Promise<void> {
  await prisma.waAuthKey.delete({
    where: { inboxId_keyName: { inboxId, keyName } },
  }).catch(() => {
    // Já não existia
  });
}

async function loadCreds(inboxId: string): Promise<AuthenticationCreds> {
  const ws = await prisma.waSession.findUnique({
    where: { inboxId },
    select: { encryptedAuthState: true },
  });
  if (!ws?.encryptedAuthState) return initAuthCreds();
  try {
    const json = decrypt(ws.encryptedAuthState);
    const blob = JSON.parse(json, BufferJSON.reviver) as LegacyAuthBlob | CredsBlob;
    // Compat: blob legado tem `keys` junto. Migração `migrateLegacyBlobIfNeeded`
    // (chamada antes daqui) já moveu pra WaAuthKey e regravou o blob só com creds.
    return blob.creds;
  } catch (err) {
    logger.error({ err, inboxId }, 'Failed to decrypt auth state — reinit');
    return initAuthCreds();
  }
}

async function saveCredsToDB(inboxId: string, creds: AuthenticationCreds): Promise<void> {
  const blob: CredsBlob = { creds };
  const json = JSON.stringify(blob, BufferJSON.replacer);
  const encryptedAuthState = encrypt(json);
  await prisma.waSession.upsert({
    where: { inboxId },
    create: { inboxId, encryptedAuthState },
    update: { encryptedAuthState, updatedAt: new Date() },
  });
}

/**
 * Migra blob legado (creds+keys juntos) pro novo formato (creds blob + WaAuthKey rows).
 * Idempotente: se o blob não tem `keys` ou já não existe, no-op.
 */
async function migrateLegacyBlobIfNeeded(inboxId: string): Promise<void> {
  const ws = await prisma.waSession.findUnique({
    where: { inboxId },
    select: { encryptedAuthState: true },
  });
  if (!ws?.encryptedAuthState) return;

  let blob: LegacyAuthBlob;
  try {
    const json = decrypt(ws.encryptedAuthState);
    blob = JSON.parse(json, BufferJSON.reviver) as LegacyAuthBlob;
  } catch (err) {
    logger.error({ err, inboxId }, 'migrateLegacyBlobIfNeeded: decrypt failed, skipping');
    return;
  }

  if (!blob.keys || Object.keys(blob.keys).length === 0) {
    // Já está no formato novo (ou nunca teve keys)
    return;
  }

  logger.info({ inboxId, categories: Object.keys(blob.keys) }, 'Migrating legacy auth blob to WaAuthKey rows');

  // Move cada key pra row própria (write-through). Idempotente — upsert.
  let migrated = 0;
  for (const category in blob.keys) {
    const items = blob.keys[category] ?? {};
    for (const id in items) {
      const keyName = `${category}-${id}`;
      const value = items[id];
      if (value !== undefined && value !== null) {
        await writeKey(inboxId, keyName, value);
        migrated++;
      }
    }
  }

  // Reescreve o blob só com creds (drop keys). Atômico — última linha após upserts.
  const credsOnly: CredsBlob = { creds: blob.creds };
  const json = JSON.stringify(credsOnly, BufferJSON.replacer);
  await prisma.waSession.update({
    where: { inboxId },
    data: { encryptedAuthState: encrypt(json) },
  });

  logger.info({ inboxId, migrated }, 'Legacy auth blob migrated');
}

/**
 * Cria AuthenticationState compatível com Baileys, persistido criptografado em Postgres.
 * Keys: WaAuthKey (1 row por key, write-through).
 * Creds: WaSession.encryptedAuthState (blob JSON+AES, atualizado em creds.update).
 *
 * O caller DEVE envolver `state.keys` em `makeCacheableSignalKeyStore` antes de
 * passar pro `makeWASocket` — cache em memória write-through reduz hit no DB.
 */
export async function makeEncryptedAuthState(inboxId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  // Migra blob legado (se existir) antes de carregar creds — garante que keys
  // antigas dentro do blob não fiquem "perdidas" em relação à nova tabela.
  await migrateLegacyBlobIfNeeded(inboxId);

  const creds = await loadCreds(inboxId);

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(
          type: T,
          ids: string[],
        ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
          const data: Record<string, SignalDataTypeMap[T]> = {};
          await Promise.all(
            ids.map(async (id) => {
              let val = (await readKey(inboxId, `${type}-${id}`)) as SignalDataTypeMap[T] | null;
              if (val === null) return;
              if (type === 'app-state-sync-key') {
                val = proto.Message.AppStateSyncKeyData.fromObject(
                  val as object,
                ) as unknown as SignalDataTypeMap[T];
              }
              data[id] = val;
            }),
          );
          return data;
        },
        set: async (data: {
          [category in keyof SignalDataTypeMap]?: { [id: string]: SignalDataTypeMap[category] | null };
        }) => {
          // Write-through por key — sem debounce, sem janela de perda.
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            const items = data[category as keyof SignalDataTypeMap];
            if (!items) continue;
            for (const id in items) {
              const keyName = `${category}-${id}`;
              const value = items[id];
              tasks.push(value === null ? deleteKey(inboxId, keyName) : writeKey(inboxId, keyName, value));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => saveCredsToDB(inboxId, creds),
  };
}

/**
 * No-op preservado pela API. No modelo write-through não há saves pendentes
 * de keys; creds.update já é síncrono via saveCreds.
 */
export async function flushPendingAuthState(_inboxId: string): Promise<void> {
  // intencionalmente vazio
}

/**
 * Limpa auth state (logout/desconectar). Apaga creds blob + todas as keys da inbox.
 */
export async function clearAuthState(inboxId: string): Promise<void> {
  await Promise.all([
    prisma.waSession.update({
      where: { inboxId },
      data: { encryptedAuthState: null, qrCode: null, qrExpiresAt: null, phoneNumber: null },
    }).catch(() => {
      // Sessão pode não existir
    }),
    prisma.waAuthKey.deleteMany({ where: { inboxId } }),
  ]);
}
