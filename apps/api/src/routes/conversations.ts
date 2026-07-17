import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Prisma } from '@neura/database';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';
import { requirePermission } from '../middlewares/permissions.js';
import { dispatchOutbound } from '../queue.js';
import { publishEvent } from '../redis-pub.js';
import { outboundLimiter, aiRateLimit } from '../rate-limit.js';
import { logger } from '../logger.js';
import { suggestReplies, type SuggestReplyInput } from '../services/ai-suggest.js';
import { summarizeConversation } from '../services/ai-summarize.js';
import { suggestNextActions } from '../services/ai-next-action.js';
import { classifyConversation } from '../services/ai-classify.js';
import { buildMentionTargets } from '../services/mentions.js';
import { patchFirstResponse, patchResolution } from '../services/sla-compute.js';
import { audit } from '../services/audit.js';
import { aiQueue, enqueueCsatSend, cancelCsatSend } from '../queue.js';
import { resolveSurveyForConversation } from '../services/csat-send.js';
import { env } from '../env.js';

export const conversationsRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

/**
 * Guard de escopo do AGENT: um agente só pode acessar conversas atribuídas a ele
 * (ou sem agente). Retorna uma Response (403/404) se NÃO pode; null se pode seguir.
 * Faz uma query leve (só assignedAgentId) — chamar ANTES de qualquer trabalho caro
 * (ex.: chamadas de IA). supervisor/admin sempre passam.
 */
async function agentAccessGuard(
  c: Context,
  workspaceId: string,
  conversationId: string,
): Promise<Response | null> {
  const role = c.get('role') as string | undefined;
  if (role !== 'AGENT') return null;
  const userId = c.get('userId') as string | undefined;
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: { assignedAgentId: true },
  });
  if (!conv) return c.json({ error: 'not_found' }, 404);
  if (conv.assignedAgentId && conv.assignedAgentId !== userId) {
    return c.json({ error: 'forbidden' }, 403);
  }
  return null;
}

// GET /api/conversations
const listQuery = z.object({
  // Aceita "OPEN" ou "OPEN,PENDING" (comma-separated pra filtro multi)
  status: z.string().optional(),
  // Aceita um id ou comma-separated
  inboxId: z.string().optional(),
  assignedAgentId: z.string().optional(),
  unassigned: z.coerce.boolean().optional(),
  archived: z.coerce.boolean().optional(),
  // Filtro "aguardando primeira/próxima resposta" — cliente mandou e ninguém respondeu ainda.
  awaiting: z.coerce.boolean().optional(),
  labelId: z.string().optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});

conversationsRouter.get('/', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const role = c.get('role')!;
  const userId = c.get('userId');
  const parsed = listQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) return c.json({ error: 'invalid_query', issues: parsed.error.issues }, 400);
  const {
    status,
    inboxId,
    assignedAgentId,
    unassigned,
    archived,
    awaiting,
    labelId,
    since,
    until,
    search,
    page,
    perPage,
  } = parsed.data;

  const where: Prisma.ConversationWhereInput = { workspaceId };
  // Por default exclui arquivadas. ?archived=true mostra só as arquivadas.
  where.archivedAt = archived ? { not: null } : null;

  // AND clauses pra agrupar múltiplos OR (awaiting + role=AGENT scope) sem sobrescrever
  const andClauses: Prisma.ConversationWhereInput[] = [];

  // ?awaiting=true → conversas ativas onde o cliente mandou msg e ninguém respondeu desde.
  // Critério: lastInboundAt presente E (lastOutboundAt ausente OU lastOutboundAt < lastInboundAt).
  // status default vira OPEN+PENDING quando não foi explícito.
  if (awaiting) {
    andClauses.push({ lastInboundAt: { not: null } });
    andClauses.push({
      OR: [
        { lastOutboundAt: null },
        { lastOutboundAt: { lt: prisma.conversation.fields.lastInboundAt } },
      ],
    });
    if (!status) where.status = { in: ['OPEN', 'PENDING'] };
  }

  // Multi-status: "OPEN,PENDING" → IN. Valida cada valor.
  const ALLOWED_STATUS = ['OPEN', 'PENDING', 'RESOLVED', 'SNOOZED'] as const;
  type ConvStatus = (typeof ALLOWED_STATUS)[number];
  if (status) {
    const parts = status
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is ConvStatus => (ALLOWED_STATUS as readonly string[]).includes(s));
    if (parts.length === 1) where.status = parts[0];
    else if (parts.length > 1) where.status = { in: parts };
  }

  if (inboxId) {
    const parts = inboxId.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 1) where.inboxId = parts[0];
    else if (parts.length > 1) where.inboxId = { in: parts };
  }

  if (unassigned) where.assignedAgentId = null;
  else if (assignedAgentId) where.assignedAgentId = assignedAgentId;

  if (labelId) where.labels = { some: { labelId } };

  if (since || until) {
    where.createdAt = {};
    if (since) (where.createdAt as Record<string, Date>).gte = new Date(since);
    if (until) (where.createdAt as Record<string, Date>).lte = new Date(until);
  }

  // Agent: só conversas próprias ou sem agente
  if (role === 'AGENT') {
    andClauses.push({ OR: [{ assignedAgentId: userId }, { assignedAgentId: null }] });
  }

  if (andClauses.length > 0) where.AND = andClauses;

  if (search) {
    where.contact = {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { phoneNumber: { contains: search } },
      ],
    };
  }

  const [total, items, lastReplyUsers] = await Promise.all([
    prisma.conversation.count({ where }),
    prisma.conversation.findMany({
      where,
      include: {
        contact: { select: { id: true, name: true, phoneNumber: true, avatarUrl: true } },
        inbox: { select: { id: true, name: true } },
        labels: { include: { label: { select: { id: true, name: true, color: true } } } },
      },
      orderBy: { lastMessageAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    // Pre-fetch quem foi o último agente — em batch pra evitar N+1
    (async () => {
      const allIds = new Set<string>();
      return allIds;
    })(),
  ]);

  // Resolve nome dos lastAgentRepliedId em batch
  const agentIds = Array.from(
    new Set(items.map((c) => c.lastAgentRepliedId).filter((v): v is string => !!v)),
  );
  const agents =
    agentIds.length === 0
      ? []
      : await prisma.user.findMany({
          where: { id: { in: agentIds } },
          select: { id: true, name: true, email: true },
        });
  void lastReplyUsers;
  const agentMap = new Map(agents.map((u) => [u.id, u]));

  const enriched = items.map((c) => ({
    ...c,
    lastAgentRepliedBy: c.lastAgentRepliedId ? agentMap.get(c.lastAgentRepliedId) ?? null : null,
  }));

  return c.json({ items: enriched, total, page, perPage });
});

// GET /api/conversations/counts — contadores por tab (badge no /inbox)
// Retorna agora { awaiting } mas estrutura é extensível.
conversationsRouter.get('/counts', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const role = c.get('role')!;
  const userId = c.get('userId');

  // Filtros base que se aplicam aos counts (escopo do AGENT)
  const baseAnd: Prisma.ConversationWhereInput[] = [];
  if (role === 'AGENT') {
    baseAnd.push({ OR: [{ assignedAgentId: userId }, { assignedAgentId: null }] });
  }

  const awaitingWhere: Prisma.ConversationWhereInput = {
    workspaceId,
    archivedAt: null,
    status: { in: ['OPEN', 'PENDING'] },
    AND: [
      ...baseAnd,
      { lastInboundAt: { not: null } },
      {
        OR: [
          { lastOutboundAt: null },
          { lastOutboundAt: { lt: prisma.conversation.fields.lastInboundAt } },
        ],
      },
    ],
  };

  const awaiting = await prisma.conversation.count({ where: awaitingWhere });
  return c.json({ awaiting });
});

