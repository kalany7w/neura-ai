# Calendário de Eventos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Calendário compartilhado dentro do Neura: agendar eventos com data (aplicação de produto, manutenção, reparação, follow-up de venda), visíveis por toda a equipe. Quando chega o dia, alerta in-app (notificação). Criação manual (dialog no chat) + sugestão IA (detecta data no texto do cliente, agente confirma).

**Architecture:** Modelo `CalendarEvent` (workspace-scoped, vinculável a conversation/contact/card). Routes CRUD + list por range. Scheduler BullMQ (repeat every 5min) que detecta eventos do dia sem reminder e dispara `createNotification` ao responsável + WS. Service `ai-detect-schedule` analisa texto inbound, se detecta intenção de agendar publica WS `calendar.suggestion` → banner no chat → agente confirma com 1 click. UI: página `/calendar` (vista mensal grid CSS), dialog "Agendar" no side panel, banner de sugestão.

**Tech Stack:** Prisma 6 + Hono + Zod + BullMQ (api), Next.js + react-query + shadcn (web), OpenAI (detecção). Vitest.

**Decisões (confirmadas com Kalan)**:

- Calendário próprio dentro do Neura (não Google Calendar)
- Criação híbrida: manual (dialog) + sugestão IA (agente confirma)
- Alerta: notificação in-app (sino existente), sem Discord/email/recordatorio anticipado por enquanto

---

## File Structure

### Schema

- Modify: `packages/database/prisma/schema.prisma` — `CalendarEvent` model + `CalendarEventType` enum + `CalendarEventStatus` enum + relações back em Workspace/User/Conversation/Contact/Card

### API

- Create: `apps/api/src/routes/calendar.ts` — CRUD eventos + GET por range
- Create: `apps/api/src/calendar-scheduler.ts` — cron BullMQ que alerta eventos do dia
- Create: `apps/api/src/services/ai-detect-schedule.ts` — detecta data/intenção de agendar no texto
- Modify: `apps/api/src/services/notifications.ts` — adicionar kind `'calendar.reminder'`
- Modify: `apps/api/src/index.ts` — wire calendarRouter + startCalendarScheduler
- Modify: `apps/api/src/redis-pub.ts` (ou onde processa message.new) — hook ai-detect-schedule

### Web

- Create: `apps/web/src/app/(app)/calendar/page.tsx` — vista mensal
- Create: `apps/web/src/components/calendar/schedule-event-dialog.tsx` — dialog criar/editar evento
- Create: `apps/web/src/components/calendar/schedule-suggestion-banner.tsx` — banner sugestão IA no chat
- Modify: `apps/web/src/components/inbox/conversation-side-panel.tsx` — botão "Agendar"
- Modify: `apps/web/src/app/(app)/inbox/[id]/page.tsx` — montar banner de sugestão
- Modify: `apps/web/src/components/layout/sidebar.tsx` — link "Calendário"

### Tests

- Create: `apps/api/tests/calendar-route.test.ts` — DB layer + constraints

---

## Task 1: Schema migration — CalendarEvent

**Files:**

- Modify: `packages/database/prisma/schema.prisma`

- [ ] **Step 1: Adicionar enums + model**

No final do schema (antes do último `@@map` global ou junto de outros models de domínio), adicionar:

```prisma
enum CalendarEventType {
  APPLICATION    // aplicação de produto (ex: pulverização agendada)
  MAINTENANCE    // manutenção preventiva
  REPAIR         // reparação
  SALE_FOLLOWUP  // follow-up de venda (demo, visita, fechamento)
  OTHER
}

enum CalendarEventStatus {
  SCHEDULED
  DONE
  CANCELLED
}

model CalendarEvent {
  id             String              @id @default(cuid())
  workspaceId    String
  title          String
  description    String?             @db.Text
  eventDate      DateTime
  type           CalendarEventType   @default(OTHER)
  status         CalendarEventStatus @default(SCHEDULED)
  // Vínculos opcionais — o evento pode nascer de um chat/contato/card ou ser standalone
  conversationId String?
  contactId      String?
  cardId         String?
  // Responsável pelo evento (recebe a notificação no dia)
  assignedUserId String?
  // Timestamp quando o reminder do dia foi disparado (idempotência do scheduler)
  reminderSentAt DateTime?
  createdBy      String
  createdAt      DateTime            @default(now())
  updatedAt      DateTime            @updatedAt

  workspace    Workspace     @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  conversation Conversation? @relation(fields: [conversationId], references: [id], onDelete: SetNull)
  contact      Contact?      @relation(fields: [contactId], references: [id], onDelete: SetNull)
  card         Card?         @relation(fields: [cardId], references: [id], onDelete: SetNull)
  assignedUser User?         @relation("CalendarEventAssignee", fields: [assignedUserId], references: [id], onDelete: SetNull)

  @@index([workspaceId, eventDate])
  @@index([workspaceId, status])
  @@index([assignedUserId])
  @@map("calendar_events")
}
```

