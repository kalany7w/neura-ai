import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';

export const dashboardRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

// GET /api/dashboard/stats — KPIs do workspace
dashboardRouter.get('/stats', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const userId = c.get('userId');
  const now = new Date();
  const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    openConversations,
    pendingConversations,
    unassignedConversations,
    myAssignedConversations,
    slaRedOrBlinkCount,
    totalContacts,
    activeInboxes,
    cardsByOutcome,
    pipelineSum,
  ] = await Promise.all([
    prisma.conversation.count({ where: { workspaceId, status: 'OPEN' } }),
    prisma.conversation.count({ where: { workspaceId, status: 'PENDING' } }),
    prisma.conversation.count({
      where: { workspaceId, status: { in: ['OPEN', 'PENDING'] }, assignedAgentId: null },
    }),
    prisma.conversation.count({
      where: { workspaceId, status: { in: ['OPEN', 'PENDING'] }, assignedAgentId: userId },
    }),
    prisma.card.count({
      where: { workspaceId, slaStatus: { in: ['red', 'blink'] } },
    }),
    prisma.contact.count({ where: { workspaceId } }),
    prisma.inbox.count({ where: { workspaceId, status: 'CONNECTED' } }),
    prisma.card.groupBy({
      by: ['stageId'],
      where: {
        workspaceId,
        createdAt: { gte: since30d },
        stage: { outcome: { in: ['POSITIVE', 'NEGATIVE'] } },
      },
      _count: true,
      _sum: { value: true },
    }),
    prisma.card.aggregate({
      where: {
        workspaceId,
        OR: [{ stage: { outcome: null } }, { stage: { outcome: 'RISK' } }],
      },
      _sum: { value: true },
      _count: true,
    }),
  ]);

  // Resolve outcome dos stages que aparecem nos grupos
  const stageIds = cardsByOutcome.map((g) => g.stageId);
  const stages = stageIds.length
    ? await prisma.stage.findMany({
        where: { id: { in: stageIds } },
        select: { id: true, outcome: true },
      })
    : [];
  const outcomeByStage = new Map(stages.map((s) => [s.id, s.outcome]));

  let positive30d = 0;
  let negative30d = 0;
  let positiveValue30d = 0;
  let negativeValue30d = 0;
  for (const g of cardsByOutcome) {
    const o = outcomeByStage.get(g.stageId);
    if (o === 'POSITIVE') {
      positive30d += g._count;
      positiveValue30d += Number(g._sum.value ?? 0);
    } else if (o === 'NEGATIVE') {
      negative30d += g._count;
      negativeValue30d += Number(g._sum.value ?? 0);
    }
  }

  // Atividade recente: últimas 5 conversations por lastMessageAt
  const recentConversations = await prisma.conversation.findMany({
    where: { workspaceId, status: { in: ['OPEN', 'PENDING'] } },
    orderBy: { lastMessageAt: 'desc' },
    take: 5,
    include: {
      contact: { select: { id: true, name: true, phoneNumber: true } },
      inbox: { select: { id: true, name: true } },
    },
  });

  return c.json({
    inbox: {
      open: openConversations,
      pending: pendingConversations,
      unassigned: unassignedConversations,
      mine: myAssignedConversations,
      slaCritical: slaRedOrBlinkCount,
    },
    workspace: {
      contacts: totalContacts,
      activeInboxes,
    },
    pipeline: {
      activeCount: pipelineSum._count,
      activeValue: Number(pipelineSum._sum.value ?? 0),
      positive30d,
      negative30d,
      positiveValue30d,
      negativeValue30d,
      conversionRate:
        positive30d + negative30d > 0
          ? Math.round((positive30d / (positive30d + negative30d)) * 100)
          : null,
    },
    recentConversations,
  });
});

// GET /api/dashboard/timeseries?days=14 — séries diárias pra gráficos
const timeseriesQuery = z.object({
  days: z.coerce.number().int().min(2).max(90).default(14),
});

dashboardRouter.get('/timeseries', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const parsed = timeseriesQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  const days = parsed.success ? parsed.data.days : 14;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  since.setUTCHours(0, 0, 0, 0);

  const [convRows, msgRows] = await Promise.all([
    prisma.$queryRaw<Array<{ day: Date; count: bigint }>>`
      SELECT date_trunc('day', "createdAt")::date AS day, COUNT(*)::bigint AS count
      FROM conversations
      WHERE "workspaceId" = ${workspaceId} AND "createdAt" >= ${since}
      GROUP BY 1
      ORDER BY 1 ASC
    `,
    prisma.$queryRaw<Array<{ day: Date; direction: 'INBOUND' | 'OUTBOUND'; count: bigint }>>`
      SELECT date_trunc('day', m."createdAt")::date AS day, m.direction, COUNT(*)::bigint AS count
      FROM messages m
      JOIN conversations c ON c.id = m."conversationId"
      WHERE c."workspaceId" = ${workspaceId} AND m."createdAt" >= ${since}
      GROUP BY 1, 2
      ORDER BY 1 ASC
    `,
  ]);

  // Monta esqueleto com TODOS os dias (zeros pra dias sem dado)
  const series: Record<string, { conversations: number; inbound: number; outbound: number }> = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(since);
    d.setUTCDate(d.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    series[key] = { conversations: 0, inbound: 0, outbound: 0 };
  }
  for (const r of convRows) {
    const key = r.day.toISOString().slice(0, 10);
    const slot = series[key];
    if (slot) slot.conversations = Number(r.count);
  }
  for (const r of msgRows) {
    const key = r.day.toISOString().slice(0, 10);
    const slot = series[key];
    if (!slot) continue;
    if (r.direction === 'INBOUND') slot.inbound = Number(r.count);
    else slot.outbound = Number(r.count);
  }

  const days_ = Object.entries(series).map(([date, v]) => ({ date, ...v }));
  return c.json({ days: days_ });
});