// POST /api/conversations/bulk — ações em lote (assign/label/status/archive)
// NÃO inclui send_message (risco ban Baileys); essas ações alteram só state interno.
const bulkSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('assign_agent'),
    conversationIds: z.array(z.string().min(1)).min(1).max(200),
    agentId: z.string().min(1).nullable(),
  }),
  z.object({
    action: z.literal('apply_label'),
    conversationIds: z.array(z.string().min(1)).min(1).max(200),
    labelId: z.string().min(1),
  }),
  z.object({
    action: z.literal('unapply_label'),
    conversationIds: z.array(z.string().min(1)).min(1).max(200),
    labelId: z.string().min(1),
  }),
  z.object({
    action: z.literal('set_status'),
    conversationIds: z.array(z.string().min(1)).min(1).max(200),
    status: z.enum(['OPEN', 'PENDING', 'RESOLVED', 'SNOOZED']),
  }),
  z.object({
    action: z.literal('archive'),
    conversationIds: z.array(z.string().min(1)).min(1).max(200),
  }),
  z.object({
    action: z.literal('unarchive'),
    conversationIds: z.array(z.string().min(1)).min(1).max(200),
  }),
]);

conversationsRouter.post('/bulk', requireAuth, requireWorkspace, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = bulkSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
  const workspaceId = c.get('workspaceId') as string;
  const role = c.get('role')!;
  const actorId = c.get('userId');
  const data = parsed.data;

  // Garante que todas as conversas pertencem ao workspace
  const owned = await prisma.conversation.findMany({
    where: { id: { in: data.conversationIds }, workspaceId },
    select: { id: true },
  });
  const ids = owned.map((o) => o.id);
  if (ids.length === 0) return c.json({ affected: 0 });

  // AGENT: bloqueia delete/archive/status_resolved em batch — só assign/label
  // (evita agente fechar massa de conversas alheias). Pode operar nas próprias só single via UI.
  if (role === 'AGENT') {
    if (data.action === 'archive' || data.action === 'unarchive' || data.action === 'set_status') {
      return c.json({ error: 'forbidden' }, 403);
    }
  }

  let affected = 0;
  if (data.action === 'assign_agent') {
    if (data.agentId) {
      // Confirma membership do agente atribuído
      const member = await prisma.membership.findFirst({
        where: { workspaceId, userId: data.agentId },
        select: { id: true },
      });
      if (!member) return c.json({ error: 'agent_not_in_workspace' }, 400);
    }
    const res = await prisma.conversation.updateMany({
      where: { id: { in: ids } },
      data: { assignedAgentId: data.agentId },
    });
    affected = res.count;
    for (const id of ids) {
      await publishEvent(workspaceId, 'conversations', 'conversation.assigned', {
        conversationId: id,
        assignedAgentId: data.agentId,
        reason: 'bulk',
      });
    }
  } else if (data.action === 'apply_label') {
    const label = await prisma.label.findFirst({
      where: { id: data.labelId, workspaceId },
      select: { id: true },
    });
    if (!label) return c.json({ error: 'label_not_found' }, 404);
    const res = await prisma.conversationLabel.createMany({
      data: ids.map((id) => ({ conversationId: id, labelId: label.id })),
      skipDuplicates: true,
    });
    affected = res.count;
  } else if (data.action === 'unapply_label') {
    const res = await prisma.conversationLabel.deleteMany({
      where: { conversationId: { in: ids }, labelId: data.labelId },
    });
    affected = res.count;
  } else if (data.action === 'set_status') {
    const res = await prisma.conversation.updateMany({
      where: { id: { in: ids } },
      data: { status: data.status },
    });
    affected = res.count;
    // SLA: marca resolvedAt em RESOLVED (1× por conversa, idempotente via WHERE)
    if (data.status === 'RESOLVED') {
      const now = new Date();
      // Pega createdAt das que ainda não têm resolvedAt
      const pending = await prisma.conversation.findMany({
        where: { id: { in: ids }, resolvedAt: null },
        select: { id: true, createdAt: true },
      });
      for (const p of pending) {
        const secs = Math.max(
          0,
          Math.round((now.getTime() - p.createdAt.getTime()) / 1000),
        );
        await prisma.conversation.update({
          where: { id: p.id },
          data: { resolvedAt: now, resolutionSeconds: secs },
        });
      }
    } else {
      // Reabriu: limpa resolvedAt pra permitir nova medição depois
      await prisma.conversation.updateMany({
        where: { id: { in: ids }, status: data.status },
        data: { resolvedAt: null, resolutionSeconds: null },
      });
    }
    for (const id of ids) {
      await publishEvent(workspaceId, 'conversations', 'conversation.status_changed', {
        conversationId: id,
        status: data.status,
        reason: 'bulk',
      });
    }
  } else if (data.action === 'archive') {
    const res = await prisma.conversation.updateMany({
      where: { id: { in: ids } },
      data: { archivedAt: new Date() },
    });
    affected = res.count;
    for (const id of ids) {
      await publishEvent(workspaceId, 'conversations', 'conversation.archived', {
        conversationId: id,
        reason: 'bulk',
      });
    }
  } else {
    // unarchive
    const res = await prisma.conversation.updateMany({
      where: { id: { in: ids } },
      data: { archivedAt: null },
    });
    affected = res.count;
    for (const id of ids) {
      await publishEvent(workspaceId, 'conversations', 'conversation.unarchived', {
        conversationId: id,
        reason: 'bulk',
      });
    }
  }

  await audit({
    workspaceId,
    actorId,
    action: `conversation.bulk_${data.action}`,
    metadata: {
      count: ids.length,
      affected,
      ...(data.action === 'apply_label' || data.action === 'unapply_label'
        ? { labelId: data.labelId }
        : {}),
      ...(data.action === 'assign_agent' ? { agentId: data.agentId } : {}),
      ...(data.action === 'set_status' ? { status: data.status } : {}),
    },
  });

  return c.json({ affected });
});