- [ ] **Step 2: Adicionar relações back**

Em `model Workspace`: `calendarEvents CalendarEvent[]`
Em `model User`: `calendarEventsAssignedToMe CalendarEvent[] @relation("CalendarEventAssignee")`
Em `model Conversation`: `calendarEvents CalendarEvent[]`
Em `model Contact`: `calendarEvents CalendarEvent[]`
Em `model Card`: `calendarEvents CalendarEvent[]`

- [ ] **Step 3: Gerar migration (--create-only) e limpar drift**

```bash
cd packages/database
export PATH="$HOME/.node22-portable/node-v22.13.1-win-x64:$PATH"
pnpm prisma migrate dev --name add_calendar_events --create-only
```

Ler o SQL gerado em `prisma/migrations/<ts>_add_calendar_events/migration.sql`. Se houver `DROP INDEX kb_articles_embedding_hnsw_idx` (pgvector drift), REMOVER essa linha. Manter apenas o `CreateEnum` + `CreateTable` + indexes + FKs do CalendarEvent.

- [ ] **Step 4: Aplicar + gerar client**

```bash
pnpm prisma migrate deploy
pnpm prisma generate
```

- [ ] **Step 5: Typecheck**

```bash
cd ../..
pnpm --filter @neura/database typecheck
pnpm --filter @neura/api typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/
git commit -m "feat(db): adiciona CalendarEvent model + enums"
```

---

## Task 2: Routes calendar.ts — CRUD + list por range

**Files:**

- Create: `apps/api/src/routes/calendar.ts`

- [ ] **Step 1: Criar route**

```typescript
import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';
import { audit } from '../services/audit.js';
import { publishEvent } from '../redis-pub.js';

export const calendarRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

const eventSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  eventDate: z.string().datetime(),
  type: z.enum(['APPLICATION', 'MAINTENANCE', 'REPAIR', 'SALE_FOLLOWUP', 'OTHER']).default('OTHER'),
  conversationId: z.string().nullable().optional(),
  contactId: z.string().nullable().optional(),
  cardId: z.string().nullable().optional(),
  assignedUserId: z.string().nullable().optional(),
});

/**
 * GET /api/calendar?from=ISO&to=ISO
 * Lista eventos do workspace no range. Default: mês atual se sem params.
 */
calendarRouter.get('/', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const fromStr = c.req.query('from');
  const toStr = c.req.query('to');

  const now = new Date();
  const from = fromStr ? new Date(fromStr) : new Date(now.getFullYear(), now.getMonth(), 1);
  const to = toStr
    ? new Date(toStr)
    : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  const events = await prisma.calendarEvent.findMany({
    where: { workspaceId, eventDate: { gte: from, lte: to } },
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

  // Validar assignedUser é member (se passado)
  if (parsed.data.assignedUserId) {
    const member = await prisma.membership.findFirst({
      where: { userId: parsed.data.assignedUserId, workspaceId },
      select: { id: true },
    });
    if (!member) return c.json({ error: 'assignee_not_in_workspace' }, 400);
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

  await publishEvent(workspaceId, 'calendar', 'calendar_event.created', { event });

  return c.json({ event }, 201);
});

/**
 * PATCH /api/calendar/:id — update (reagendar, mudar status, reatribuir)
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

  if (parsed.data.assignedUserId) {
    const member = await prisma.membership.findFirst({
      where: { userId: parsed.data.assignedUserId, workspaceId },
      select: { id: true },
    });
    if (!member) return c.json({ error: 'assignee_not_in_workspace' }, 400);
  }

  const event = await prisma.calendarEvent.update({
    where: { id },
    data: {
      ...(parsed.data.title !== undefined && { title: parsed.data.title }),
      ...(parsed.data.description !== undefined && { description: parsed.data.description }),
      ...(parsed.data.eventDate !== undefined && { eventDate: new Date(parsed.data.eventDate) }),
      ...(parsed.data.type !== undefined && { type: parsed.data.type }),
      ...(parsed.data.assignedUserId !== undefined && {
        assignedUserId: parsed.data.assignedUserId,
      }),
      // status vem como campo separado se passado via body cru (não no eventSchema) — ver abaixo
    },
  });

  await publishEvent(workspaceId, 'calendar', 'calendar_event.updated', { event });
  return c.json({ event });
});

/**
 * PATCH /api/calendar/:id/status — marca DONE/CANCELLED
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
```

