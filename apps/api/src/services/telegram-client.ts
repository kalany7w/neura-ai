/**
 * Telegram Bot API client — wraps Bot API HTTPS endpoints.
 * Sem dep externa, só fetch nativo.
 *
 * Bot token format: `<botId>:<authToken>` (ex: 123456:ABC-xyz).
 * Storage: criptografado em Inbox.channelConfig.botTokenEncrypted via AES-256-GCM.
 */

import { logger } from '../logger.js';

const TG_BASE = 'https://api.telegram.org';

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export interface TelegramBotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface SendMessageOptions {
  parseMode?: 'HTML' | 'MarkdownV2';
  replyToMessageId?: number;
}

async function tgCall<T>(
  botToken: string,
  method: string,
  body?: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${TG_BASE}/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const data = (await res.json()) as TelegramApiResponse<T>;
    if (!data.ok) {
      throw new Error(
        `Telegram ${method} failed: ${data.description ?? `HTTP ${res.status}`}`,
      );
    }
    return data.result as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function getMe(botToken: string): Promise<TelegramBotInfo> {
  return tgCall<TelegramBotInfo>(botToken, 'getMe');
}

export async function setWebhook(opts: {
  botToken: string;
  url: string;
  secretToken?: string;
}): Promise<void> {
  await tgCall(opts.botToken, 'setWebhook', {
    url: opts.url,
    secret_token: opts.secretToken,
    allowed_updates: ['message', 'edited_message', 'callback_query'],
    drop_pending_updates: false,
  });
  logger.info({ url: opts.url }, 'Telegram webhook configured');
}

export async function deleteWebhook(botToken: string): Promise<void> {
  try {
    await tgCall(botToken, 'deleteWebhook', { drop_pending_updates: false });
  } catch (err) {
    logger.warn({ err }, 'Telegram deleteWebhook failed (continuing)');
  }
}

export async function sendMessage(opts: {
  botToken: string;
  chatId: string;
  text: string;
  options?: SendMessageOptions;
}): Promise<{ message_id: number }> {
  return tgCall<{ message_id: number }>(opts.botToken, 'sendMessage', {
    chat_id: opts.chatId,
    text: opts.text.slice(0, 4096),
    parse_mode: opts.options?.parseMode,
    reply_to_message_id: opts.options?.replyToMessageId,
    allow_sending_without_reply: true,
  });
}

export async function sendPhoto(opts: {
  botToken: string;
  chatId: string;
  photoUrl: string;
  caption?: string;
}): Promise<{ message_id: number }> {
  return tgCall<{ message_id: number }>(opts.botToken, 'sendPhoto', {
    chat_id: opts.chatId,
    photo: opts.photoUrl,
    caption: opts.caption?.slice(0, 1024),
  });
}

export async function sendDocument(opts: {
  botToken: string;
  chatId: string;
  documentUrl: string;
  caption?: string;
}): Promise<{ message_id: number }> {
  return tgCall<{ message_id: number }>(opts.botToken, 'sendDocument', {
    chat_id: opts.chatId,
    document: opts.documentUrl,
    caption: opts.caption?.slice(0, 1024),
  });
}

export async function getFile(opts: {
  botToken: string;
  fileId: string;
}): Promise<{ file_id: string; file_path?: string; file_size?: number }> {
  return tgCall<{ file_id: string; file_path?: string; file_size?: number }>(
    opts.botToken,
    'getFile',
    { file_id: opts.fileId },
  );
}

/**
 * Resolve URL pública pra baixar arquivo do Telegram (válida por 1h).
 */
export function fileDownloadUrl(botToken: string, filePath: string): string {
  return `${TG_BASE}/file/bot${botToken}/${filePath}`;
}

/**
 * Tipos Telegram Update / Message — subset necessário.
 */
export interface TgMessage {
  message_id: number;
  from?: { id: number; first_name?: string; last_name?: string; username?: string };
  chat: { id: number; first_name?: string; last_name?: string; username?: string; type: string };
  date: number;
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_size?: number; width: number; height: number }>;
  voice?: { file_id: string; duration: number; mime_type?: string };
  audio?: { file_id: string; duration: number; mime_type?: string };
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  video?: { file_id: string; duration: number; mime_type?: string };
  sticker?: { file_id: string; emoji?: string; is_animated?: boolean };
  location?: { latitude: number; longitude: number };
  reply_to_message?: TgMessage;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}
