/**
 * Next-action suggestion — IA propõe próximas ações na conversa.
 * Retorna array de 1-3 ações que o agente pode aceitar com 1 click.
 *
 * Cada action é discriminada por `kind` — frontend renderiza UI apropriada
 * e POSTa o endpoint correspondente quando agente aceita.
 *
 * Custo gpt-4o-mini: ~$0.0004 por chamada.
 */

import { z } from 'zod';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { UNTRUSTED_DATA_RULE } from './ai-safety.js';

export const nextActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('assign_agent'),
    agentSlug: z.string().min(1).max(40),
    reason: z.string().min(1).max(200),
    confidence: z.number().min(0).max(1),
  }),
  z.object({
    kind: z.literal('apply_label'),
    labelName: z.string().min(1).max(40),
    reason: z.string().min(1).max(200),
    confidence: z.number().min(0).max(1),
  }),
  z.object({
    kind: z.literal('set_status'),
    status: z.enum(['OPEN', 'PENDING', 'RESOLVED', 'SNOOZED']),
    reason: z.string().min(1).max(200),
    confidence: z.number().min(0).max(1),
  }),
  z.object({
    kind: z.literal('send_template'),
    templateName: z.string().min(1).max(80),
    reason: z.string().min(1).max(200),
    confidence: z.number().min(0).max(1),
  }),
  z.object({
    kind: z.literal('move_card_stage'),
    stageName: z.string().min(1).max(80),
    reason: z.string().min(1).max(200),
    confidence: z.number().min(0).max(1),
  }),
]);

export const nextActionsResponseSchema = z.object({
  actions: z.array(nextActionSchema).max(3),
});

export type NextAction = z.infer<typeof nextActionSchema>;

export interface NextActionInput {
  history: Array<{ direction: 'inbound' | 'outbound'; content: string }>;
  contactName: string | null;
  currentAgentSlug: string | null;
  availableAgents: Array<{ slug: string; name: string | null }>;
  availableLabels: Array<{ name: string; color: string }>;
  availableTemplates: Array<{ name: string; shortcut: string | null }>;
  availableStages: Array<{ name: string; outcome: 'POSITIVE' | 'NEGATIVE' | 'RISK' | null }>;
  currentStatus: 'OPEN' | 'PENDING' | 'RESOLVED' | 'SNOOZED';
  currentStageName: string | null;
}

const TIMEOUT_MS = 20_000;

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export async function suggestNextActions(input: NextActionInput): Promise<NextAction[]> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return [];
  if (input.history.length === 0) return [];

  const system = [
    'Você sugere PRÓXIMAS AÇÕES que um agente de atendimento pode tomar agora.',
    'Analise o contexto e retorne até 3 ações úteis em ordem de prioridade.',
    '',
    'TIPOS DE AÇÃO (use o slug/name LITERAL das listas fornecidas):',
    '- assign_agent: passar pra colega específico (use agentSlug da lista)',
    '- apply_label: marcar conversa com etiqueta (use labelName da lista)',
    '- set_status: mudar status (OPEN|PENDING|RESOLVED|SNOOZED)',
    '- send_template: sugerir template pronto (use templateName da lista)',
    '- move_card_stage: mover card no kanban (use stageName da lista, só se faz sentido)',
    '',
    'Sugira ações que sejam ÓBVIAS e ÚTEIS. Não invente.',
    'Se nada é claramente útil, retorne actions vazio.',
    'NÃO sugira ações cujo nome/slug NÃO esteja nas listas.',
    'reason: 1 frase curta explicando POR QUE essa ação agora.',
    'confidence: 0-1 sua certeza dessa sugestão.',
    '',
    'Retorne APENAS JSON: { "actions": [...] }',
    UNTRUSTED_DATA_RULE,
  ].join('\n');

  const lines: string[] = [];
  lines.push('=== CONTEXTO ===');
  if (input.contactName) lines.push(`Cliente: ${input.contactName}`);
  lines.push(`Status atual: ${input.currentStatus}`);
  if (input.currentAgentSlug) lines.push(`Agente atual: @${input.currentAgentSlug}`);
  else lines.push('Sem agente atribuído.');
  if (input.currentStageName) lines.push(`Stage kanban atual: ${input.currentStageName}`);
  lines.push('');
  lines.push('=== AGENTES DISPONÍVEIS ===');
  for (const a of input.availableAgents.slice(0, 20)) {
    lines.push(`- @${a.slug} ${a.name ? `(${a.name})` : ''}`);
  }
  if (input.availableLabels.length > 0) {
    lines.push('');
    lines.push('=== ETIQUETAS DISPONÍVEIS ===');
    for (const l of input.availableLabels.slice(0, 30)) {
      lines.push(`- ${l.name}`);
    }
  }
  if (input.availableTemplates.length > 0) {
    lines.push('');
    lines.push('=== TEMPLATES DISPONÍVEIS ===');
    for (const t of input.availableTemplates.slice(0, 30)) {
      lines.push(`- ${t.name}${t.shortcut ? ` (${t.shortcut})` : ''}`);
    }
  }
  if (input.availableStages.length > 0) {
    lines.push('');
    lines.push('=== STAGES KANBAN DISPONÍVEIS ===');
    for (const s of input.availableStages.slice(0, 30)) {
      lines.push(`- ${s.name}${s.outcome ? ` [${s.outcome}]` : ''}`);
    }
  }
  lines.push('');
  lines.push('=== ÚLTIMAS MENSAGENS ===');
  lines.push('<dados_conversa>');
  for (const m of input.history) {
    const trunc = m.content.slice(0, 250).replace(/<\/?dados_conversa>/gi, '');
    lines.push(`[${m.direction === 'inbound' ? 'CLIENTE' : 'AGENTE'}] ${trunc}`);
  }
  lines.push('</dados_conversa>');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
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
        max_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: lines.join('\n') },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'next-action: OpenAI error');
      return [];
    }
    const data = (await res.json()) as ChatCompletionResponse;
    const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    const safe = nextActionsResponseSchema.safeParse(parsed);
    if (!safe.success) {
      logger.warn({ issues: safe.error.issues.slice(0, 3) }, 'next-action: schema invalid');
      return [];
    }
    // Filter actions cujo slug/name não bate com listas fornecidas (anti-alucinação)
    const validAgentSlugs = new Set(input.availableAgents.map((a) => a.slug));
    const validLabelNames = new Set(input.availableLabels.map((l) => l.name.toLowerCase()));
    const validTemplateNames = new Set(input.availableTemplates.map((t) => t.name.toLowerCase()));
    const validStageNames = new Set(input.availableStages.map((s) => s.name.toLowerCase()));
    return safe.data.actions.filter((a) => {
      if (a.kind === 'assign_agent') return validAgentSlugs.has(a.agentSlug);
      if (a.kind === 'apply_label') return validLabelNames.has(a.labelName.toLowerCase());
      if (a.kind === 'send_template') return validTemplateNames.has(a.templateName.toLowerCase());
      if (a.kind === 'move_card_stage') return validStageNames.has(a.stageName.toLowerCase());
      return true; // set_status já validado pelo enum
    });
  } catch (err) {
    logger.warn({ err }, 'next-action: fetch failed');
    return [];
  } finally {
    clearTimeout(timer);
  }
}
