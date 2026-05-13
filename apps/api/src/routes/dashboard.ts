import { Hono } from 'hono';
import { prisma } from '../db';
import { requireAuth, type AuthVars } from '../middlewares/auth';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace';

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
