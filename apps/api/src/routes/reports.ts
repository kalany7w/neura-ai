import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, type AuthVars } from '../middlewares/auth';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace';

export const reportsRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

const rangeSchema = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
});

function parseRange(c: { req: { url: string } }): { since: Date; until: Date } {
  const params = Object.fromEntries(new URL(c.req.url).searchParams);
  const parsed = rangeSchema.safeParse(params);
  const until = parsed.success && parsed.data.until ? new Date(parsed.data.until) : new Date();
  const since =
    parsed.success && parsed.data.since
      ? new Date(parsed.data.since)
      : new Date(until.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { since, until };
}

/**
 * FRT (first response time) por conversa: tempo entre primeira INBOUND
 * e primeira OUTBOUND posterior a ela, em segundos.
 */
async function computeFrt(
  workspaceId: string,
  since: Date,
  until: Date,
): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<
    Array<{ conversationId: string; frt: number | null }>
  >`
    SELECT
      c.id AS "conversationId",
      EXTRACT(EPOCH FROM (MIN(out_msg."createdAt") - MIN(in_msg."createdAt")))::int AS frt
    FROM conversations c
    JOIN messages in_msg ON in_msg."conversationId" = c.id AND in_msg.direction = 'INBOUND'
    LEFT JOIN messages out_msg
      ON out_msg."conversationId" = c.id
     AND out_msg.direction = 'OUTBOUND'
     AND out_msg."createdAt" > in_msg."createdAt"
    WHERE c."workspaceId" = ${workspaceId}
      AND c."createdAt" >= ${since}
      AND c."createdAt" <= ${until}
    GROUP BY c.id
    HAVING MIN(out_msg."createdAt") IS NOT NULL
  `;
  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.frt !== null && r.frt >= 0) map.set(r.conversationId, r.frt);
  }
  return map;
}

