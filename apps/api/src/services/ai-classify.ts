/**
 * Auto-classify de conversa — IA analisa últimas msgs e retorna:
 * - intent: sale | support | complaint | info | other
 * - urgency: low | medium | high | critical
 * - sentiment: positive | neutral | negative
 * - confidence: 0-1
 *
 * Custo gpt-4o-mini: ~$0.0003 por chamada.
 * Triggered: após msg INBOUND (debounced 30s) + manual on-demand.
 */

import { z } from 'zod';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { UNTRUSTED_DATA_RULE } from './ai-safety.js';

export const CLASSIFICATION_INTENTS = ['sale', 'support', 'complaint', 'info', 'other'] as const;
export const CLASSIFICATION_URGENCY = ['low', 'medium', 'high', 'critical'] as const;
export const CLASSIFICATION_SENTIMENT = ['positive', 'neutral', 'negative'] as const;

export type ClassificationIntent = (typeof CLASSIFICATION_INTENTS)[number];
export type ClassificationUrgency = (typeof CLASSIFICATION_URGENCY)[number];
export type ClassificationSentiment = (typeof CLASSIFICATION_SENTIMENT)[number];

export const classificationSchema = z.object({
  intent: z.enum(CLASSIFICATION_INTENTS),
  urgency: z.enum(CLASSIFICATION_URGENCY),
  sentiment: z.enum(CLASSIFICATION_SENTIMENT),
  confidence: z.number().min(0).max(1),
  topics: z.array(z.string().min(1).max(40)).max(5).optional(),
});

export type Classification = z.infer<typeof classificationSchema>;

export interface ClassifyInput {
  history: Array<{ direction: 'inbound' | 'outbound'; content: string }>;
  contactName: string | null;
}

const CLASSIFY_TIMEOUT_MS = 15_000;

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export async function classifyConversation(input: ClassifyInput): Promise<Classification | null> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return null;
  if (input.history.length === 0) return null;

  const system = [
    'Você é um classificador de conversas de atendimento WhatsApp em PT-BR.',
    'Analise o histórico e retorne APENAS um JSON válido (sem markdown, sem comentários) com:',
    '- intent: sale (cliente quer comprar/contratar) | support (dúvida técnica/uso) | complaint (reclamação/problema) | info (busca informação geral) | other',
    '- urgency: low | medium | high | critical (use critical se cliente está irritado, ameaça cancelar, ou problema crítico em produção)',
    '- sentiment: positive | neutral | negative',
    '- confidence: 0.0-1.0 sua certeza geral',
    '- topics: array de até 5 temas curtos (1-3 palavras cada) que apareceram',
    '',
    'IMPORTANTE: retorne SOMENTE o JSON, nada mais.',
    UNTRUSTED_DATA_RULE,
  ].join('\n');

  const lines: string[] = [];
  if (input.contactName) lines.push(`Cliente: ${input.contactName}`);
  lines.push('Histórico:');
  lines.push('<dados_conversa>');
  for (const m of input.history) {
    const trunc = m.content.slice(0, 300).replace(/<\/?dados_conversa>/gi, '');
    lines.push(`[${m.direction === 'inbound' ? 'CLIENTE' : 'AGENTE'}] ${trunc}`);
  }
  lines.push('</dados_conversa>');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CLASSIFY_TIMEOUT_MS);
  try {
    const res = await fetch(`${env.WHISPER_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.OPENAI_CHAT_MODEL,
        temperature: 0.2,
        max_tokens: 200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: lines.join('\n') },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn({ status: res.status, text: text.slice(0, 200) }, 'classify: OpenAI error');
      return null;
    }
    const data = (await res.json()) as ChatCompletionResponse;
    const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn({ raw: raw.slice(0, 200) }, 'classify: JSON parse failed');
      return null;
    }
    const safe = classificationSchema.safeParse(parsed);
    if (!safe.success) {
      logger.warn(
        { issues: safe.error.issues.slice(0, 3), raw: raw.slice(0, 200) },
        'classify: schema validation failed',
      );
      return null;
    }
    return safe.data;
  } catch (err) {
    logger.warn({ err }, 'classify: fetch failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
