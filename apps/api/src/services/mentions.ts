import { prisma } from '../db';

export type MentionTarget = {
  userId: string;
  name: string | null;
  email: string;
};

const COMBINING_DIACRITICALS = /[̀-ͯ]/g;

/**
 * Slug usado em @mentions: deriva do firstName lowercased (sem acento/simbolo),
 * caindo pra prefixo do email se nome nao da pra slugificar.
 *
 * Ex: "Joao Silva" -> "joao"; sem nome com email "maria.santos@x.com" -> "maria.santos".
 * Quando 2+ pessoas geram o mesmo slug (ex: dois "Joao"), o desempate e numerico:
 * primeira pessoa pega "joao", segunda "joao2", terceira "joao3", etc.
 * O slug e estavel dentro de uma resposta porque resolvemos por ordem
 * alfabetica de userId.
 */
function slugifyBase(name: string | null, email: string): string {
  const candidate = (name?.split(/\s+/)[0] ?? email.split('@')[0] ?? '').toLowerCase();
  const cleaned = candidate
    .normalize('NFD')
    .replace(COMBINING_DIACRITICALS, '')
    .replace(/[^a-z0-9_.]/g, '');
  return cleaned || 'user';
}

export function buildMentionTargets(
  members: Array<{ userId: string; user: { name: string | null; email: string } }>,
): Array<MentionTarget & { slug: string }> {
  const sorted = [...members].sort((a, b) => a.userId.localeCompare(b.userId));
  const slugCounts = new Map<string, number>();
  return sorted.map((m) => {
    const base = slugifyBase(m.user.name, m.user.email);
    const used = slugCounts.get(base) ?? 0;
    slugCounts.set(base, used + 1);
    const slug = used === 0 ? base : `${base}${used + 1}`;
    return {
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      slug,
    };
  });
}

const MENTION_RE = /@([a-z0-9_.]{2,32})/gi;

/**
 * Confirma que o `@` está num delimitador válido (início ou após whitespace/punctuation),
 * evitando falsos positivos como "joao@gmail.com" virar mention.
 */
function isValidMentionPosition(body: string, atIndex: number): boolean {
  if (atIndex === 0) return true;
  const prev = body[atIndex - 1];
  if (!prev) return true;
  return /[\s(\[\{,;:]/.test(prev);
}

export function parseMentions(
  body: string,
  targets: Array<{ slug: string; userId: string }>,
): string[] {
  if (!body) return [];
  const slugMap = new Map(targets.map((t) => [t.slug.toLowerCase(), t.userId]));
  const found = new Set<string>();
  for (const match of body.matchAll(MENTION_RE)) {
    const idx = match.index ?? 0;
    if (!isValidMentionPosition(body, idx)) continue;
    const slug = match[1]?.toLowerCase();
    if (!slug) continue;
    const userId = slugMap.get(slug);
    if (userId) found.add(userId);
  }
  return Array.from(found);
}

/**
 * Cria notifications pros agentes mencionados numa nota.
 * Skip silenciosamente o autor (nao notifica quem se auto-mencionou).
 */
export async function createMentionNotifications(opts: {
  workspaceId: string;
  authorId: string;
  authorName: string | null;
  mentionedUserIds: string[];
  link: string;
  context: string; // ex: "no contato Maria Silva", "na conversa com Joao"
  bodyPreview: string;
}): Promise<void> {
  const ids = opts.mentionedUserIds.filter((id) => id !== opts.authorId);
  if (ids.length === 0) return;
  const author = opts.authorName?.split(' ')[0] ?? 'Alguem';
  const preview = opts.bodyPreview.slice(0, 140);
  await prisma.notification.createMany({
    data: ids.map((userId) => ({
      workspaceId: opts.workspaceId,
      userId,
      kind: 'note.mention',
      title: `${author} te mencionou`,
      body: `${opts.context}: ${preview}`,
      link: opts.link,
      metadata: { authorId: opts.authorId },
    })),
  });
}