- [ ] **Step 2: Typecheck**

```bash
export PATH="$HOME/.node22-portable/node-v22.13.1-win-x64:$PATH"
pnpm --filter @neura/api typecheck
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/calendar.ts
git commit -m "feat(api): routes calendar CRUD + list por range"
```

---

## Task 3: Wire calendarRouter + notification kind

**Files:**

- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/services/notifications.ts`

- [ ] **Step 1: Adicionar kind calendar.reminder**

Em `apps/api/src/services/notifications.ts`, estender o type `NotifKind`:

```typescript
type NotifKind =
  | 'message.new'
  | 'conversation.assigned'
  | 'sla.critical'
  | 'card.outcome'
  | 'calendar.reminder';
```

- [ ] **Step 2: Wire router em index.ts**

```typescript
import { calendarRouter } from './routes/calendar.js';
// ...
app.route('/api/calendar', calendarRouter);
```

- [ ] **Step 3: Build api**

```bash
pnpm --filter @neura/api build
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/index.ts apps/api/src/services/notifications.ts
git commit -m "feat(api): wire calendarRouter + notification kind calendar.reminder"
```

---

## Task 4: calendar-scheduler.ts — alerta do dia

**Files:**

- Create: `apps/api/src/calendar-scheduler.ts`

- [ ] **Step 1: Implementar scheduler BullMQ**

Seguir o padrão de `apps/api/src/snooze.ts` (Queue + Worker + repeat):

```typescript
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { prisma } from './db.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { publishEvent } from './redis-pub.js';
import { createNotification } from './services/notifications.js';

const QUEUE_CALENDAR = 'calendar-reminders';
const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const calendarQueue = new Queue(QUEUE_CALENDAR, {
  connection: bullConnection,
  defaultJobOptions: { removeOnComplete: true, removeOnFail: { age: 24 * 60 * 60 } },
});

/**
 * Dispara reminders pra eventos cujo eventDate já chegou (<= now), status SCHEDULED,
 * sem reminder enviado ainda. Notifica o assignedUser (ou todos os members se sem responsável).
 */
async function fireReminders(_job: Job): Promise<void> {
  const now = new Date();
  const due = await prisma.calendarEvent.findMany({
    where: {
      eventDate: { lte: now },
      status: 'SCHEDULED',
      reminderSentAt: null,
    },
    include: {
      assignedUser: { select: { id: true } },
      contact: { select: { name: true } },
    },
    take: 100,
  });

  for (const ev of due) {
    // Marca reminder enviado primeiro (idempotência — evita double-fire se cron sobrepõe)
    await prisma.calendarEvent.update({
      where: { id: ev.id },
      data: { reminderSentAt: now },
    });

    const title = `Evento hoje: ${ev.title}`;
    const body = ev.contact?.name ? `Cliente: ${ev.contact.name}` : undefined;
    const link = ev.conversationId ? `/inbox/${ev.conversationId}` : '/calendar';

    if (ev.assignedUserId) {
      // Notifica só o responsável
      await createNotification({
        workspaceId: ev.workspaceId,
        userId: ev.assignedUserId,
        kind: 'calendar.reminder',
        title,
        body,
        link,
        metadata: { eventId: ev.id, type: ev.type },
      });
    } else {
      // Sem responsável → notifica todos os members do workspace
      const members = await prisma.membership.findMany({
        where: { workspaceId: ev.workspaceId },
        select: { userId: true },
      });
      for (const m of members) {
        await createNotification({
          workspaceId: ev.workspaceId,
          userId: m.userId,
          kind: 'calendar.reminder',
          title,
          body,
          link,
          metadata: { eventId: ev.id, type: ev.type },
        });
      }
    }

    await publishEvent(ev.workspaceId, 'calendar', 'calendar_event.reminder', { eventId: ev.id });
  }

  if (due.length > 0) {
    logger.info({ count: due.length }, 'calendar-scheduler: reminders disparados');
  }
}

export const calendarWorker = new Worker(QUEUE_CALENDAR, fireReminders, {
  connection: bullConnection,
});