function stats(values: number[]): { count: number; avg: number; p50: number; p90: number } {
  if (values.length === 0) return { count: 0, avg: 0, p50: 0, p90: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const idx50 = Math.floor(sorted.length * 0.5);
  const idx90 = Math.floor(sorted.length * 0.9);
  return {
    count: sorted.length,
    avg: Math.round(sum / sorted.length),
    p50: sorted[idx50] ?? 0,
    p90: sorted[idx90] ?? 0,
  };
}

function formatHumanDuration(seconds: number): string {
  if (seconds <= 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem > 0 ? `${h}h ${rem}min` : `${h}h`;
}

reportsRouter.get('/overview', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const { since, until } = parseRange(c);

  const [convsByStatus, msgsByDirection, frtMap, cardsByOutcome] = await Promise.all([
    prisma.conversation.groupBy({
      by: ['status'],
      where: { workspaceId, createdAt: { gte: since, lte: until } },
      _count: true,
    }),
    prisma.message.groupBy({
      by: ['direction'],
      where: {
        conversation: { workspaceId },
        createdAt: { gte: since, lte: until },
      },
      _count: true,
    }),
    computeFrt(workspaceId, since, until),
    prisma.card.findMany({
      where: {
        workspaceId,
        createdAt: { gte: since, lte: until },
        stage: { outcome: { in: ['POSITIVE', 'NEGATIVE'] } },
      },
      include: { stage: { select: { outcome: true } } },
    }),
  ]);

  const conversationsByStatus = {
    OPEN: 0,
    PENDING: 0,
    RESOLVED: 0,
    SNOOZED: 0,
  } as Record<string, number>;
  let totalConversations = 0;
  for (const g of convsByStatus) {
    conversationsByStatus[g.status] = g._count;
    totalConversations += g._count;
  }

  const messagesByDirection = { INBOUND: 0, OUTBOUND: 0 } as Record<string, number>;
  let totalMessages = 0;
  for (const g of msgsByDirection) {
    messagesByDirection[g.direction] = g._count;
    totalMessages += g._count;
  }

  const frtStats = stats(Array.from(frtMap.values()));

  let positive = 0;
  let negative = 0;
  let positiveValue = 0;
  let negativeValue = 0;
  for (const card of cardsByOutcome) {
    if (card.stage.outcome === 'POSITIVE') {
      positive++;
      positiveValue += Number(card.value ?? 0);
    } else if (card.stage.outcome === 'NEGATIVE') {
      negative++;
      negativeValue += Number(card.value ?? 0);
    }
  }
  const conversionRate =
    positive + negative > 0 ? Math.round((positive / (positive + negative)) * 100) : null;

  return c.json({
    range: { since: since.toISOString(), until: until.toISOString() },
    conversations: { total: totalConversations, byStatus: conversationsByStatus },
    messages: { total: totalMessages, byDirection: messagesByDirection },
    firstResponseTime: {
      ...frtStats,
      avgHuman: formatHumanDuration(frtStats.avg),
      p50Human: formatHumanDuration(frtStats.p50),
      p90Human: formatHumanDuration(frtStats.p90),
    },
    pipeline: {
      positive,
      negative,
      positiveValue,
      negativeValue,
      conversionRate,
    },
  });
});

reportsRouter.get('/agents', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const { since, until } = parseRange(c);

  const members = await prisma.membership.findMany({
    where: { workspaceId },
    include: { user: { select: { id: true, name: true, email: true } } },
  });

  const convsAssigned = await prisma.conversation.groupBy({
    by: ['assignedAgentId', 'status'],
    where: {
      workspaceId,
      createdAt: { gte: since, lte: until },
      assignedAgentId: { in: members.map((m) => m.userId) },
    },
    _count: true,
  });

  const frtMap = await computeFrt(workspaceId, since, until);
  const convList = await prisma.conversation.findMany({
    where: {
      workspaceId,
      id: { in: Array.from(frtMap.keys()) },
      assignedAgentId: { not: null },
    },
    select: { id: true, assignedAgentId: true },
  });
  const convToAgent = new Map(convList.map((c) => [c.id, c.assignedAgentId!]));

  const frtByAgent = new Map<string, number[]>();
  for (const [convId, frt] of frtMap.entries()) {
    const agentId = convToAgent.get(convId);
    if (!agentId) continue;
    const arr = frtByAgent.get(agentId) ?? [];
    arr.push(frt);
    frtByAgent.set(agentId, arr);
  }

  const rows = members.map((m) => {
    const byStatus: Record<string, number> = { OPEN: 0, PENDING: 0, RESOLVED: 0, SNOOZED: 0 };
    let total = 0;
    for (const g of convsAssigned) {
      if (g.assignedAgentId !== m.userId) continue;
      byStatus[g.status] = g._count;
      total += g._count;
    }
    const frtArr = frtByAgent.get(m.userId) ?? [];
    const frtStat = stats(frtArr);
    return {
      userId: m.userId,
      name: m.user.name ?? m.user.email,
      email: m.user.email,
      role: m.role,
      conversationsTotal: total,
      conversationsByStatus: byStatus,
      frt: { ...frtStat, avgHuman: formatHumanDuration(frtStat.avg) },
    };
  });

  rows.sort((a, b) => b.conversationsTotal - a.conversationsTotal);
  return c.json({ range: { since: since.toISOString(), until: until.toISOString() }, rows });
});

