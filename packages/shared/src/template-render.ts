/**
 * Renderer de templates de mensagem.
 *
 * Sintaxe suportada:
 *   {{path}}                            → valor de `path` ou vazio se null/empty
 *   {{path | default 'fallback'}}       → fallback se vazio (aspas simples)
 *   {{path | default "fallback"}}       → idem com aspas duplas
 *   {{path | default fallback}}         → idem sem aspas (até espaço/})
 *   {{ path | default 'x' }}            → espaços tolerados
 *
 * Paths suportados:
 *   contact.name                        → nome completo
 *   contact.firstName                   → primeiro token de contact.name
 *   contact.phoneNumber                 → telefone E.164
 *   inbox.name                          → nome da inbox/canal
 *   agent.name                          → nome do agente (quando aplicável)
 *
 * Sem dependências externas — pode rodar em waworker, api e web.
 */

export interface TemplateVars {
  contact?: {
    name?: string | null;
    phoneNumber?: string | null;
  };
  agent?: {
    name?: string | null;
  };
  inbox?: {
    name?: string | null;
  };
}

export interface TemplateVariableDef {
  name: string;
  description: string;
  exampleFallback?: string;
}

/**
 * Lista canônica de variáveis — usada pela UI pra mostrar quais
 * placeholders estão disponíveis no editor de template.
 */
export const TEMPLATE_VARIABLES: TemplateVariableDef[] = [
  {
    name: 'contact.name',
    description: 'Nome completo do contato (vazio se sem nome)',
    exampleFallback: 'cliente',
  },
  {
    name: 'contact.firstName',
    description: 'Primeiro nome do contato (primeiro token de contact.name)',
    exampleFallback: 'amigo',
  },
  {
    name: 'contact.phoneNumber',
    description: 'Telefone no formato E.164 (+5511…)',
  },
  {
    name: 'inbox.name',
    description: 'Nome da inbox/canal de origem',
  },
  {
    name: 'agent.name',
    description: 'Nome do agente que está enviando (quando aplicável)',
  },
];

// Captura: 1=path, 2=fallback entre aspas simples, 3=fallback entre aspas duplas,
//         4=fallback raw (sem aspas). Grupo de fallback é opcional.
const PLACEHOLDER_RE =
  /\{\{\s*([\w.]+)\s*(?:\|\s*default\s+(?:'([^']*)'|"([^"]*)"|([^\s}]+)))?\s*\}\}/g;

function resolvePath(vars: TemplateVars, path: string): string {
  // Special case: contact.firstName deriva de contact.name
  if (path === 'contact.firstName') {
    const name = vars.contact?.name?.trim();
    if (!name) return '';
    const first = name.split(/\s+/)[0];
    return first ?? '';
  }

  const parts = path.split('.');
  let cur: unknown = vars;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return '';
    }
  }
  if (cur == null) return '';
  if (typeof cur === 'string') return cur;
  if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
  // Object/array: não interpolável
  return '';
}

/**
 * Renderiza um template substituindo placeholders por valores.
 * Placeholders desconhecidos viram string vazia (ou fallback se especificado).
 */
export function renderTemplate(body: string, vars: TemplateVars): string {
  return body.replace(PLACEHOLDER_RE, (_match, path, q1, q2, raw) => {
    const value = resolvePath(vars, path);
    if (value && value.trim().length > 0) return value;
    const fallback = q1 ?? q2 ?? raw;
    return fallback ?? '';
  });
}