export async function startCalendarScheduler(): Promise<void> {
  await calendarQueue.add(
    'tick',
    {},
    { repeat: { every: 5 * 60 * 1000 }, jobId: 'calendar-reminder-tick' },
  );
  logger.info('Calendar scheduler iniciado (poll 5min)');
}
```

- [ ] **Step 2: Wire em index.ts**

```typescript
import { calendarWorker } from './calendar-scheduler.js';
import { startCalendarScheduler } from './calendar-scheduler.js';
// ...junto com outros schedulers:
await startCalendarScheduler();
void calendarWorker;
```

- [ ] **Step 3: Build**

```bash
export PATH="$HOME/.node22-portable/node-v22.13.1-win-x64:$PATH"
pnpm --filter @neura/api build
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/calendar-scheduler.ts apps/api/src/index.ts
git commit -m "feat(api): calendar-scheduler — alerta in-app no dia do evento (poll 5min)"
```

---

## Task 5: Tests calendar route (DB layer)

**Files:**

- Create: `apps/api/tests/calendar-route.test.ts`

- [ ] **Step 1: Escrever testes**

```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { prisma } from '@neura/database';

let workspaceId: string;
let userId: string;
let contactId: string;

beforeAll(async () => {
  await prisma.calendarEvent.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany({ where: { email: { endsWith: '-cal@test.com' } } });

  const user = await prisma.user.create({ data: { email: 'cal@test.com', name: 'Cal User' } });
  userId = user.id;
  const ws = await prisma.workspace.create({
    data: { name: 'Cal WS', slug: 'cal-ws', members: { create: { userId, role: 'ADMIN' } } },
  });
  workspaceId = ws.id;
  const contact = await prisma.contact.create({
    data: { workspaceId, phoneNumber: '+595981999888', name: 'Felix' },
  });
  contactId = contact.id;
});

beforeEach(async () => {
  await prisma.calendarEvent.deleteMany();
});