reportsRouter.get('/inboxes', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const { since, until } = parseRange(c);

  const inboxes = await prisma.inbox.findMany({
    where: { workspaceId },
    select: { id: true, name: true, status: true },
  });

  const convs = await prisma.conversation.groupBy({
    by: ['inboxId', 'status'],
    where: { workspaceId, createdAt: { gte: since, lte: until } },
    _count: true,
  });

  const msgs = await prisma.message.groupBy({
    by: ['conversationId'],
    where: {
      conversation: { workspaceId },
      createdAt: { gte: since, lte: until },
    },
    _count: true,
  });
  const convIds = msgs.map((m) => m.conversationId);
  const convToInbox = await prisma.conversation.findMany({
    where: { id: { in: convIds } },
    select: { id: true, inboxId: true },
  });
  const inboxMessages = new Map<string, number>();
  for (const c of convToInbox) {
    const msg = msgs.find((m) => m.conversationId === c.id);
    if (!msg) continue;
    inboxMessages.set(c.inboxId, (inboxMessages.get(c.inboxId) ?? 0) + msg._count);
  }

  const frtMap = await computeFrt(workspaceId, since, until);
  const frtConvList = await prisma.conversation.findMany({
    where: { id: { in: Array.from(frtMap.keys()) } },
    select: { id: true, inboxId: true },
  });
  const frtByInbox = new Map<string, number[]>();
  for (const c of frtConvList) {
    const frt = frtMap.get(c.id);
    if (frt === undefined) continue;
    const arr = frtByInbox.get(c.inboxId) ?? [];
    arr.push(frt);
    frtByInbox.set(c.inboxId, arr);
  }

  const rows = inboxes.map((ib) => {
    const byStatus: Record<string, number> = { OPEN: 0, PENDING: 0, RESOLVED: 0, SNOOZED: 0 };
    let total = 0;
    for (const g of convs) {
      if (g.inboxId !== ib.id) continue;
      byStatus[g.status] = g._count;
      total += g._count;
    }
    const frtStat = stats(frtByInbox.get(ib.id) ?? []);
    return {
      id: ib.id,
      name: ib.name,
      status: ib.status,
      conversationsTotal: total,
      conversationsByStatus: byStatus,
      messages: inboxMessages.get(ib.id) ?? 0,
      frt: { ...frtStat, avgHuman: formatHumanDuration(frtStat.avg) },
    };
  });
  rows.sort((a, b) => b.conversationsTotal - a.conversationsTotal);

  return c.json({ range: { since: since.toISOString(), until: until.toISOString() }, rows });
});

const exportSchema = z.object({
  type: z.enum(['conversations', 'messages']).default('conversations'),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
});

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

reportsRouter.get('/export.csv', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const parsed = exportSchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parsed.success) return c.json({ error: 'invalid_query' }, 400);
  const { since, until } = parseRange(c);

  let csv = '';
  if (parsed.data.type === 'conversations') {
    const rows = await prisma.conversation.findMany({
      where: { workspaceId, createdAt: { gte: since, lte: until } },
      include: {
        contact: { select: { name: true, phoneNumber: true } },
        inbox: { select: { name: true } },
        _count: { select: { messages: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 10_000,
    });
    csv = 'id,status,contact_name,contact_phone,inbox,assigned_agent_id,created_at,last_message_at,unread,messages_total\n';
    for (const r of rows) {
      csv +=
        [
          r.id,
          r.status,
          r.contact.name ?? '',
          r.contact.phoneNumber,
          r.inbox.name,
          r.assignedAgentId ?? '',
          r.createdAt.toISOString(),
          r.lastMessageAt?.toISOString() ?? '',
          r.unreadCount,
          r._count.messages,
        ]
          .map(csvEscape)
          .join(',') + '\n';
    }
  } else {
    const rows = await prisma.message.findMany({
      where: {
        conversation: { workspaceId },
        createdAt: { gte: since, lte: until },
      },
      include: {
        conversation: {
          select: {
            inbox: { select: { name: true } },
            contact: { select: { name: true, phoneNumber: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 10_000,
    });
    csv = 'id,conversation_id,direction,type,content,status,contact,inbox,created_at\n';
    for (const r of rows) {
      csv +=
        [
          r.id,
          r.conversationId,
          r.direction,
          r.type,
          (r.content ?? '').replaceAll('\n', ' ').slice(0, 500),
          r.status,
          r.conversation.contact.name ?? r.conversation.contact.phoneNumber,
          r.conversation.inbox.name,
          r.createdAt.toISOString(),
        ]
          .map(csvEscape)
          .join(',') + '\n';
    }
  }

  const filename = `neura-${parsed.data.type}-${since.toISOString().slice(0, 10)}-${until.toISOString().slice(0, 10)}.csv`;
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  return c.body(csv);
});
