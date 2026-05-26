/**
 * Parser de resposta do welcome flow. Identifica qual WelcomeOption o cliente
 * escolheu a partir de buttonReply, número, label ou keyword. Fallback final:
 * fuzzy match via OpenAI (gpt-4o-mini, temperature 0, ~50 tokens output).
 *
 * Usa fetch direto pra OpenAI (mesmo padrão do ai-suggest, ai-classify etc) —
 * sem dep do SDK oficial.
 */

import { env } from '../env.js';
import { logger } from '../logger.js';

export interface WelcomeOptionLite {
  id: string;
  position: number;
  label: string;
  matchKeywords: string[];
}

export type ReplyInput =
  | { kind: 'button_reply'; rowId: string; selectedDisplayText?: string }
  | { kind: 'text'; text: string }
  | { kind: 'audio'; transcript: string };

interface ParserDeps {
  fuzzyMatchFn?: (text: string, options: WelcomeOptionLite[]) => Promise<string | null>;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
}

const FUZZY_TIMEOUT_MS = 15_000;

/**
 * Fuzzy match via OpenAI. Recebe texto livre + opções, retorna id ou null.
 */
async function defaultFuzzyMatch(
  text: string,
  options: WelcomeOptionLite[],
): Promise<string | null> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY não configurada — fuzzy match indisponível');
    return null;
  }

  const optList = options
    .map(
      (o) =>
        `${o.position}. id=${o.id} | ${o.label} | keywords: ${o.matchKeywords.join(', ') || '(nenhuma)'}`,
    )
    .join('\n');

  const prompt = `Você é um classificador. O cliente disse: "${text}"

Opções disponíveis:
${optList}

Retorne SOMENTE o id da opção mais adequada, ou "none" se nenhuma se aplica claramente.`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FUZZY_TIMEOUT_MS);
  try {
    const res = await fetch(`${env.WHISPER_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.OPENAI_CHAT_MODEL,
        temperature: 0,
        max_tokens: 50,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      logger.error(
        { status: res.status, body: errText.slice(0, 300) },
        'OpenAI fuzzy match HTTP error',
      );
      return null;
    }
    const data = (await res.json()) as ChatCompletionResponse;
    const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!raw || raw.toLowerCase() === 'none') return null;
    // Aceitar resposta com qualquer prefixo/sufixo — só o id matters
    const match = options.find((o) => raw.includes(o.id));
    return match?.id ?? null;
  } catch (err) {
    logger.error({ err }, 'OpenAI fuzzy match falhou');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const normalize = (s: string): string => s.trim().toLowerCase();

/**
 * Identifica qual WelcomeOption o cliente escolheu. Estratégias em ordem:
 * 1. buttonReply.rowId → match exato
 * 2. text == número (1, 2, 3, "1.") → match por position
 * 3. text == label normalizado → match por label
 * 4. text contém qualquer matchKeyword → match por keyword
 * 5. Fallback: OpenAI fuzzy match
 */
export async function parseReply(
  input: ReplyInput,
  options: WelcomeOptionLite[],
  deps: ParserDeps = {},
): Promise<WelcomeOptionLite | null> {
  const fuzzy = deps.fuzzyMatchFn ?? defaultFuzzyMatch;

  // 1. buttonReply
  if (input.kind === 'button_reply') {
    return options.find((o) => o.id === input.rowId) ?? null;
  }

  const rawText = input.kind === 'text' ? input.text : input.transcript;
  const text = normalize(rawText);
  if (!text) return null;

  // 2. Match por número
  const numMatch = text.match(/^(\d{1,2})[.)]?$/);
  if (numMatch) {
    const pos = parseInt(numMatch[1]!, 10);
    return options.find((o) => o.position === pos) ?? null;
  }

  // 3. Match exato por label
  const byLabel = options.find((o) => normalize(o.label) === text);
  if (byLabel) return byLabel;

  // 4. Match por keyword (substring)
  const byKeyword = options.find((o) =>
    o.matchKeywords.some((k) => k.trim() !== '' && text.includes(normalize(k))),
  );
  if (byKeyword) return byKeyword;

  // 5. Fuzzy fallback
  const fuzzyId = await fuzzy(rawText, options);
  return fuzzyId ? (options.find((o) => o.id === fuzzyId) ?? null) : null;
}
