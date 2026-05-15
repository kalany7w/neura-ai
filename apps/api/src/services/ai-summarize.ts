/**
 * Auto-summarize de conversa em 1-2 frases. Foca em:
 * - O que cliente quer (intent prático)
 * - Status atual (esperando, resolvido, em negociação)
 * - Próximo passo aparente
 *
 * Custo gpt-4o-mini: ~$0.0003 por chamada.
 */

import { env } from '../env.js';
import { logger } from '../logger.js';

export interface SummarizeInput {
  history: Array<{ direction: 'inbound' | 'outbound'; content: string }>;
  contactName: string | null;
}

const SUMMARIZE_TIMEOUT_MS = 15_000;

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export async function summarizeConversation(input: SummarizeInput): Promise<string | null> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return null;
  if (input.history.length === 0) return null;

  const system = [
    'Você resume conversas de atendimento WhatsApp em PT-BR.',
    'Retorne 1-2 frases (max 280 caracteres total) cobrindo:',
    '- O que o cliente quer/pediu',
    '- Status atual da conversa (aguardando agente, em negociação, resolvido, etc)',
    '- Próximo passo aparente, se óbvio',
    '',
    'Tom: objetivo e direto. Sem markdown. Sem prefixos como "Resumo:".',
    'NÃO copie o texto literal — sintetize.',
  ].join('\n');

  const lines: string[] = [];
  if (input.contactName) lines.push(`Cliente: ${input.contactName}`);
  lines.push('Conversa:');
  for (const m of input.history) {
    const trunc = m.content.slice(0, 300);
    lines.push(`[${m.direction === 'inbound' ? 'CLIENTE' : 'AGENTE'}] ${trunc}`);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SUMMARIZE_TIMEOUT_MS);
  try {
    const res = await fetch(`${env.WHISPER_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.OPENAI_CHAT_MODEL,
        temperature: 0.3,
        max_tokens: 150,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: lines.join('\n') },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'summarize: OpenAI error');
      return null;
    }
    const data = (await res.json()) as ChatCompletionResponse;
    const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
    return raw.slice(0, 400) || null;
  } catch (err) {
    logger.warn({ err }, 'summarize: fetch failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
