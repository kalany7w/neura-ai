import { downloadMediaMessage, type WAMessage, type MessageType } from '@whiskeysockets/baileys';
import { pino } from 'pino';
import { putMedia } from '../storage';
import { logger } from '../logger';

const baileysLogger = pino({ level: 'silent' });

interface DownloadedMedia {
  url: string;
  mimeType: string;
  size: number;
  fileName?: string;
}

/**
 * Baixa mídia de uma mensagem inbound e sobe no MinIO.
 * Retorna URL pública + metadata.
 */
export async function downloadAndStoreMedia(
  workspaceId: string,
  messageId: string,
  msg: WAMessage,
): Promise<DownloadedMedia | null> {
  if (!msg.message) return null;

  const mediaKeys: Array<keyof typeof msg.message> = [
    'imageMessage',
    'videoMessage',
    'audioMessage',
    'documentMessage',
    'stickerMessage',
  ];
  const found = mediaKeys.find((k) => msg.message![k]);
  if (!found) return null;

  const mediaObj = msg.message[found] as
    | { mimetype?: string | null; fileName?: string | null }
    | undefined;
  const mimeType = mediaObj?.mimetype ?? 'application/octet-stream';
  const fileName = mediaObj?.fileName ?? undefined;

  try {
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: baileysLogger,
        reuploadRequest: async () => msg as never,
      },
    );
    if (!Buffer.isBuffer(buffer)) {
      logger.warn({ messageId }, 'downloadMediaMessage returned non-buffer');
      return null;
    }

    const ext = mimeToExt(mimeType);
    const safeName = fileName?.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `accounts/${workspaceId}/messages/${messageId}/${safeName ?? `media${ext}`}`;
    const url = await putMedia(key, buffer, mimeType);
    return { url, mimeType, size: buffer.length, fileName };
  } catch (err) {
    logger.error({ err, messageId }, 'Failed to download/store media');
    return null;
  }
}

function mimeToExt(mime: string): string {
  if (mime.startsWith('image/')) return `.${mime.split('/')[1]?.split(';')[0] ?? 'bin'}`;
  if (mime.startsWith('video/')) return `.${mime.split('/')[1]?.split(';')[0] ?? 'bin'}`;
  if (mime.startsWith('audio/')) return `.${mime.split('/')[1]?.split(';')[0] ?? 'bin'}`;
  if (mime === 'application/pdf') return '.pdf';
  return '.bin';
}

export function baileysMediaTypeFor(type: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT'): MessageType {
  switch (type) {
    case 'IMAGE':
      return 'imageMessage' as MessageType;
    case 'VIDEO':
      return 'videoMessage' as MessageType;
    case 'AUDIO':
      return 'audioMessage' as MessageType;
    case 'DOCUMENT':
      return 'documentMessage' as MessageType;
  }
}
