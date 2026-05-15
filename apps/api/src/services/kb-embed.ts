/**
 * Geração de embeddings via OpenAI Embeddings API.
 *
 * Modelo: text-embedding-3-small (1536 dim, $0.02/1M tokens — desprezível).
 * Custo médio por artigo de KB: <$0.0001.
 *
 * Retorna `null` se OPENAI_API_KEY não estiver configurada — callers devem
 * lidar com degradação silenciosa (não enfileirar, não estourar 500).
 */

import { env } from '../env';
import { logger } from '../logger';

export const KB_EMBED_DIM = 1536;
export const KB_EMBED_MODEL = 'text-embedding-3-small';

interface EmbeddingsResponse {
  data?: Array<{ embedding?: number[] }>;
}

const EMBED_TIMEOUT_MS = 30_000;
// OpenAI text-embedding-3-small aceita até ~8191 tokens. Truncamos pra ficar
// seguramente abaixo desse limite (1 token ≈ 4 chars em português; 24000 chars
// dá ~6k tokens, sobrando margem).
const MAX_INPUT_CHARS = 24_000;

export async function generateEmbedding(text: string): Promise<number[] | null> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const input = text.trim();
  if (!input) return null;

  const truncated = input.slice(0, MAX_INPUT_CHARS);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EMBED_TIMEOUT_MS);
  try {
    const res = await fetch(`${env.WHISPER_API_BASE}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: KB_EMBED_MODEL,
        input: truncated,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: text.slice(0, 200) }, 'embed: OpenAI error');
      return null;
    }
    const data = (await res.json()) as EmbeddingsResponse;
    const vec = data.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length !== KB_EMBED_DIM) {
      logger.warn({ len: vec?.length }, 'embed: invalid vector length');
      return null;
    }
    return vec;
  } catch (err) {
    logger.warn({ err }, 'embed: fetch failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Formata um vetor JS como literal pgvector aceito pelo Postgres:
 * `[0.123,0.456,...]` (sem espaços extras, dim total). Usado em
 * `$executeRaw` / `$queryRaw` pra escrever/comparar embeddings.
 */
export function formatVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}
