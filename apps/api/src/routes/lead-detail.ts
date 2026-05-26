import { Hono } from 'hono';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';

export const leadDetailRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

/**
 * GET /api/conversations/:id/lead-detail
 * Tudo o que o side panel precisa em uma só request:
 * - Contato (com customAttrs + labels)
 * - Definições de custom attributes do workspace (pra render dinâmico)
 * - Card ativo da conversa (se houver) com funnel/stage + outcome
 * - Labels disponíveis no workspace (pra toggle add/remove)
 * - Funnels + stages disponíveis (pra mover stage inline)
 * - Welcome state (isAwaiting / completed / failed)
 * - Status + SLA derivado (temperature CALIENTE/TIBIO/FRIO)
 */
leadDetailRouter.get('/conversations/:id/lead-detail', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const role = c.get('role')!;
  const userId = c.get('userId');
  const conversationId = c.req.param('id');

  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: {
      id: true,
      status: true,
      assignedAgentId: true,
      lastInboundAt: true,
      lastOutboundAt: true,
      aiSummary: true,
      aiSummaryAt: true,
      isAwaitingWelcomeChoice: true,
      welcomeAttempts: true,
      welcomeFallbackSent: true,
      contact: {
        select: {
          id: true,
          name: true,
          phoneNumber: true,
          email: true,
          avatarUrl: true,
          customAttrs: true,
          welcomeRespondedAt: true,
          labels: { include: { label: true } },
        },
      },
      inbox: { select: { id: true, name: true } },
      labels: { include: { label: true } },
    },
  });
  if (!conv) return c.json({ error: 'not_found' }, 404);

  if (role === 'AGENT' && conv.assignedAgentId && conv.assignedAgentId !== userId) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const [card, customAttributeDefs, allLabels, funnels] = await Promise.all([
    prisma.card.findFirst({
      where: { conversationId, workspaceId },
      orderBy: { createdAt: 'desc' },
      include: {
        funnel: { select: { id: true, name: true } },
        stage: { select: { id: true, name: true, color: true, outcome: true } },
        products: true,
      },
    }),
    prisma.customAttributeDef.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.label.findMany({
      where: { workspaceId },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        color: true,
        scope: true,
        routesToFunnelId: true,
        routesToStageId: true,
      },
    }),
    prisma.funnel.findMany({
      where: { workspaceId },
      include: { stages: { orderBy: { order: 'asc' } } },
    }),
  ]);

  // SLA temperature: minutos desde último inbound se OPEN + sem outbound posterior
  let temperature: 'CALIENTE' | 'TIBIO' | 'FRIO' = 'FRIO';
  if (conv.status === 'OPEN' && conv.lastInboundAt) {
    const lastOut = conv.lastOutboundAt;
    const needsReply =
      !lastOut || new Date(lastOut).getTime() < new Date(conv.lastInboundAt).getTime();
    if (needsReply) {
      const minutes = Math.floor((Date.now() - new Date(conv.lastInboundAt).getTime()) / 60_000);
      if (minutes < 15) temperature = 'CALIENTE';
      else if (minutes < 60) temperature = 'TIBIO';
      else temperature = 'FRIO';
    }
  }

  return c.json({
    conversation: {
      id: conv.id,
      status: conv.status,
      assignedAgentId: conv.assignedAgentId,
      lastInboundAt: conv.lastInboundAt,
      lastOutboundAt: conv.lastOutboundAt,
      aiSummary: conv.aiSummary,
      aiSummaryAt: conv.aiSummaryAt,
      isAwaitingWelcomeChoice: conv.isAwaitingWelcomeChoice,
      welcomeAttempts: conv.welcomeAttempts,
      welcomeFallbackSent: conv.welcomeFallbackSent,
      inbox: conv.inbox,
      labels: conv.labels.map((cl) => cl.label),
    },
    contact: conv.contact,
    card,
    customAttributeDefs,
    allLabels,
    funnels,
    temperature,
  });
});