describe('CalendarEvent — DB layer', () => {
  it('cria evento com vínculo a contato', async () => {
    const ev = await prisma.calendarEvent.create({
      data: {
        workspaceId,
        title: 'Aplicação de produto — Felix',
        eventDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
        type: 'APPLICATION',
        contactId,
        assignedUserId: userId,
        createdBy: userId,
      },
    });
    expect(ev.id).toBeTruthy();
    expect(ev.status).toBe('SCHEDULED');
    expect(ev.reminderSentAt).toBeNull();
  });

  it('query por range retorna eventos dentro do período', async () => {
    const today = new Date();
    const in10days = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const in40days = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);

    await prisma.calendarEvent.create({
      data: { workspaceId, title: 'Dentro', eventDate: in10days, createdBy: userId },
    });
    await prisma.calendarEvent.create({
      data: { workspaceId, title: 'Fora', eventDate: in40days, createdBy: userId },
    });

    const from = today;
    const to = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const events = await prisma.calendarEvent.findMany({
      where: { workspaceId, eventDate: { gte: from, lte: to } },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe('Dentro');
  });

  it('contact deletado → calendarEvent.contactId vira null (SetNull)', async () => {
    const contact2 = await prisma.contact.create({
      data: { workspaceId, phoneNumber: '+595981777666', name: 'Temp' },
    });
    const ev = await prisma.calendarEvent.create({
      data: {
        workspaceId,
        title: 'Test',
        eventDate: new Date(),
        contactId: contact2.id,
        createdBy: userId,
      },
    });
    await prisma.contact.delete({ where: { id: contact2.id } });
    const refetch = await prisma.calendarEvent.findUnique({ where: { id: ev.id } });
    expect(refetch?.contactId).toBeNull();
  });

  it('reminderSentAt funciona como flag de idempotência', async () => {
    const ev = await prisma.calendarEvent.create({
      data: {
        workspaceId,
        title: 'Reminder test',
        eventDate: new Date(Date.now() - 1000),
        status: 'SCHEDULED',
        createdBy: userId,
      },
    });
    // Simula query do scheduler
    const due = await prisma.calendarEvent.findMany({
      where: { eventDate: { lte: new Date() }, status: 'SCHEDULED', reminderSentAt: null },
    });
    expect(due.map((e) => e.id)).toContain(ev.id);

    await prisma.calendarEvent.update({
      where: { id: ev.id },
      data: { reminderSentAt: new Date() },
    });
    const dueAfter = await prisma.calendarEvent.findMany({
      where: { eventDate: { lte: new Date() }, status: 'SCHEDULED', reminderSentAt: null },
    });
    expect(dueAfter.map((e) => e.id)).not.toContain(ev.id);
  });
});
```

- [ ] **Step 2: Rodar**

```bash
cd apps/api
export PATH="$HOME/.node22-portable/node-v22.13.1-win-x64:$PATH"
export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5435/neura_ai'
export REDIS_URL='redis://127.0.0.1:6379'
./node_modules/.bin/vitest run tests/calendar-route.test.ts
```

Expected: 4 testes PASS.

- [ ] **Step 3: Commit**

```bash
cd ../..
git add apps/api/tests/calendar-route.test.ts
git commit -m "test(api): calendar event DB layer (range query, SetNull, reminder idempotência)"
```

---

## Task 6: Service ai-detect-schedule + hook

**Files:**

- Create: `apps/api/src/services/ai-detect-schedule.ts`
- Modify: `apps/api/src/redis-pub.ts`

- [ ] **Step 1: Criar service de detecção**

Seguir o padrão de `apps/api/src/services/ai-classify.ts` (fetch OpenAI chat). Criar `apps/api/src/services/ai-detect-schedule.ts`:

```typescript
import { env } from '../env.js';
import { logger } from '../logger.js';
import { prisma } from '../db.js';
import { publishEvent } from '../redis-pub.js';

interface DetectResult {
  hasSchedule: boolean;
  suggestedDate?: string; // ISO
  suggestedTitle?: string;
  suggestedType?: 'APPLICATION' | 'MAINTENANCE' | 'REPAIR' | 'SALE_FOLLOWUP' | 'OTHER';
}

/**
 * Analisa o texto inbound do cliente. Se detecta intenção de agendar com data
 * (ex: "aplicação em 15 dias", "manutenção dia 30", "demo na próxima semana"),
 * publica WS calendar.suggestion pro frontend mostrar banner.
 *
 * Fire-and-forget. Falha silenciosa (sem OpenAI key → no-op).
 */
export async function detectSchedule(params: {
  workspaceId: string;
  conversationId: string;
  text: string;
}): Promise<void> {
  if (!env.OPENAI_API_KEY) return;
  const { workspaceId, conversationId, text } = params;
  if (text.trim().length < 8) return; // texto muito curto, skip

  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Hoje é ${today}. Analise a mensagem do cliente e detecte se há intenção de agendar algo com data.

Mensagem: "${text}"

Responda APENAS um JSON válido:
{"hasSchedule": boolean, "suggestedDate": "YYYY-MM-DD" ou null, "suggestedTitle": "titulo curto" ou null, "suggestedType": "APPLICATION"|"MAINTENANCE"|"REPAIR"|"SALE_FOLLOWUP"|"OTHER" ou null}

Se não há data/agendamento claro, hasSchedule=false. Calcule datas relativas ("em 15 dias", "próxima semana") a partir de hoje.`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch(`${env.WHISPER_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.OPENAI_CHAT_MODEL ?? 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 150,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return;

    const parsed = JSON.parse(raw) as DetectResult;
    if (!parsed.hasSchedule || !parsed.suggestedDate) return;

    await publishEvent(workspaceId, 'calendar', 'calendar.suggestion', {
      conversationId,
      suggestedDate: parsed.suggestedDate,
      suggestedTitle: parsed.suggestedTitle ?? 'Evento sugerido',
      suggestedType: parsed.suggestedType ?? 'OTHER',
    });
  } catch (err) {
    logger.debug({ err, conversationId }, 'detectSchedule falhou (ignorado)');
  }
}
```

- [ ] **Step 2: Hook no processamento de message.new INBOUND**

Em `apps/api/src/redis-pub.ts`, localizar onde processa `message.new` (já tem hook de CSAT detection). Adicionar:

```typescript
import { detectSchedule } from './services/ai-detect-schedule.js';

// dentro do bloco `if (event === 'message.new')`, após CSAT detection:
const msg = data.message as
  | { direction?: string; content?: string; conversationId?: string }
  | undefined;
if (msg?.direction === 'INBOUND' && msg.content && msg.conversationId) {
  void detectSchedule({
    workspaceId,
    conversationId: msg.conversationId,
    text: msg.content,
  });
}
```

Adaptar à shape real do payload de `message.new` (verificar como CSAT detection lê o msg).

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @neura/api typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/ai-detect-schedule.ts apps/api/src/redis-pub.ts
git commit -m "feat(api): ai-detect-schedule — detecta data no texto inbound + WS suggestion"
```

---

## Task 7: Página /calendar (vista mensal)

**Files:**

- Create: `apps/web/src/app/(app)/calendar/page.tsx`

- [ ] **Step 1: Criar página com grid de mês**

```typescript
'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';

interface CalEvent {
  id: string;
  title: string;
  eventDate: string;
  type: 'APPLICATION' | 'MAINTENANCE' | 'REPAIR' | 'SALE_FOLLOWUP' | 'OTHER';
  status: 'SCHEDULED' | 'DONE' | 'CANCELLED';
  assignedUser: { id: string; name: string | null } | null;
  contact: { id: string; name: string | null } | null;
}

const TYPE_COLOR: Record<CalEvent['type'], string> = {
  APPLICATION: '#16a34a',
  MAINTENANCE: '#f59e0b',
  REPAIR: '#ef4444',
  SALE_FOLLOWUP: '#3b82f6',
  OTHER: '#71717a',
};

const TYPE_LABEL: Record<CalEvent['type'], string> = {
  APPLICATION: 'Aplicação',
  MAINTENANCE: 'Manutenção',
  REPAIR: 'Reparação',
  SALE_FOLLOWUP: 'Follow-up',
  OTHER: 'Outro',
};

export default function CalendarPage() {
  const [ref, setRef] = useState(() => new Date());
  const year = ref.getFullYear();
  const month = ref.getMonth();

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const from = firstDay.toISOString();
  const to = new Date(year, month + 1, 0, 23, 59, 59).toISOString();

  const { data } = useQuery<{ events: CalEvent[] }>({
    queryKey: ['calendar', year, month],
    queryFn: () => api(`/api/calendar?from=${from}&to=${to}`),
  });

  // Build grid: começa no domingo da semana do dia 1
  const startOffset = firstDay.getDay();
  const daysInMonth = lastDay.getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const eventsByDay = new Map<number, CalEvent[]>();
  (data?.events ?? []).forEach((ev) => {
    const day = new Date(ev.eventDate).getDate();
    const arr = eventsByDay.get(day) ?? [];
    arr.push(ev);
    eventsByDay.set(day, arr);
  });

  const monthName = ref.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const todayDate = new Date();
  const isCurrentMonth = todayDate.getFullYear() === year && todayDate.getMonth() === month;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Calendário</h1>
          <p className="text-muted-foreground">Eventos da equipe — aplicações, manutenções, reparações.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setRef(new Date(year, month - 1, 1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="font-medium capitalize min-w-40 text-center">{monthName}</span>
          <Button variant="outline" size="sm" onClick={() => setRef(new Date(year, month + 1, 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setRef(new Date())}>Hoje</Button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-px bg-border rounded-lg overflow-hidden border">
        {['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((d) => (
          <div key={d} className="bg-card p-2 text-center text-xs font-semibold text-muted-foreground">{d}</div>
        ))}
        {cells.map((day, idx) => {
          const dayEvents = day ? eventsByDay.get(day) ?? [] : [];
          const isToday = isCurrentMonth && day === todayDate.getDate();
          return (
            <div key={idx} className={`bg-card min-h-24 p-1.5 ${day ? '' : 'bg-muted/30'}`}>
              {day && (
                <>
                  <div className={`text-xs font-medium mb-1 ${isToday ? 'inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
                    {day}
                  </div>
                  <div className="space-y-1">
                    {dayEvents.slice(0, 3).map((ev) => (
                      <div
                        key={ev.id}
                        className="text-[10px] rounded px-1 py-0.5 truncate text-white"
                        style={{ backgroundColor: TYPE_COLOR[ev.type], opacity: ev.status === 'DONE' ? 0.5 : 1 }}
                        title={`${TYPE_LABEL[ev.type]}: ${ev.title}${ev.assignedUser?.name ? ' · ' + ev.assignedUser.name : ''}`}
                      >
                        {ev.title}
                      </div>
                    ))}
                    {dayEvents.length > 3 && (
                      <div className="text-[9px] text-muted-foreground">+{dayEvents.length - 3} mais</div>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
./apps/web/node_modules/.bin/tsc -p apps/web --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/\(app\)/calendar/page.tsx
git commit -m "feat(web): página /calendar com vista mensal grid"
```

---

## Task 8: Dialog "Agendar" no side panel

**Files:**

- Create: `apps/web/src/components/calendar/schedule-event-dialog.tsx`
- Modify: `apps/web/src/components/inbox/conversation-side-panel.tsx`

- [ ] **Step 1: Criar dialog**

```typescript
'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { CalendarPlus } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

const schema = z.object({
  title: z.string().min(1).max(200),
  eventDate: z.string().min(1),
  type: z.enum(['APPLICATION', 'MAINTENANCE', 'REPAIR', 'SALE_FOLLOWUP', 'OTHER']),
});
type Input = z.infer<typeof schema>;

interface Props {
  conversationId: string;
  contactId: string;
  defaultDate?: string;
  defaultTitle?: string;
  defaultType?: Input['type'];
  trigger?: React.ReactNode;
  openExternal?: boolean;
  onOpenChange?: (o: boolean) => void;
}

export function ScheduleEventDialog({
  conversationId, contactId, defaultDate, defaultTitle, defaultType, trigger, openExternal, onOpenChange,
}: Props) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openExternal ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [submitting, setSubmitting] = useState(false);
  const qc = useQueryClient();

  const { register, handleSubmit, setValue, watch, reset, formState: { errors } } = useForm<Input>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: defaultTitle ?? '',
      eventDate: defaultDate ?? '',
      type: defaultType ?? 'OTHER',
    },
  });

  async function onSubmit(values: Input) {
    setSubmitting(true);
    try {
      await api('/api/calendar', {
        method: 'POST',
        body: JSON.stringify({
          title: values.title,
          eventDate: new Date(values.eventDate).toISOString(),
          type: values.type,
          conversationId,
          contactId,
        }),
      });
      toast.success('Evento agendado');
      reset();
      setOpen(false);
      qc.invalidateQueries({ queryKey: ['calendar'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao agendar');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarPlus className="h-5 w-5" /> Agendar evento
          </DialogTitle>
          <DialogDescription>Cria um evento no calendário da equipe vinculado a esta conversa.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="title">Título</Label>
            <Input id="title" {...register('title')} placeholder="Ex: Aplicação de produto" />
            {errors.title && <p className="text-xs text-destructive">{errors.title.message}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="eventDate">Data e hora</Label>
            <Input id="eventDate" type="datetime-local" {...register('eventDate')} />
            {errors.eventDate && <p className="text-xs text-destructive">{errors.eventDate.message}</p>}
          </div>
          <div className="space-y-1">
            <Label>Tipo</Label>
            <Select value={watch('type')} onValueChange={(v) => setValue('type', v as Input['type'])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="APPLICATION">Aplicação</SelectItem>
                <SelectItem value="MAINTENANCE">Manutenção</SelectItem>
                <SelectItem value="REPAIR">Reparação</SelectItem>
                <SelectItem value="SALE_FOLLOWUP">Follow-up de venda</SelectItem>
                <SelectItem value="OTHER">Outro</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button type="submit" disabled={submitting}>{submitting ? 'Agendando…' : 'Agendar'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Montar botão no side panel**

Em `apps/web/src/components/inbox/conversation-side-panel.tsx`, na seção de ações (ActionsSection ou perto), adicionar import + botão que abre o dialog:

```typescript
import { ScheduleEventDialog } from '@/components/calendar/schedule-event-dialog';
import { CalendarPlus } from 'lucide-react';

// dentro do JSX do panel, perto das ações:
<ScheduleEventDialog
  conversationId={conversationId}
  contactId={data.contact.id}
  trigger={
    <Button type="button" variant="outline" className="w-full">
      <CalendarPlus className="mr-2 h-4 w-4" /> Agendar evento
    </Button>
  }
/>
```

- [ ] **Step 3: Typecheck + commit**

```bash
./apps/web/node_modules/.bin/tsc -p apps/web --noEmit
git add apps/web/src/components/calendar/schedule-event-dialog.tsx apps/web/src/components/inbox/conversation-side-panel.tsx
git commit -m "feat(web): dialog 'Agendar evento' no side panel do chat"
```

---

## Task 9: Banner sugestão IA no chat

**Files:**

- Create: `apps/web/src/components/calendar/schedule-suggestion-banner.tsx`
- Modify: `apps/web/src/app/(app)/inbox/[id]/page.tsx`

- [ ] **Step 1: Criar banner**

```typescript
'use client';

import { useEffect, useState } from 'react';
import { CalendarClock, X } from 'lucide-react';
import { realtimeClient } from '@/lib/ws-client';
import { Button } from '@/components/ui/button';
import { ScheduleEventDialog } from './schedule-event-dialog';

interface Suggestion {
  conversationId: string;
  suggestedDate: string;
  suggestedTitle: string;
  suggestedType: 'APPLICATION' | 'MAINTENANCE' | 'REPAIR' | 'SALE_FOLLOWUP' | 'OTHER';
}

export function ScheduleSuggestionBanner({
  conversationId,
  contactId,
}: {
  conversationId: string;
  contactId: string;
}) {
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    const unsub = realtimeClient.on((evt) => {
      if (evt.event === 'calendar.suggestion') {
        const p = evt.payload as Suggestion;
        if (p.conversationId === conversationId) {
          setSuggestion(p);
        }
      }
    });
    return unsub;
  }, [conversationId]);

  if (!suggestion) return null;

  // datetime-local format: YYYY-MM-DDTHH:mm — assume 09:00 se só data
  const dateForInput = suggestion.suggestedDate.length === 10
    ? `${suggestion.suggestedDate}T09:00`
    : suggestion.suggestedDate.slice(0, 16);

  return (
    <>
      <div className="flex items-center gap-2 rounded-md border border-violet-300 bg-violet-50 px-3 py-2 text-sm">
        <CalendarClock className="h-4 w-4 text-violet-600 shrink-0" />
        <span className="flex-1 text-violet-900">
          Detectei uma data nessa conversa: <strong>{suggestion.suggestedTitle}</strong> em{' '}
          {new Date(suggestion.suggestedDate).toLocaleDateString('pt-BR')}. Agendar no calendário?
        </span>
        <Button type="button" size="sm" onClick={() => setDialogOpen(true)}>Agendar</Button>
        <button type="button" onClick={() => setSuggestion(null)} className="text-violet-400 hover:text-violet-700">
          <X className="h-4 w-4" />
        </button>
      </div>
      <ScheduleEventDialog
        conversationId={conversationId}
        contactId={contactId}
        defaultDate={dateForInput}
        defaultTitle={suggestion.suggestedTitle}
        defaultType={suggestion.suggestedType}
        openExternal={dialogOpen}
        onOpenChange={(o) => {
          setDialogOpen(o);
          if (!o) setSuggestion(null);
        }}
      />
    </>
  );
}
```

- [ ] **Step 2: Montar no chat page**

Em `apps/web/src/app/(app)/inbox/[id]/page.tsx`, perto do topo da área de mensagens (antes do scroll do timeline), adicionar:

```typescript
import { ScheduleSuggestionBanner } from '@/components/calendar/schedule-suggestion-banner';

// no JSX, acima do timeline scroll container, dentro da coluna do chat:
{conv.contact && (
  <div className="px-4 pt-2">
    <ScheduleSuggestionBanner conversationId={conv.id} contactId={conv.contact.id} />
  </div>
)}
```

Adaptar à estrutura real do chat (usar `conv.id` e `conv.contact.id` que já existem no escopo).

- [ ] **Step 3: Typecheck + commit**

```bash
./apps/web/node_modules/.bin/tsc -p apps/web --noEmit
git add apps/web/src/components/calendar/schedule-suggestion-banner.tsx apps/web/src/app/\(app\)/inbox/\[id\]/page.tsx
git commit -m "feat(web): banner de sugestão IA pra agendar evento no chat"
```

---

## Task 10: Sidebar nav + build final

**Files:**

- Modify: `apps/web/src/components/layout/sidebar.tsx`

- [ ] **Step 1: Adicionar link Calendário**

Em `sidebar.tsx`, no grupo "Operação" (junto com Conversas e Kanban), adicionar:

```typescript
{ href: '/calendar', label: 'Calendário', icon: CalendarDays },
```

E importar `CalendarDays` de lucide-react.

- [ ] **Step 2: Build full**

```bash
export PATH="$HOME/.node22-portable/node-v22.13.1-win-x64:$PATH"
pnpm build
```

Expected: PASS 5/5.

- [ ] **Step 3: Tests**

```bash
DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5435/neura_ai' \
REDIS_URL='redis://127.0.0.1:6379' \
pnpm --filter @neura/api test
```

Expected: PASS — 42 anteriores + 4 calendar = 46.

- [ ] **Step 4: Typecheck full + commit**

```bash
pnpm typecheck
git add apps/web/src/components/layout/sidebar.tsx
git commit -m "feat(web): sidebar link Calendário + build final"
```

---

## Critérios de Aceite

- [ ] `pnpm build` PASS
- [ ] `pnpm test` PASS — 46 testes verde
- [ ] Página `/calendar` mostra grid mensal com eventos coloridos por tipo
- [ ] Botão "Agendar evento" no side panel cria evento vinculado à conversa
- [ ] Quando IA detecta data no texto do cliente → banner aparece no chat → click "Agendar" pré-preenche o dialog
- [ ] Scheduler dispara notificação in-app quando eventDate chega (reminderSentAt idempotente)
- [ ] Evento sem responsável → notifica todos os members; com responsável → só ele
- [ ] Sidebar tem link "Calendário"

## Follow-ups possíveis (fora deste plano)

- Vista semanal/diária além da mensal
- Recordatorio anticipado (X dias antes)
- Discord/email além de in-app
- Sync Google Calendar
- Extração automática completa de atributos (não só fecha) — feature separada
