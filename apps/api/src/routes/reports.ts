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
  type: z.enum(['conversations', 'messages', 'cards']).default('conversations'),
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
  if (parsed.data.type === 'cards') {
    const rows = await prisma.card.findMany({
      where: { workspaceId, createdAt: { gte: since, lte: until } },
      include: {
        funnel: { select: { name: true } },
        stage: { select: { name: true, outcome: true } },
        labels: { include: { label: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 10_000,
    });
    csv =
      'id,title,funnel,stage,outcome,value,currency,assigned_agent_id,sla_status,labels,due_date,created_at,updated_at\n';
    for (const r of rows) {
      csv +=
        [
          r.id,
          r.title,
          r.funnel.name,
          r.stage.name,
          r.stage.outcome ?? '',
          r.value !== null ? r.value.toString() : '',
          r.currency,
          r.assignedAgentId ?? '',
          r.slaStatus,
          r.labels.map((cl) => cl.label.name).join('|'),
          r.dueDate?.toISOString() ?? '',
          r.createdAt.toISOString(),
          r.updatedAt.toISOString(),
        ]
          .map(csvEscape)
          .join(',') + '\n';
    }
  } else if (parsed.data.type === 'conversations') {
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

// ============================================================
// SLA REPORT — FRT/RT formal + hit rate por policy/agente
// ============================================================

reportsRouter.get('/sla', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const { since, until } = parseRange(c);

  // Pega default policy pra threshold global
  const defaultPolicy = await prisma.slaPolicy.findFirst({
    where: { workspaceId, scope: 'default', enabled: true },
  });
  const frtThresholdSec = defaultPolicy
    ? defaultPolicy.firstResponseThresholdMin * 60
    : 15 * 60;
  const rtThresholdSec = defaultPolicy
    ? defaultPolicy.resolutionThresholdMin * 60
    : 1440 * 60;

  // Conversas no range com FRT registrada
  const convs = await prisma.conversation.findMany({
    where: {
      workspaceId,
      createdAt: { gte: since, lte: until },
      firstResponseSeconds: { not: null },
    },
    select: {
      id: true,
      firstResponseSeconds: true,
      resolutionSeconds: true,
      assignedAgentId: true,
      lastAgentRepliedId: true,
    },
  });

  const frtValues = convs.map((c) => c.firstResponseSeconds ?? 0);
  const rtValues = convs
    .map((c) => c.resolutionSeconds)
    .filter((v): v is number => v != null);

  const frtStats = stats(frtValues);
  const rtStats = stats(rtValues);

  const frtHit = frtValues.filter((v) => v <= frtThresholdSec).length;
  const rtHit = rtValues.filter((v) => v <= rtThresholdSec).length;
  const frtHitRate = frtValues.length > 0 ? Math.round((frtHit / frtValues.length) * 100) : null;
  const rtHitRate = rtValues.length > 0 ? Math.round((rtHit / rtValues.length) * 100) : null;

  // Conversas em breach AGORA (sem resposta + acima do threshold)
  const breached = await prisma.conversation.count({
    where: {
      workspaceId,
      archivedAt: null,
      status: { in: ['OPEN', 'PENDING'] },
      firstResponseAt: null,
      lastInboundAt: {
        not: null,
        lte: new Date(Date.now() - frtThresholdSec * 1000),
      },
    },
  });

  // Stats por agente — agrupa FRT/RT pela pessoa que respondeu primeiro
  const byAgent = new Map<
    string,
    { frt: number[]; rt: number[] }
  >();
  for (const conv of convs) {
    const agentId = conv.lastAgentRepliedId ?? conv.assignedAgentId;
    if (!agentId) continue;
    const bucket = byAgent.get(agentId) ?? { frt: [], rt: [] };
    if (conv.firstResponseSeconds != null) bucket.frt.push(conv.firstResponseSeconds);
    if (conv.resolutionSeconds != null) bucket.rt.push(conv.resolutionSeconds);
    byAgent.set(agentId, bucket);
  }
  const agentIds = Array.from(byAgent.keys());
  const agentUsers = agentIds.length
    ? await prisma.user.findMany({
        where: { id: { in: agentIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const userMap = new Map(agentUsers.map((u) => [u.id, u]));

  const agents = Array.from(byAgent.entries())
    .map(([userId, b]) => {
      const u = userMap.get(userId);
      const fs = stats(b.frt);
      const rs = stats(b.rt);
      const fHit = b.frt.filter((v) => v <= frtThresholdSec).length;
      const rHit = b.rt.filter((v) => v <= rtThresholdSec).length;
      return {
        userId,
        name: u?.name ?? null,
        email: u?.email ?? '',
        conversations: b.frt.length,
        frtAvg: fs.avg,
        frtP50: fs.p50,
        frtP90: fs.p90,
        frtHitRate: b.frt.length > 0 ? Math.round((fHit / b.frt.length) * 100) : null,
        rtAvg: rs.avg,
        rtHitRate: b.rt.length > 0 ? Math.round((rHit / b.rt.length) * 100) : null,
      };
    })
    .sort((a, b) => b.conversations - a.conversations);

  return c.json({
    range: { since: since.toISOString(), until: until.toISOString() },
    thresholds: {
      firstResponseMin: frtThresholdSec / 60,
      resolutionMin: rtThresholdSec / 60,
    },
    summary: {
      totalConversations: convs.length,
      frtAvg: frtStats.avg,
      frtP50: frtStats.p50,
      frtP90: frtStats.p90,
      frtHitRate,
      frtAvgHuman: formatHumanDuration(frtStats.avg),
      frtP50Human: formatHumanDuration(frtStats.p50),
      frtP90Human: formatHumanDuration(frtStats.p90),
      rtAvg: rtStats.avg,
      rtP50: rtStats.p50,
      rtP90: rtStats.p90,
      rtHitRate,
      rtAvgHuman: formatHumanDuration(rtStats.avg),
      rtP90Human: formatHumanDuration(rtStats.p90),
      currentlyBreached: breached,
    },
    agents,
  });
});

// GET /api/reports/csat — métricas de satisfação no período.
// CSAT: avg score (1-5), %satisfeitos (score>=4)
// NPS: NPS score = %promoters (9-10) - %detractors (0-6)
// THUMBS: %positivos (score=1) vs %negativos (score=0)
reportsRouter.get('/csat', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const url = new URL(c.req.url);
  const range = rangeSchema.safeParse({
    since: url.searchParams.get('since') ?? undefined,
    until: url.searchParams.get('until') ?? undefined,
  });
  if (!range.success) return c.json({ error: 'invalid_range' }, 400);
  const until = range.data.until ? new Date(range.data.until) : new Date();
  const since = range.data.since
    ? new Date(range.data.since)
    : new Date(until.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [responses, surveys, sentInRange] = await Promise.all([
    prisma.csatResponse.findMany({
      where: { workspaceId, respondedAt: { gte: since, lte: until } },
      select: {
        score: true,
        scoreType: true,
        comment: true,
        agentId: true,
        respondedAt: true,
        surveyId: true,
      },
    }),
    prisma.csatSurvey.findMany({
      where: { workspaceId },
      select: {
        id: true,
        name: true,
        scoreType: true,
        sentCount: true,
        responseCount: true,
        enabled: true,
      },
    }),
    // Total enviado no período = conversations com csatSentAt no range.
    prisma.conversation.count({
      where: {
        workspaceId,
        csatSentAt: { gte: since, lte: until, not: null },
      },
    }),
  ]);

  const totalResponses = responses.length;
  const responseRate = sentInRange > 0 ? Math.round((totalResponses / sentInRange) * 100) : null;

  // Calcula métricas separadas por scoreType (cada survey pode ter um tipo diferente)
  const byType = { CSAT: [] as number[], NPS: [] as number[], THUMBS: [] as number[] };
  for (const r of responses) {
    byType[r.scoreType].push(r.score);
  }

  // CSAT: avg (1-5), satisfação=score>=4
  const csatScores = byType.CSAT;
  const csatAvg = csatScores.length > 0 ? csatScores.reduce((a, b) => a + b, 0) / csatScores.length : null;
  const csatSatisfiedCount = csatScores.filter((s) => s >= 4).length;
  const csatSatisfactionRate =
    csatScores.length > 0 ? Math.round((csatSatisfiedCount / csatScores.length) * 100) : null;

  // NPS: promoters (9-10), detractors (0-6), passives (7-8)
  const npsScores = byType.NPS;
  const promoters = npsScores.filter((s) => s >= 9).length;
  const detractors = npsScores.filter((s) => s <= 6).length;
  const passives = npsScores.filter((s) => s >= 7 && s <= 8).length;
  const npsScore =
    npsScores.length > 0
      ? Math.round(((promoters - detractors) / npsScores.length) * 100)
      : null;

  // THUMBS: positivos vs negativos
  const thumbsScores = byType.THUMBS;
  const positives = thumbsScores.filter((s) => s === 1).length;
  const negatives = thumbsScores.length - positives;
  const thumbsPositiveRate =
    thumbsScores.length > 0 ? Math.round((positives / thumbsScores.length) * 100) : null;

  // Distribuição CSAT (1, 2, 3, 4, 5)
  const csatDistribution = [1, 2, 3, 4, 5].map((star) => ({
    score: star,
    count: csatScores.filter((s) => s === star).length,
  }));

  // Por agente
  const agentIds = Array.from(
    new Set(responses.map((r) => r.agentId).filter((v): v is string => !!v)),
  );
  const users = await prisma.user.findMany({
    where: { id: { in: agentIds } },
    select: { id: true, name: true, email: true },
  });
  const userMap = new Map(users.map((u) => [u.id, u]));

  const byAgent = new Map<string, { csat: number[]; nps: number[]; thumbs: number[] }>();
  for (const r of responses) {
    if (!r.agentId) continue;
    if (!byAgent.has(r.agentId)) byAgent.set(r.agentId, { csat: [], nps: [], thumbs: [] });
    const bucket = byAgent.get(r.agentId)!;
    if (r.scoreType === 'CSAT') bucket.csat.push(r.score);
    else if (r.scoreType === 'NPS') bucket.nps.push(r.score);
    else bucket.thumbs.push(r.score);
  }

  const agents = Array.from(byAgent.entries())
    .map(([userId, b]) => {
      const u = userMap.get(userId);
      const csatAvg = b.csat.length > 0 ? b.csat.reduce((a, x) => a + x, 0) / b.csat.length : null;
      const npsScore =
        b.nps.length > 0
          ? Math.round(((b.nps.filter((s) => s >= 9).length - b.nps.filter((s) => s <= 6).length) / b.nps.length) * 100)
          : null;
      const thumbsRate =
        b.thumbs.length > 0
          ? Math.round((b.thumbs.filter((s) => s === 1).length / b.thumbs.length) * 100)
          : null;
      return {
        userId,
        name: u?.name ?? null,
        email: u?.email ?? '',
        responses: b.csat.length + b.nps.length + b.thumbs.length,
        csatAvg,
        npsScore,
        thumbsRate,
      };
    })
    .sort((a, b) => b.responses - a.responses);

  // Comments recentes (últimos 10 com texto)
  const recentComments = responses
    .filter((r) => r.comment && r.comment.trim())
    .sort((a, b) => b.respondedAt.getTime() - a.respondedAt.getTime())
    .slice(0, 10)
    .map((r) => ({
      score: r.score,
      scoreType: r.scoreType,
      comment: r.comment,
      respondedAt: r.respondedAt,
    }));

  return c.json({
    range: { since: since.toISOString(), until: until.toISOString() },
    summary: {
      totalSent: sentInRange,
      totalResponses,
      responseRate,
      csatAvg,
      csatSatisfactionRate,
      npsScore,
      npsBreakdown: { promoters, passives, detractors },
      thumbsPositiveRate,
      thumbsBreakdown: { positives, negatives },
    },
    csatDistribution,
    agents,
    recentComments,
    surveys,
  });
});

// GET /api/reports/kb — métricas da Knowledge Base + auto-suggest.
// - total artigos publicados / drafts / archived
// - cobertura: % artigos com embedding (sem key OpenAI fica 0)
// - sugestões: total conversations com suggestion gerada vs aceitas (= 1-click "Inserir resposta")
// - taxa de aceitação = aceitas/sugeridas (proxy de qualidade da KB)
// - top artigos por views
reportsRouter.get('/kb', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const url = new URL(c.req.url);
  const range = rangeSchema.safeParse({
    since: url.searchParams.get('since') ?? undefined,
    until: url.searchParams.get('until') ?? undefined,
  });
  if (!range.success) return c.json({ error: 'invalid_range' }, 400);
  const until = range.data.until ? new Date(range.data.until) : new Date();
  const since = range.data.since
    ? new Date(range.data.since)
    : new Date(until.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [publishedCount, draftCount, archivedCount, withEmbedding] = await Promise.all([
    prisma.kbArticle.count({ where: { workspaceId, status: 'PUBLISHED' } }),
    prisma.kbArticle.count({ where: { workspaceId, status: 'DRAFT' } }),
    prisma.kbArticle.count({ where: { workspaceId, status: 'ARCHIVED' } }),
    prisma.kbArticle.count({
      where: { workspaceId, status: 'PUBLISHED', embeddingUpdatedAt: { not: null } },
    }),
  ]);

  // Auto-suggest stats: conversations com aiKbSuggestion no range + accepted.
  // aiKbSuggestionAt é set quando worker compute. accepted via flag boolean.
  const [suggestedTotal, acceptedTotal] = await Promise.all([
    prisma.conversation.count({
      where: {
        workspaceId,
        aiKbSuggestionAt: { gte: since, lte: until, not: null },
      },
    }),
    prisma.conversation.count({
      where: {
        workspaceId,
        aiKbSuggestionAt: { gte: since, lte: until, not: null },
        aiKbSuggestionAccepted: true,
      },
    }),
  ]);
  const acceptRate =
    suggestedTotal > 0 ? Math.round((acceptedTotal / suggestedTotal) * 100) : null;

  // Top artigos por viewCount (views agentes via composer + insert). Limita 10.
  const topArticles = await prisma.kbArticle.findMany({
    where: { workspaceId, status: 'PUBLISHED', viewCount: { gt: 0 } },
    orderBy: { viewCount: 'desc' },
    take: 10,
    select: {
      id: true,
      title: true,
      slug: true,
      viewCount: true,
      embeddingUpdatedAt: true,
      category: { select: { name: true, color: true } },
    },
  });

  const coverage = publishedCount > 0 ? Math.round((withEmbedding / publishedCount) * 100) : null;

  return c.json({
    range: { since: since.toISOString(), until: until.toISOString() },
    summary: {
      published: publishedCount,
      drafts: draftCount,
      archived: archivedCount,
      withEmbedding,
      coverage,
      suggestedTotal,
      acceptedTotal,
      acceptRate,
    },
    topArticles: topArticles.map((a) => ({
      id: a.id,
      title: a.title,
      slug: a.slug,
      viewCount: a.viewCount,
      category: a.category ? { name: a.category.name, color: a.category.color } : null,
      indexed: !!a.embeddingUpdatedAt,
    })),
  });
});
