/**
 * Sugestões de resposta com IA. Usa OPENAI_API_KEY (mesma do Whisper).
 * Se OPENAI_API_KEY não está configurada, callers devem retornar 503.
 *
 * Custo: gpt-4o-mini ~$0.15/1M tokens input. Conversa de 10 msgs curtas
 * + prompt sistema cabem em ~500 tokens. Output 3 sugestões curtas ~200
 * tokens. Custo estimado por chamada: <$0.0005.
 */

import { env } from '../env.js';
import { logger } from '../logger.js';

export interface SuggestReplyInput {
  /** Direção da msg ('inbound' = cliente; 'outbound' = agente nosso) */
  direction: 'inbound' | 'outbound';
  /** Quem enviou — usado pra label no prompt */
  authorLabel: string;
  /** Texto da mensagem; pra mídia, breve descrição genérica */
  content: string;
  /** Timestamp pra ordenação (caller já deve passar em ordem cronológica asc) */
  at: Date;
}

export interface SuggestReplyContext {
  /** Nome do contato (do CRM), se houver */
  contactName: string | null;
  /** Nome do agente atual */
  agentName: string | null;
  /** Últimas N msgs em ordem cronológica asc (mais antiga primeiro) */
  history: SuggestReplyInput[];
  /** Hint extra do agente: "agradecer e oferecer demo", "informar atraso", etc */
  hint?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
}

const SUGGEST_TIMEOUT_MS = 20_000;

export async function suggestReplies(
  ctx: SuggestReplyContext,
  count: number = 3,
): Promise<string[]> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const systemPrompt = [
    'Você é um atendente profissional de WhatsApp respondendo clientes em PT-BR.',
    'Sua tarefa: sugerir respostas curtas, naturais, educadas e diretas pra última mensagem do cliente.',
    'Restrições:',
    '- Sempre PT-BR. Tom cordial e profissional, sem ser robótico.',
    '- Máximo 280 caracteres por sugestão.',
    `- Retorne EXATAMENTE ${count} sugestões diferentes entre si (uma curta, uma média, uma detalhada/com pergunta).`,
    '- NÃO use markdown, asteriscos, números no início, prefixos tipo "Resposta 1:".',
    '- Apenas o texto da resposta, uma por linha, separadas por \\n---\\n',
    '- NÃO repita o que o cliente disse, responda ao que ele perguntou.',
    '- Se for cumprimento, retorne 3 saudações em estilos diferentes.',
  ].join('\n');

  // Contextual user prompt
  const lines: string[] = [];
  if (ctx.contactName) lines.push(`Cliente: ${ctx.contactName}`);
  if (ctx.agentName) lines.push(`Agente atual: ${ctx.agentName}`);
  if (ctx.hint?.trim()) lines.push(`Hint do agente: ${ctx.hint.trim()}`);
  lines.push('');
  lines.push('Histórico da conversa (cronológico):');
  for (const m of ctx.history) {
    const truncated = m.content.slice(0, 400);
    lines.push(`[${m.authorLabel}] ${truncated}`);
  }
  lines.push('');
  lines.push(`Gere ${count} respostas que o agente pode mandar agora.`);

  const userPrompt = lines.join('\n');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SUGGEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${env.WHISPER_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.OPENAI_CHAT_MODEL,
        temperature: 0.7,
        max_tokens: 400,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as ChatCompletionResponse;
    const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!raw) return [];

    // Separar por "---" (instrução do prompt) ou por linha dupla
    const parts = raw
      .split(/\n\s*-{2,}\s*\n|\n{2,}/)
      .map((s) => s.trim())
      .map((s) =>
        s
          // Remove prefixos tipo "1." "1)" "- "
          .replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '')
          // Remove aspas de envolver
          .replace(/^["'`](.+)["'`]$/, '$1'),
      )
      .filter((s) => s.length > 0 && s.length <= 600);

    logger.info(
      { count: parts.length, model: env.OPENAI_CHAT_MODEL },
      'AI reply suggestions generated',
    );
    return parts.slice(0, count);
  } finally {
    clearTimeout(timer);
  }
}