// GET /api/conversations/:id (com mensagens)
conversationsRouter.get('/:id', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const role = c.get('role')!;
  const userId = c.get('userId');
  const id = c.req.param('id');

  const conv = await prisma.conversation.findFirst({
    where: { id, workspaceId },
    include: {
      contact: true,
      inbox: { select: { id: true, name: true, status: true } },
      messages: {
        orderBy: { createdAt: 'asc' },
        take: 100,
        include: { reactions: true },
      },
    },
  });
  if (!conv) return c.json({ error: 'not_found' }, 404);

  if (role === 'AGENT' && conv.assignedAgentId && conv.assignedAgentId !== userId) {
    return c.json({ error: 'forbidden' }, 403);
  }

  // Enriquece messages com replyTo (batch query — evita N+1)
  const replyIds = Array.from(
    new Set(conv.messages.map((m) => m.replyToId).filter((v): v is string => !!v)),
  );
  const replies =
    replyIds.length > 0
      ? await prisma.message.findMany({
          where: { id: { in: replyIds } },
          select: {
            id: true,
            content: true,
            type: true,
            direction: true,
            deletedAt: true,
          },
        })
      : [];
  const replyById = new Map(replies.map((r) => [r.id, r]));
  const enrichedMessages = conv.messages.map((m) => ({
    ...m,
    replyTo: m.replyToId ? (replyById.get(m.replyToId) ?? null) : null,
  }));

  return c.json({
    conversation: { ...conv, messages: enrichedMessages },
  });
});

// PATCH /api/conversations/:id (status / assign)
const patchBody = z.object({
  status: z.enum(['OPEN', 'PENDING', 'RESOLVED', 'SNOOZED']).optional(),
  assignedAgentId: z.string().nullable().optional(),
});

