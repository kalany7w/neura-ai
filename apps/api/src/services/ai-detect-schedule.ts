import { env } from '../env.js';
import { logger } from '../logger.js';
import { publishEvent } from '../redis-pub.js';
import { UNTRUSTED_DATA_RULE, fenceUntrusted } from './ai-safety.js';

interface DetectResult {
  hasSchedule: boolean;
  suggestedDate?: string;
  suggestedTitle?: string;
  suggestedType?: 'APPLICATION' | 'MAINTENANCE' | 'REPAIR' | 'SALE_FOLLOWUP' | 'OTHER';
}

/**
 * Analisa o texto inbound do cliente. Se detecta intenção de agendar com data,
 * publica WS calendar.suggestion pro frontend mostrar banner.
 * Fire-and-forget. Falha silenciosa (sem OpenAI key → no-op).
 */
export async function detectSchedule(params: {
  workspaceId: string;
  conversationId: string;
  text: string;
}): Promise<void> {
  if (!env.OPENAI_API_KEY) return;
  const { workspaceId, conversationId, text } = params;
  if (text.trim().length < 8) return;

  const today = new Date().toISOString().slice(0, 10);
  // Mensagem do cliente é conteúdo NÃO CONFIÁVEL — vai cercada (fence) e com a
  // regra anti prompt-injection, como nos demais endpoints de IA.
  const prompt = `${UNTRUSTED_DATA_RULE}

Hoje é ${today}. Analise a mensagem do cliente (dentro de <dados_conversa>) e detecte se há intenção de agendar algo com data.

${fenceUntrusted(text)}

Responda APENAS um JSON válido:
{"hasSchedule": boolean, "suggestedDate": "YYYY-MM-DD" ou null, "suggestedTitle": "titulo curto" ou null, "suggestedType": "APPLICATION"|"MAINTENANCE"|"REPAIR"|"SALE_FOLLOWUP"|"OTHER" ou null}

Se não há data/agendamento claro, hasSchedule=false. Calcule datas relativas ("em 15 dias", "próxima semana") a partir de hoje.`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch(`${env.WHISPER_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.OPENAI_CHAT_MODEL ?? 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 150,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return;

    const parsed = JSON.parse(raw) as DetectResult;
    if (!parsed.hasSchedule || !parsed.suggestedDate) return;

    await publishEvent(workspaceId, 'calendar', 'calendar.suggestion', {
      conversationId,
      suggestedDate: parsed.suggestedDate,
      suggestedTitle: parsed.suggestedTitle ?? 'Evento sugerido',
      suggestedType: parsed.suggestedType ?? 'OTHER',
    });
  } catch (err) {
    logger.debug({ err, conversationId }, 'detectSchedule falhou (ignorado)');
  }
}
