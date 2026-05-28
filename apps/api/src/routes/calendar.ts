import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';
import { audit } from '../services/audit.js';
import { publishEvent } from '../redis-pub.js';
import { createNotification } from '../services/notifications.js';

export const calendarRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

const eventSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  eventDate: z.string().datetime(),
  type: z
    .enum(['APPLICATION', 'MAINTENANCE', 'REPAIR', 'SALE_FOLLOWUP', 'TASK', 'OTHER'])
    .default('OTHER'),
  conversationId: z.string().nullable().optional(),
  contactId: z.string().nullable().optional(),
  cardId: z.string().nullable().optional(),
  assignedUserId: z.string().nullable().optional(),
});

async function assertAssigneeInWorkspace(
  userId: string | null | undefined,
  workspaceId: string,
): Promise<boolean> {
  if (!userId) return true;
  const member = await prisma.membership.findFirst({
    where: { userId, workspaceId },
    select: { id: true },
  });
  return !!member;
}

/**
 * GET /api/calendar?from=ISO&to=ISO — lista eventos do workspace no range.
 * Default: mês atual se sem params.
 */
calendarRouter.get('/', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const fromStr = c.req.query('from');
  const toStr = c.req.query('to');
  const cardId = c.req.query('cardId');
  const typeFilter = c.req.query('type');

  // Quando filtro por cardId/type, ignora o range (lista todos do card).
  // Sem cardId/type, usa range padrão (mês atual).
  const useRange = !cardId && !typeFilter;
  const now = new Date();
  const from = fromStr ? new Date(fromStr) : new Date(now.getFullYear(), now.getMonth(), 1);
  const to = toStr
    ? new Date(toStr)
    : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  const events = await prisma.calendarEvent.findMany({
    where: {
      workspaceId,
      ...(useRange ? { eventDate: { gte: from, lte: to } } : {}),
      ...(cardId ? { cardId } : {}),
      ...(typeFilter ? { type: typeFilter as 'TASK' | 'APPLICATION' | 'MAINTENANCE' | 'REPAIR' | 'SALE_FOLLOWUP' | 'OTHER' } : {}),
    },
    orderBy: { eventDate: 'asc' },
    include: {
      assignedUser: { select: { id: true, name: true, email: true } },
      contact: { select: { id: true, name: true, phoneNumber: true } },
    },
  });
  return c.json({ events });
});

/**
 * POST /api/calendar — cria evento
 */
calendarRouter.post('/', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const userId = c.get('userId')!;
  const body = await c.req.json().catch(() => null);
  const parsed = eventSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

  if (!(await assertAssigneeInWorkspace(parsed.data.assignedUserId, workspaceId))) {
    return c.json({ error: 'assignee_not_in_workspace' }, 400);
  }

  const event = await prisma.calendarEvent.create({
    data: {
      workspaceId,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      eventDate: new Date(parsed.data.eventDate),
      type: parsed.data.type,
      conversationId: parsed.data.conversationId ?? null,
      contactId: parsed.data.contactId ?? null,
      cardId: parsed.data.cardId ?? null,
      assignedUserId: parsed.data.assignedUserId ?? null,
      createdBy: userId,
    },
  });

  void audit({
    workspaceId,
    actorId: userId,
    action: 'calendar_event.created',
    resource: `CalendarEvent:${event.id}`,
    metadata: { eventDate: event.eventDate, type: event.type },
  });

  // Notifica o assignee na hora — sino fica esperando o calendar-scheduler disparar
  // só no dia do evento. Especialmente útil pra tarefas (type=TASK).
  if (event.assignedUserId && event.assignedUserId !== userId) {
    const dateLabel = event.eventDate.toLocaleString('es-PY', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const isTask = event.type === 'TASK';
    void createNotification({
      workspaceId,
      userId: event.assignedUserId,
      kind: 'calendar.reminder',
      title: isTask ? `Nova tarefa: ${event.title}` : `Novo evento: ${event.title}`,
      body: `Vencimento: ${dateLabel}`,
      link: event.cardId ? `/kanban?cardId=${event.cardId}` : '/calendar',
      metadata: { eventId: event.id, type: event.type, eventDate: event.eventDate },
    });
  }

  await publishEvent(workspaceId, 'calendar', 'calendar_event.created', { event });
  return c.json({ event }, 201);
});

/**
 * PATCH /api/calendar/:id — update (reagendar, reatribuir, editar)
 */
calendarRouter.patch('/:id', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = eventSchema.partial().safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

  const existing = await prisma.calendarEvent.findFirst({
    where: { id, workspaceId },
    select: { id: true },
  });
  if (!existing) return c.json({ error: 'not_found' }, 404);

  if (!(await assertAssigneeInWorkspace(parsed.data.assignedUserId, workspaceId))) {
    return c.json({ error: 'assignee_not_in_workspace' }, 400);
  }

  const event = await prisma.calendarEvent.update({
    where: { id },
    data: {
      ...(parsed.data.title !== undefined && { title: parsed.data.title }),
      ...(parsed.data.description !== undefined && { description: parsed.data.description }),
      ...(parsed.data.eventDate !== undefined && { eventDate: new Date(parsed.data.eventDate) }),
      ...(parsed.data.type !== undefined && { type: parsed.data.type }),
      ...(parsed.data.assignedUserId !== undefined && { assignedUserId: parsed.data.assignedUserId }),
    },
  });

  await publishEvent(workspaceId, 'calendar', 'calendar_event.updated', { event });
  return c.json({ event });
});

/**
 * PATCH /api/calendar/:id/status — marca DONE/CANCELLED/SCHEDULED
 */
calendarRouter.patch('/:id/status', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ status: z.enum(['SCHEDULED', 'DONE', 'CANCELLED']) }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);

  const existing = await prisma.calendarEvent.findFirst({
    where: { id, workspaceId },
    select: { id: true },
  });
  if (!existing) return c.json({ error: 'not_found' }, 404);

  const event = await prisma.calendarEvent.update({
    where: { id },
    data: { status: parsed.data.status },
  });
  await publishEvent(workspaceId, 'calendar', 'calendar_event.updated', { event });
  return c.json({ event });
});

/**
 * DELETE /api/calendar/:id
 */
calendarRouter.delete('/:id', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const id = c.req.param('id');
  const existing = await prisma.calendarEvent.findFirst({
    where: { id, workspaceId },
    select: { id: true },
  });
  if (!existing) return c.json({ error: 'not_found' }, 404);
  await prisma.calendarEvent.delete({ where: { id } });
  await publishEvent(workspaceId, 'calendar', 'calendar_event.deleted', { id });
  return c.json({ ok: true });
});