conversationsRouter.patch('/:id', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const role = c.get('role')!;
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = patchBody.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

  const conv = await prisma.conversation.findFirst({ where: { id, workspaceId } });
  if (!conv) return c.json({ error: 'not_found' }, 404);

  // Agent só atualiza próprias ou sem agente; e não pode mudar assignedAgentId pra outro
  if (role === 'AGENT') {
    if (conv.assignedAgentId && conv.assignedAgentId !== userId) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (parsed.data.assignedAgentId && parsed.data.assignedAgentId !== userId) {
      return c.json({ error: 'forbidden_assignment' }, 403);
    }
  }

  const data: Prisma.ConversationUpdateInput = {};
  const statusChanged = parsed.data.status !== undefined && parsed.data.status !== conv.status;
  const assignmentChanged =
    parsed.data.assignedAgentId !== undefined && parsed.data.assignedAgentId !== conv.assignedAgentId;
  if (parsed.data.status !== undefined) data.status = parsed.data.status;
  if (parsed.data.assignedAgentId !== undefined) data.assignedAgentId = parsed.data.assignedAgentId;

  // SLA: computa Resolution Time quando status muda
  if (statusChanged && parsed.data.status) {
    Object.assign(data, await patchResolution(id, parsed.data.status));
  }

  const updated = await prisma.conversation.update({ where: { id }, data });

  if (statusChanged) {
    await publishEvent(workspaceId, 'conversations', 'conversation.status_changed', {
      conversationId: updated.id,
      status: updated.status,
      previousStatus: conv.status,
    });

    // CSAT trigger: RESOLVED enfileira survey com delay. Reabrir cancela job pendente.
    if (updated.status === 'RESOLVED') {
      void (async () => {
        const inbox = await prisma.inbox.findUnique({
          where: { id: updated.inboxId },
          select: { type: true },
        });
        if (!inbox) return;
        const survey = await resolveSurveyForConversation(workspaceId, inbox.type);
        if (!survey) return;
        const surveyConfig = await prisma.csatSurvey.findUnique({
          where: { id: survey.id },
          select: { delayMinutes: true },
        });
        const delayMs = (surveyConfig?.delayMinutes ?? 5) * 60_000;
        await enqueueCsatSend(workspaceId, updated.id, survey.id, delayMs);
      })().catch((err) => logger.warn({ err, conversationId: updated.id }, 'csat enqueue failed'));
    } else if (conv.status === 'RESOLVED') {
      // Saiu de RESOLVED — cancela survey pendente (não enviado ainda).
      void cancelCsatSend(updated.id);
    }
  }
  if (assignmentChanged) {
    await publishEvent(workspaceId, 'conversations', 'conversation.assigned', {
      conversationId: updated.id,
      assignedAgentId: updated.assignedAgentId,
      previousAgentId: conv.assignedAgentId,
    });
  }
  return c.json({ conversation: updated });
});

// PATCH /api/conversations/:id/contact — edição inline do contato a partir do side panel
const contactPatchSchema = z.object({
  name: z.string().min(1).max(120).nullable().optional(),
  email: z.string().email().nullable().optional(),
  customAttrs: z.record(z.string(), z.unknown()).nullable().optional(),
});

/**
 * PATCH /api/conversations/:id/contact
 * Update inline do contato a partir do side panel — basic fields + customAttrs.
 * Mantém phoneNumber imutável (chave de identificação no WhatsApp).
 */
conversationsRouter.patch('/:id/contact', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const conversationId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = contactPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: { contactId: true },
  });
  if (!conv) return c.json({ error: 'not_found' }, 404);

  const updated = await prisma.contact.update({
    where: { id: conv.contactId },
    data: {
      ...(parsed.data.name !== undefined && { name: parsed.data.name }),
      ...(parsed.data.email !== undefined && { email: parsed.data.email }),
      ...(parsed.data.customAttrs !== undefined && {
        customAttrs: (parsed.data.customAttrs ?? undefined) as Prisma.InputJsonValue,
      }),
    },
  });

  await publishEvent(workspaceId, 'contacts', 'contact.updated', {
    contactId: updated.id,
    changes: parsed.data,
  });

  return c.json({ contact: updated });
});

// POST /api/conversations — cria conversa (idempotente: retorna existente se houver pra contact+inbox)
const createBody = z.object({
  contactId: z.string().min(1),
  inboxId: z.string().min(1),
});

