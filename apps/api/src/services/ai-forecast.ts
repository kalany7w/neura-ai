/**
 * Forecast IA por card kanban — IA estima probabilidade (0-1) de fechamento
 * baseado em últimas msgs da conversa linkada + valor + idade + stage.
 *
 * Retorna probability + reasoning curto pra agente entender o porquê.
 *
 * Custo gpt-4o-mini: ~$0.0004 por chamada.
 */

import { z } from 'zod';
import { env } from '../env.js';
import { logger } from '../logger.js';

export const forecastSchema = z.object({
  probability: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(280),
});

export type Forecast = z.infer<typeof forecastSchema>;

export interface ForecastInput {
  cardTitle: string;
  cardValue: number | null;
  cardCurrency: string;
  stageName: string;
  stageOutcome: 'POSITIVE' | 'NEGATIVE' | 'RISK' | null;
  ageDays: number;
  daysSinceLastMessage: number | null;
  history: Array<{ direction: 'inbound' | 'outbound'; content: string }>;
  contactName: string | null;
}

const FORECAST_TIMEOUT_MS = 20_000;

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export async function forecastCard(input: ForecastInput): Promise<Forecast | null> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const system = [
    'Você é um especialista em previsão de fechamento de vendas em PT-BR.',
    'Dado o estado de um card de vendas + histórico recente de conversa com o cliente,',
    'estime a probabilidade de fechamento (0.0 a 1.0) e justifique em 1 frase curta.',
    '',
    'Sinais que aumentam probabilidade:',
    '- Cliente fez perguntas específicas (preço, prazo, formas de pagamento)',
    '- Cliente expressou urgência ou demanda real',
    '- Cliente confirmou interesse / disponibilidade',
    '- Conversa recente, ativa',
    '',
    'Sinais que diminuem:',
    '- Cliente sumiu (sem msgs há muitos dias)',
    '- Cliente disse "vou pensar", "depois te falo"',
    '- Stage POSITIVE final = já fechou (1.0)',
    '- Stage NEGATIVE = perdido (0.0)',
    '- Hesitação, comparação com concorrentes sem retorno',
    '',
    'Retorne APENAS JSON: { "probability": 0.0-1.0, "reasoning": "<1 frase ≤280 chars>" }',
  ].join('\n');

  const lines: string[] = [];
  lines.push(`Card: ${input.cardTitle}`);
  if (input.cardValue) {
    lines.push(`Valor: ${input.cardCurrency} ${input.cardValue.toFixed(2)}`);
  }
  lines.push(`Stage: ${input.stageName}${input.stageOutcome ? ` (${input.stageOutcome})` : ''}`);
  lines.push(`Idade: ${input.ageDays} dia(s)`);
  if (input.daysSinceLastMessage != null) {
    lines.push(`Última msg há: ${input.daysSinceLastMessage} dia(s)`);
  }
  if (input.contactName) lines.push(`Cliente: ${input.contactName}`);
  lines.push('');
  if (input.history.length > 0) {
    lines.push('Histórico recente:');
    for (const m of input.history) {
      const trunc = m.content.slice(0, 250);
      lines.push(`[${m.direction === 'inbound' ? 'CLIENTE' : 'AGENTE'}] ${trunc}`);
    }
  } else {
    lines.push('(sem mensagens registradas)');
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FORECAST_TIMEOUT_MS);
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
      logger.warn({ status: res.status }, 'forecast: OpenAI error');
      return null;
    }
    const data = (await res.json()) as ChatCompletionResponse;
    const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const safe = forecastSchema.safeParse(parsed);
    if (!safe.success) {
      logger.warn({ issues: safe.error.issues.slice(0, 3) }, 'forecast: schema invalid');
      return null;
    }
    return safe.data;
  } catch (err) {
    logger.warn({ err }, 'forecast: fetch failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
