import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_TRANSCRIBE, type TranscribeJob } from '@neura/shared/queue';
import { prisma } from './db.js';
import { logger } from './logger.js';
import { env } from './env.js';
import { publishEvent } from './redis-pub.js';
import { getMediaBuffer, keyFromUrl } from './services/storage.js';

const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

// Whisper API aceita: mp3, mp4, mpeg, mpga, m4a, wav, webm, ogg, flac
const WHISPER_MIME_TO_EXT: Record<string, string> = {
  'audio/ogg': '.ogg',
  'audio/ogg; codecs=opus': '.ogg',
  'audio/opus': '.ogg',
  'audio/webm': '.webm',
  'audio/webm;codecs=opus': '.webm',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/flac': '.flac',
};

function extForMime(mime: string | null | undefined): string {
  if (!mime) return '.ogg';
  const lower = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  return WHISPER_MIME_TO_EXT[lower] ?? WHISPER_MIME_TO_EXT[mime.toLowerCase()] ?? '.ogg';
}

interface WhisperResponse {
  text?: string;
}

async function callWhisper(
  buffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<string> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const form = new FormData();
  // Note: Blob/File globals (Node 18+) — usa filename pra dica de formato pro Whisper
  const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
  form.append('file', blob, filename);
  form.append('model', env.WHISPER_MODEL);
  // Sem language hint fixo — Whisper auto-detecta o idioma. (Hint fixo 'pt' degradava
  // áudios em espanhol e outros idiomas; auto-detect é neutro pra multi-tenant.)
  form.append('response_format', 'json');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000); // 90s — áudios podem demorar
  try {
    const res = await fetch(`${env.WHISPER_API_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Whisper HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as WhisperResponse;
    if (!data.text || typeof data.text !== 'string') {
      throw new Error('Whisper response missing text');
    }
    return data.text.trim();
  } finally {
    clearTimeout(timer);
  }
}

export const transcribeWorker = new Worker<TranscribeJob>(
  QUEUE_TRANSCRIBE,
  async (job: Job<TranscribeJob>) => {
    const { workspaceId, messageId } = job.data;
    const msg = await prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        type: true,
        mediaUrl: true,
        mediaMimeType: true,
        transcription: true,
        transcriptionStatus: true,
      },
    });
    if (!msg) {
      logger.warn({ messageId }, 'transcribe: message not found');
      return;
    }
    if (msg.type !== 'AUDIO') {
      logger.warn({ messageId, type: msg.type }, 'transcribe: not AUDIO, skip');
      return;
    }
    if (msg.transcriptionStatus === 'COMPLETED' && msg.transcription) {
      return;
    }
    if (!msg.mediaUrl) {
      throw new Error(`Message ${messageId} has no mediaUrl`);
    }

    if (msg.transcriptionStatus !== 'PENDING') {
      await prisma.message.update({
        where: { id: messageId },
        data: { transcriptionStatus: 'PENDING' },
      });
    }

    const key = keyFromUrl(msg.mediaUrl);
    if (!key) throw new Error(`Cannot resolve MinIO key from ${msg.mediaUrl}`);
    const buffer = await getMediaBuffer(key);
    const ext = extForMime(msg.mediaMimeType);
    const filename = `audio-${messageId}${ext}`;

    const text = await callWhisper(buffer, filename, msg.mediaMimeType ?? 'audio/ogg');

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { transcription: text, transcriptionStatus: 'COMPLETED' },
    });
    await publishEvent(workspaceId, 'messages', 'message.transcribed', {
      messageId: updated.id,
      conversationId: updated.conversationId,
      transcription: text,
    });
    logger.info({ messageId, chars: text.length }, 'message transcribed');
  },
  { connection: bullConnection, concurrency: 2 },
);

transcribeWorker.on('failed', async (job, err) => {
  if (!job) return;
  const attempts = job.attemptsMade ?? 0;
  const max = job.opts?.attempts ?? 1;
  logger.error({ err, jobId: job.id, attempts, max }, 'transcribe job failed');
  if (attempts >= max) {
    await prisma.message
      .update({
        where: { id: job.data.messageId },
        data: { transcriptionStatus: 'FAILED' },
      })
      .catch(() => {});
  }
});