conversationsRouter.post(
  '/',
  requireAuth,
  requireWorkspace,
  requirePermission('conversation.send_message'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const body = await c.req.json().catch(() => null);
    const parsed = createBody.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);

    const [contact, inbox] = await Promise.all([
      prisma.contact.findFirst({ where: { id: parsed.data.contactId, workspaceId } }),
      prisma.inbox.findFirst({ where: { id: parsed.data.inboxId, workspaceId } }),
    ]);
    if (!contact || !inbox) return c.json({ error: 'not_found' }, 404);

    // Reusa conversa existente OPEN/PENDING/SNOOZED pra mesmo contato+inbox
    const existing = await prisma.conversation.findFirst({
      where: {
        workspaceId,
        contactId: contact.id,
        inboxId: inbox.id,
        status: { in: ['OPEN', 'PENDING', 'SNOOZED'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return c.json({ conversation: existing, reused: true });

    const conv = await prisma.conversation.create({
      data: {
        workspaceId,
        contactId: contact.id,
        inboxId: inbox.id,
        status: 'OPEN',
      },
    });
    await publishEvent(workspaceId, 'conversations', 'conversation.created', {
      conversationId: conv.id,
      contactId: contact.id,
      inboxId: inbox.id,
    });
    return c.json({ conversation: conv, reused: false }, 201);
  },
);

// POST /api/conversations/:id/suggest-replies — 3 sugestões via OpenAI
// Body opcional: { hint?: string, count?: 1-5 }
const suggestBody = z.object({
  hint: z.string().max(500).optional(),
  count: z.number().int().min(1).max(5).default(3),
});

conversationsRouter.post(
  '/:id/suggest-replies',
  requireAuth,
  requireWorkspace,
  aiRateLimit,
  requirePermission('conversation.send_message'),
  async (c) => {
    if (!env.OPENAI_API_KEY) {
      return c.json(
        {
          error: 'ai_disabled',
          message:
            'Sugestões com IA precisam de OPENAI_API_KEY configurada. Veja .planning/COOLIFY-PASTE.md.',
        },
        503,
      );
    }
    const workspaceId = c.get('workspaceId') as string;
    const userId = c.get('userId');
    const id = c.req.param('id');

    const guard = await agentAccessGuard(c, workspaceId, id);
    if (guard) return guard;

    const body = await c.req.json().catch(() => ({}));
    const parsed = suggestBody.safeParse(body ?? {});
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

    const conv = await prisma.conversation.findFirst({
      where: { id, workspaceId },
      include: {
        contact: { select: { name: true, phoneNumber: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 12, // 12 últimas, vamos reverter pra cronológico asc
          where: { deletedAt: null },
          select: {
            direction: true,
            type: true,
            content: true,
            createdAt: true,
            transcription: true,
          },
        },
      },
    });
    if (!conv) return c.json({ error: 'not_found' }, 404);

    // Mais antiga primeiro
    const chronological = [...conv.messages].reverse();

    const history: SuggestReplyInput[] = chronological.map((m) => {
      const authorLabel = m.direction === 'INBOUND' ? 'cliente' : 'agente';
      // Pra mídia, usa transcrição (áudio) ou tag genérica do tipo
      let content = m.content?.trim() ?? '';
      if (!content) {
        if (m.type === 'AUDIO' && m.transcription) content = `[áudio transcrito] ${m.transcription}`;
        else content = `[${m.type.toLowerCase()}]`;
      }
      return {
        direction: m.direction === 'INBOUND' ? 'inbound' : 'outbound',
        authorLabel,
        content,
        at: m.createdAt,
      };
    });

    if (history.length === 0) {
      return c.json({ error: 'empty_conversation' }, 409);
    }
    const lastInbound = [...history].reverse().find((m) => m.direction === 'inbound');
    if (!lastInbound) {
      return c.json(
        {
          error: 'no_inbound',
          message: 'Sem mensagem do cliente pra responder — última atividade foi do agente.',
        },
        409,
      );
    }

    // Resolve nome do agente atual
    const agent = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    const agentName = agent?.name?.trim() || agent?.email || null;

    try {
      const started = Date.now();
      const suggestions = await suggestReplies(
        {
          contactName: conv.contact.name,
          agentName,
          history,
          hint: parsed.data.hint,
        },
        parsed.data.count,
      );
      const elapsed = Date.now() - started;
      return c.json({ suggestions, elapsedMs: elapsed, model: env.OPENAI_CHAT_MODEL });
    } catch (err) {
      logger.error({ err, conversationId: id }, 'AI suggest-replies failed');
      const message = err instanceof Error ? err.message : 'AI request failed';
      return c.json({ error: 'ai_error', message }, 502);
    }
  },
);

// POST /api/conversations/:id/ai/summarize — gera resumo IA (cache em Conversation.aiSummary)
conversationsRouter.post('/:id/ai/summarize', requireAuth, requireWorkspace, aiRateLimit, async (c) => {
  if (!env.OPENAI_API_KEY) return c.json({ error: 'ai_disabled' }, 503);
  const workspaceId = c.get('workspaceId') as string;
  const id = c.req.param('id');
  const guard = await agentAccessGuard(c, workspaceId, id);
  if (guard) return guard;
  const conv = await prisma.conversation.findFirst({
    where: { id, workspaceId },
    select: {
      id: true,
      contact: { select: { name: true } },
      messages: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: { direction: true, content: true, transcription: true, type: true },
      },
    },
  });
  if (!conv) return c.json({ error: 'not_found' }, 404);
  const history = conv.messages
    .reverse()
    .map((m) => ({
      direction: (m.direction === 'INBOUND' ? 'inbound' : 'outbound') as 'inbound' | 'outbound',
      content: m.content || m.transcription || `[${m.type.toLowerCase()}]`,
    }))
    .filter((m) => m.content.trim().length > 0);
  if (history.length === 0) {
    return c.json({ error: 'empty_conversation' }, 409);
  }
  const summary = await summarizeConversation({
    history,
    contactName: conv.contact.name,
  });
  if (!summary) return c.json({ error: 'ai_error' }, 502);
  await prisma.conversation.update({
    where: { id },
    data: { aiSummary: summary, aiSummaryAt: new Date() },
  });
  return c.json({ summary, generatedAt: new Date().toISOString() });
});

// POST /api/conversations/:id/ai/next-actions — sugere próximas ações
conversationsRouter.post('/:id/ai/next-actions', requireAuth, requireWorkspace, aiRateLimit, async (c) => {
  if (!env.OPENAI_API_KEY) return c.json({ error: 'ai_disabled' }, 503);
  const workspaceId = c.get('workspaceId') as string;
  const id = c.req.param('id');
  const guard = await agentAccessGuard(c, workspaceId, id);
  if (guard) return guard;
  const conv = await prisma.conversation.findFirst({
    where: { id, workspaceId },
    select: {
      id: true,
      status: true,
      assignedAgentId: true,
      contact: { select: { name: true } },
      messages: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 16,
        select: { direction: true, content: true, transcription: true, type: true },
      },
    },
  });
  if (!conv) return c.json({ error: 'not_found' }, 404);

  // Carrega contexto disponível pra IA escolher de listas reais
  const [members, labels, templates, stages] = await Promise.all([
    prisma.membership.findMany({
      where: { workspaceId },
      select: { userId: true, user: { select: { name: true, email: true } } },
    }),
    prisma.label.findMany({
      where: { workspaceId, scope: { in: ['CONVERSATION', 'BOTH'] } },
      select: { name: true, color: true },
      take: 30,
    }),
    prisma.messageTemplate.findMany({
      where: { workspaceId },
      select: { name: true, shortcut: true },
      take: 30,
    }),
    prisma.stage.findMany({
      where: { funnel: { workspaceId } },
      select: { name: true, outcome: true },
      take: 30,
    }),
  ]);

  const agentTargets = buildMentionTargets(
    members.map((m) => ({ userId: m.userId, user: m.user })),
  );
  const availableAgents = agentTargets.map((t) => ({ slug: t.slug, name: t.name }));
  const currentAgent = conv.assignedAgentId
    ? agentTargets.find((t) => t.userId === conv.assignedAgentId)
    : null;

  const history = conv.messages
    .reverse()
    .map((m) => ({
      direction: (m.direction === 'INBOUND' ? 'inbound' : 'outbound') as 'inbound' | 'outbound',
      content: m.content || m.transcription || `[${m.type.toLowerCase()}]`,
    }))
    .filter((m) => m.content.trim().length > 0);
  if (history.length === 0) {
    return c.json({ error: 'empty_conversation' }, 409);
  }

  // Pega stage atual via card linkado (se houver)
  const card = await prisma.card.findFirst({
    where: { conversationId: id, workspaceId },
    select: { stage: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });

  const actions = await suggestNextActions({
    history,
    contactName: conv.contact.name,
    currentAgentSlug: currentAgent?.slug ?? null,
    availableAgents,
    availableLabels: labels.map((l) => ({ name: l.name, color: l.color })),
    availableTemplates: templates.map((t) => ({ name: t.name, shortcut: t.shortcut })),
    availableStages: stages.map((s) => ({
      name: s.name,
      outcome: s.outcome as 'POSITIVE' | 'NEGATIVE' | 'RISK' | null,
    })),
    currentStatus: conv.status,
    currentStageName: card?.stage.name ?? null,
  });

  const generatedAt = new Date();
  await prisma.conversation.update({
    where: { id },
    data: { aiSuggestedActions: actions, aiSuggestedAt: generatedAt },
  });
  return c.json({ actions, generatedAt: generatedAt.toISOString() });
});

// POST /api/conversations/:id/ai/classify — força re-classify imediato (debug/manual)
conversationsRouter.post('/:id/ai/classify', requireAuth, requireWorkspace, aiRateLimit, async (c) => {
  if (!env.OPENAI_API_KEY) return c.json({ error: 'ai_disabled' }, 503);
  const workspaceId = c.get('workspaceId') as string;
  const id = c.req.param('id');
  const guard = await agentAccessGuard(c, workspaceId, id);
  if (guard) return guard;
  const conv = await prisma.conversation.findFirst({
    where: { id, workspaceId },
    select: {
      id: true,
      contact: { select: { name: true } },
      messages: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: { direction: true, content: true, transcription: true, type: true },
      },
    },
  });
  if (!conv) return c.json({ error: 'not_found' }, 404);
  const history = conv.messages
    .reverse()
    .map((m) => ({
      direction: (m.direction === 'INBOUND' ? 'inbound' : 'outbound') as 'inbound' | 'outbound',
      content: m.content || m.transcription || `[${m.type.toLowerCase()}]`,
    }))
    .filter((m) => m.content.trim().length > 0);
  if (history.length === 0) {
    return c.json({ error: 'empty_conversation' }, 409);
  }
  const result = await classifyConversation({ history, contactName: conv.contact.name });
  if (!result) return c.json({ error: 'ai_error' }, 502);
  const classification = { ...result, classifiedAt: new Date().toISOString() };
  await prisma.conversation.update({
    where: { id },
    data: { aiClassification: classification },
  });
  await publishEvent(workspaceId, 'conversations', 'conversation.classified', {
    conversationId: id,
    classification,
  });
  return c.json({ classification });
});

// POST /api/conversations/:id/ai/kb-suggest — força recompute de sugestão KB on-demand.
conversationsRouter.post('/:id/ai/kb-suggest', requireAuth, requireWorkspace, aiRateLimit, async (c) => {
  if (!env.OPENAI_API_KEY) return c.json({ error: 'ai_disabled' }, 503);
  const workspaceId = c.get('workspaceId') as string;
  const id = c.req.param('id');
  const guard = await agentAccessGuard(c, workspaceId, id);
  if (guard) return guard;
  const conv = await prisma.conversation.findFirst({
    where: { id, workspaceId },
    select: { id: true },
  });
  if (!conv) return c.json({ error: 'not_found' }, 404);
  await aiQueue.add(
    'kb-suggest',
    { workspaceId, kind: 'kb-suggest', targetId: id },
    { jobId: `kb-suggest__${id}` },
  );
  return c.json({ ok: true, queued: true });
});

// POST /api/conversations/:id/ai/kb-suggest/accept — marca métrica + remove card.
// Chamado pelo frontend quando agente clica "Inserir resposta".
conversationsRouter.post('/:id/ai/kb-suggest/accept', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const id = c.req.param('id');
  const conv = await prisma.conversation.findFirst({
    where: { id, workspaceId },
    select: { id: true, aiKbSuggestion: true },
  });
  if (!conv) return c.json({ error: 'not_found' }, 404);
  if (!conv.aiKbSuggestion) return c.json({ error: 'no_suggestion' }, 409);
  await prisma.conversation.update({
    where: { id },
    data: { aiKbSuggestionAccepted: true },
  });
  await publishEvent(workspaceId, 'conversations', 'conversation.kb_suggestion_accepted', {
    conversationId: id,
  });
  return c.json({ ok: true });
});

// POST /api/conversations/:id/ai/kb-suggest/dismiss — descarta sugestão.
// Agente decidiu que o artigo não serve — limpa o card.
conversationsRouter.post('/:id/ai/kb-suggest/dismiss', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const id = c.req.param('id');
  const conv = await prisma.conversation.findFirst({
    where: { id, workspaceId },
    select: { id: true },
  });
  if (!conv) return c.json({ error: 'not_found' }, 404);
  await prisma.conversation.update({
    where: { id },
    data: {
      aiKbSuggestion: Prisma.DbNull,
      aiKbSuggestionAt: null,
      aiKbSuggestionAccepted: false,
    },
  });
  await publishEvent(workspaceId, 'conversations', 'conversation.kb_suggestion_dismissed', {
    conversationId: id,
  });
  return c.json({ ok: true });
});

// POST /api/conversations/:id/read — zera unreadCount
conversationsRouter.post('/:id/read', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const id = c.req.param('id');
  const conv = await prisma.conversation.findFirst({ where: { id, workspaceId } });
  if (!conv) return c.json({ error: 'not_found' }, 404);
  if (conv.unreadCount === 0) return c.json({ ok: true });
  const updated = await prisma.conversation.update({
    where: { id },
    data: { unreadCount: 0 },
  });
  await publishEvent(workspaceId, 'conversations', 'conversation.read', {
    conversationId: updated.id,
  });
  return c.json({ ok: true });
});

