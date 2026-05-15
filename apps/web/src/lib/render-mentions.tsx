import { Fragment, type ReactNode } from 'react';

const MENTION_RE = /@([a-z0-9_.]{2,32})/gi;

function isValidMentionPosition(body: string, atIndex: number): boolean {
  if (atIndex === 0) return true;
  const prev = body[atIndex - 1];
  if (!prev) return true;
  return /[\s(\[\{,;:]/.test(prev);
}

/**
 * Renderiza um body de nota destacando @slug como pill colorida.
 * Quando validSlugs é fornecido, só destaca os que estão nele.
 * Skipa @ em posições não-delimitadas (email "x@gmail.com" não vira mention).
 * Mantém quebras de linha (whitespace-pre-wrap deve estar no parent).
 */
export function renderMentions(body: string, validSlugs?: Set<string>): ReactNode {
  if (!body) return body;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of body.matchAll(MENTION_RE)) {
    const idx = match.index ?? 0;
    if (!isValidMentionPosition(body, idx)) continue;
    const slug = match[1]?.toLowerCase() ?? '';
    const isValid = !validSlugs || validSlugs.has(slug);
    if (idx > cursor) parts.push(body.slice(cursor, idx));
    if (isValid) {
      parts.push(
        <span
          key={`m-${idx}`}
          className="rounded bg-indigo-500/15 px-1 py-0.5 font-medium text-indigo-700 dark:bg-indigo-400/20 dark:text-indigo-300"
        >
          @{slug}
        </span>,
      );
    } else {
      parts.push(match[0]);
    }
    cursor = idx + match[0].length;
  }
  if (cursor < body.length) parts.push(body.slice(cursor));
  return parts.map((p, i) => <Fragment key={i}>{p}</Fragment>);
}