// POST /api/conversations/:id/unread — marca como não lida (unreadCount = max(1, atual))
conversationsRouter.post('/:id/unread', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const id = c.req.param('id');
  const conv = await prisma.conversation.findFirst({ where: { id, workspaceId } });
  if (!conv) return c.json({ error: 'not_found' }, 404);
  if (conv.unreadCount > 0) return c.json({ ok: true });
  const updated = await prisma.conversation.update({
    where: { id },
    data: { unreadCount: 1 },
  });
  await publishEvent(workspaceId, 'conversations', 'conversation.updated', {
    conversationId: updated.id,
    unreadCount: 1,
  });
  return c.json({ ok: true });
});

// POST /api/conversations/:id/archive — arquiva (esconde das listas padrão)
conversationsRouter.post('/:id/archive', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const id = c.req.param('id');
  const conv = await prisma.conversation.findFirst({ where: { id, workspaceId } });
  if (!conv) return c.json({ error: 'not_found' }, 404);
  if (conv.archivedAt) return c.json({ ok: true });
  await prisma.conversation.update({
    where: { id },
    data: { archivedAt: new Date() },
  });
  await publishEvent(workspaceId, 'conversations', 'conversation.archived', {
    conversationId: id,
  });
  return c.json({ ok: true });
});

// POST /api/conversations/:id/unarchive — desarquiva
conversationsRouter.post('/:id/unarchive', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const id = c.req.param('id');
  const conv = await prisma.conversation.findFirst({ where: { id, workspaceId } });
  if (!conv) return c.json({ error: 'not_found' }, 404);
  if (!conv.archivedAt) return c.json({ ok: true });
  await prisma.conversation.update({
    where: { id },
    data: { archivedAt: null },
  });
  await publishEvent(workspaceId, 'conversations', 'conversation.unarchived', {
    conversationId: id,
  });
  return c.json({ ok: true });
});

// POST /api/conversations/:id/messages (envia)
const sendBody = z
  .object({
    type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT']).default('TEXT'),
    text: z.string().max(4096).optional(),
    mediaUrl: z.string().url().optional(),
    mimeType: z.string().max(120).optional(),
    fileName: z.string().max(255).optional(),
    replyToMessageId: z.string().optional(),
  })
  .refine(
    (data) => {
      if (data.type === 'TEXT') return !!data.text && data.text.length > 0;
      return !!data.mediaUrl;
    },
    { message: 'TEXT requires text; media types require mediaUrl' },
  );

conversationsRouter.post(
  '/:id/messages',
  requireAuth,
  requireWorkspace,
  requirePermission('conversation.send_message'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const role = c.get('role')!;
    const userId = c.get('userId');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const parsed = sendBody.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

    const conv = await prisma.conversation.findFirst({
      where: { id, workspaceId },
      include: { contact: true, inbox: { select: { id: true, status: true, type: true } } },
    });
    if (!conv) return c.json({ error: 'not_found' }, 404);
    if (role === 'AGENT' && conv.assignedAgentId && conv.assignedAgentId !== userId) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (conv.inbox.status !== 'CONNECTED') {
      return c.json({ error: 'inbox_not_connected' }, 409);
    }
    // Email-specific: precisa de contact.email + só TEXT no MVP (sem anexos).
    if (conv.inbox.type === 'EMAIL') {
      if (!conv.contact.email) {
        return c.json({ error: 'contact_no_email' }, 400);
      }
      if (parsed.data.type !== 'TEXT') {
        return c.json({ error: 'email_only_text', message: 'Email só suporta texto no MVP — anexos virão depois.' }, 400);
      }
    }
    // Webchat: só texto no MVP. Mídia inline futura.
    if (conv.inbox.type === 'WEBCHAT' && parsed.data.type !== 'TEXT') {
      return c.json({ error: 'webchat_only_text', message: 'Webchat só suporta texto no MVP.' }, 400);
    }

    // Rate limit anti-ban WhatsApp: 30 msgs/min por inbox.
    try {
      await outboundLimiter.consume(`inbox:${conv.inboxId}`);
    } catch {
      logger.warn({ inboxId: conv.inboxId, workspaceId }, 'outbound rate-limited');
      return c.json(
        {
          error: 'rate_limited',
          message: 'Muitas mensagens nessa inbox em pouco tempo. Aguarde 1 minuto pra evitar ban do WhatsApp.',
        },
        429,
      );
    }

    // Se reply, valida que a msg referenciada existe na mesma conversa
    let quotedWaMessageId: string | undefined;
    if (parsed.data.replyToMessageId) {
      const quoted = await prisma.message.findFirst({
        where: { id: parsed.data.replyToMessageId, conversationId: conv.id },
        select: { id: true, waMessageId: true },
      });
      if (!quoted) return c.json({ error: 'reply_target_not_found' }, 404);
      quotedWaMessageId = quoted.waMessageId ?? undefined;
    }

    // Cria Message PENDING
    const msg = await prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: 'OUTBOUND',
        type: parsed.data.type,
        content: parsed.data.text ?? null,
        mediaUrl: parsed.data.mediaUrl ?? null,
        mediaMimeType: parsed.data.mimeType ?? null,
        replyToId: parsed.data.replyToMessageId ?? null,
        status: 'PENDING',
      },
    });
    // Cache do preview pra lista de conversas
    const preview = parsed.data.text
      ? parsed.data.text.slice(0, 80)
      : `[${parsed.data.type.toLowerCase()}]`;
    // SLA: registra FRT se primeira resposta de agente
    const slaPatch = await patchFirstResponse(conv.id, msg.createdAt);
    // Auto-atribui o agente que enviou (se conversa não atribuída)
    if (!conv.assignedAgentId) {
      await prisma.conversation.update({
        where: { id: conv.id },
        data: {
          assignedAgentId: userId,
          lastMessageAt: msg.createdAt,
          lastAgentRepliedId: userId,
          lastOutboundAt: msg.createdAt,
          lastMessagePreview: preview,
          ...slaPatch,
        },
      });
    } else {
      await prisma.conversation.update({
        where: { id: conv.id },
        data: {
          lastMessageAt: msg.createdAt,
          lastAgentRepliedId: userId,
          lastOutboundAt: msg.createdAt,
          lastMessagePreview: preview,
          ...slaPatch,
        },
      });
    }

    // Sync cards linkados — reseta SLA porque agente respondeu agora
    await prisma.card.updateMany({
      where: { conversationId: conv.id },
      data: {
        lastAgentReplyAt: msg.createdAt,
        slaStatus: 'green',
        unreadCount: 0,
      },
    });

    // Enfileira na queue certa baseada no canal da inbox (WHATSAPP/TELEGRAM)
    await dispatchOutbound({
      inboxId: conv.inboxId,
      workspaceId,
      conversationId: conv.id,
      messageId: msg.id,
      to: conv.contact.phoneNumber ?? '',
      type: parsed.data.type,
      text: parsed.data.text,
      mediaUrl: parsed.data.mediaUrl,
      mimeType: parsed.data.mimeType,
      fileName: parsed.data.fileName,
      quotedWaMessageId,
    });

    await publishEvent(workspaceId, 'messages', 'message.new', {
      conversationId: conv.id,
      message: msg,
    });

    return c.json({ message: msg }, 201);
  },
);
