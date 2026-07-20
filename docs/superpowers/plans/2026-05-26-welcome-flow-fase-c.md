# Welcome Flow Fase C — Lead Detail Panel + Chat Timeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refatorar `conversation-side-panel.tsx` no estilo Kommo (header com SLA badge, embudo inline, custom attrs editáveis, labels toggle, contact editable, resumo IA, ações), e enriquecer o chat com separadores de dia, badge AI_AGENT, e marker "lido até aqui".

**Architecture:** Endpoint consolidado `GET /api/conversations/:id/lead-detail` retorna em uma query: contact + custom attribute defs + values + labels + card atual + funnel/stage + summary IA + welcome state. Frontend usa react-query com mutations optimistas + invalidate, secciones colapsables com shadcn `Collapsible` (instalar). Chat usa `timeline` array existente, agrupa por dia via helper render, sem reescrever loop.

**Tech Stack:** Hono 4 + Prisma 6 + Zod (api), Next.js 15 + react-hook-form + react-query + shadcn/ui + sonner (web). Vitest pra tests.

**Spec base:** `docs/superpowers/specs/2026-05-26-welcome-flow-autorouting-design.md` (Fases C+D sections).
**Fase B:** completa em branch `feat/welcome-flow-fase-b` (PR #2). Esta branch (`feat/welcome-flow-fase-c`) stacked em cima de followups (PR #3).

---

## File Structure

### API

- Create: `apps/api/src/routes/lead-detail.ts` — `GET /api/conversations/:id/lead-detail` (consolidated query)
- Modify: `apps/api/src/routes/conversations.ts` — adicionar `PATCH /api/conversations/:id/contact` (update Contact básicos + customAttrs)
- Modify: `apps/api/src/index.ts` — wire `leadDetailRouter`

### Web

- Modify: `apps/web/src/components/inbox/conversation-side-panel.tsx` — refactor completo (substitui o existente, pattern Kommo)
- Create: `apps/web/src/components/inbox/sla-badge.tsx` — pill CALIENTE/TIBIO/FRIO derivado do SLA
- Create: `apps/web/src/components/inbox/lead-section-collapsible.tsx` — wrapper UI pra seções recolhíveis
- Modify: `apps/web/src/app/(app)/inbox/[id]/page.tsx` — day separators no timeline + AI_AGENT badge + "lido até aqui" marker

### shadcn components a instalar

- `collapsible` — pra seções dobráveis

---

## Task 1: Install shadcn `collapsible`

**Files:**

- Auto-created: `apps/web/src/components/ui/collapsible.tsx`

- [ ] **Step 1: Add component**

```bash
cd apps/web && pnpm dlx shadcn@latest add collapsible
```

Expected: file created + `@radix-ui/react-collapsible` added to deps.

- [ ] **Step 2: Typecheck**

```bash
cd /c/Users/ASUS/OneDrive/Escritorio/Project/neura-ai
./apps/web/node_modules/.bin/tsc -p apps/web --noEmit
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/collapsible.tsx apps/web/package.json apps/web/pnpm-lock.yaml 2>/dev/null || git add apps/web/
git commit -m "chore(web): adiciona shadcn collapsible para seções do lead detail"
```

---

## Task 2: Endpoint `GET /api/conversations/:id/lead-detail`

**Files:**

- Create: `apps/api/src/routes/lead-detail.ts`
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Criar route**

Create `apps/api/src/routes/lead-detail.ts`:

```typescript
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
 * - Status + SLA derivado (lastInboundAt vs lastOutboundAt — calc em ms)
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
      orderBy: { displayOrder: 'asc' },
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

  // SLA "temperatura": minutos desde último inbound se status=OPEN + sem outbound posterior
  // CALIENTE: <15min  TIBIO: 15-60min  FRIO: >60min ou resolved
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
```

- [ ] **Step 2: Wire em index.ts**

Em `apps/api/src/index.ts`, junto com outros app.route:

```typescript
import { leadDetailRouter } from './routes/lead-detail.js';
// ...
app.route('/api', leadDetailRouter);
```

- [ ] **Step 3: Typecheck**

```bash
export PATH="$HOME/.node22-portable/node-v22.13.1-win-x64:$PATH"
pnpm --filter @neura/api typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/lead-detail.ts apps/api/src/index.ts
git commit -m "feat(api): endpoint /api/conversations/:id/lead-detail consolidado"
```

---

## Task 3: Endpoint `PATCH /api/conversations/:id/contact`

**Files:**

- Modify: `apps/api/src/routes/conversations.ts`

- [ ] **Step 1: Adicionar handler**

Em `apps/api/src/routes/conversations.ts`, no final do arquivo antes do export ou junto dos outros PATCH:

```typescript
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
        customAttrs: parsed.data.customAttrs ?? undefined,
      }),
    },
  });

  await publishEvent(workspaceId, 'contacts', 'contact.updated', {
    contactId: updated.id,
    changes: parsed.data,
  });

  return c.json({ contact: updated });
});
```

Imports no topo (se ainda não estão):

```typescript
import { z } from 'zod';
import { publishEvent } from '../redis-pub.js';
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @neura/api typecheck
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/conversations.ts
git commit -m "feat(api): PATCH /api/conversations/:id/contact (inline contact edit)"
```

---

## Task 4: Side panel — refactor completo (header + SLA badge)

**Files:**

- Create: `apps/web/src/components/inbox/sla-badge.tsx`
- Modify: `apps/web/src/components/inbox/conversation-side-panel.tsx` (rewrite)

This task replaces the existing 343-line side panel with a new structure. The new version uses the consolidated `lead-detail` endpoint and adds sections as separate sub-components within the same file (or as standalone components if growing).

- [ ] **Step 1: SLA badge component**

Create `apps/web/src/components/inbox/sla-badge.tsx`:

```typescript
import { Flame, Thermometer, Snowflake } from 'lucide-react';

type Temperature = 'CALIENTE' | 'TIBIO' | 'FRIO';

const CONFIG: Record<Temperature, { label: string; bg: string; text: string; Icon: typeof Flame }> = {
  CALIENTE: { label: 'CALIENTE', bg: 'bg-red-100', text: 'text-red-700', Icon: Flame },
  TIBIO: { label: 'TIBIO', bg: 'bg-amber-100', text: 'text-amber-800', Icon: Thermometer },
  FRIO: { label: 'FRIO', bg: 'bg-slate-100', text: 'text-slate-600', Icon: Snowflake },
};

export function SlaBadge({ temperature }: { temperature: Temperature }) {
  const cfg = CONFIG[temperature];
  const Icon = cfg.Icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${cfg.bg} ${cfg.text}`}
    >
      <Icon className="h-3 w-3" />
      {cfg.label}
    </span>
  );
}
```

- [ ] **Step 2: Rewrite side panel — header**

Replace `apps/web/src/components/inbox/conversation-side-panel.tsx` entirely with the new version. Start with header + structure (sections will fill in subsequent tasks):

```typescript
'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, Phone, Mail } from 'lucide-react';
import { api } from '@/lib/api';
import { SlaBadge } from './sla-badge';

interface LeadDetail {
  conversation: {
    id: string;
    status: string;
    assignedAgentId: string | null;
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
    aiSummary: string | null;
    aiSummaryAt: string | null;
    isAwaitingWelcomeChoice: boolean;
    welcomeAttempts: number;
    welcomeFallbackSent: boolean;
    inbox: { id: string; name: string };
    labels: Array<{ id: string; name: string; color: string }>;
  };
  contact: {
    id: string;
    name: string | null;
    phoneNumber: string;
    email: string | null;
    avatarUrl: string | null;
    customAttrs: Record<string, unknown> | null;
    welcomeRespondedAt: string | null;
    labels: Array<{ label: { id: string; name: string; color: string } }>;
  };
  card: {
    id: string;
    title: string;
    value: string | null;
    funnel: { id: string; name: string };
    stage: { id: string; name: string; color: string; outcome: 'POSITIVE' | 'NEGATIVE' | 'RISK' | null };
    products: Array<{ id: string; name: string; price: string | null; quantity: number }>;
  } | null;
  customAttributeDefs: Array<{
    id: string;
    key: string;
    label: string;
    type: 'STRING' | 'NUMBER' | 'DATE' | 'SELECT';
    options: string[] | null;
  }>;
  allLabels: Array<{ id: string; name: string; color: string; scope: string }>;
  funnels: Array<{ id: string; name: string; stages: Array<{ id: string; name: string; order: number }> }>;
  temperature: 'CALIENTE' | 'TIBIO' | 'FRIO';
}

function initialsFrom(s: string | null | undefined): string {
  if (!s) return '?';
  return s.split(/[\s.@]/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('');
}

export function ConversationSidePanel({ conversationId }: { conversationId: string }) {
  const { data, isLoading } = useQuery<LeadDetail>({
    queryKey: ['lead-detail', conversationId],
    queryFn: () => api(`/api/conversations/${conversationId}/lead-detail`),
    enabled: !!conversationId,
  });

  if (isLoading) {
    return (
      <aside className="w-80 shrink-0 border-l bg-card/30 p-4">
        <div className="space-y-3 animate-pulse">
          <div className="h-12 w-12 rounded-full bg-muted" />
          <div className="h-4 w-32 rounded bg-muted" />
          <div className="h-3 w-24 rounded bg-muted" />
        </div>
      </aside>
    );
  }
  if (!data) return null;

  const { contact, conversation, temperature } = data;
  const title = contact.name ?? contact.phoneNumber;

  return (
    <aside className="w-80 shrink-0 border-l bg-card/30 overflow-y-auto">
      <div className="space-y-4 p-4">
        {/* Header */}
        <section>
          <div className="flex items-start gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-slate-200 to-slate-300 text-sm font-semibold text-slate-700">
              {initialsFrom(title)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{title}</p>
              <a
                href={`tel:${contact.phoneNumber}`}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Phone className="h-3 w-3" />
                {contact.phoneNumber}
              </a>
              {contact.email && (
                <a
                  href={`mailto:${contact.email}`}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  <Mail className="h-3 w-3" />
                  {contact.email}
                </a>
              )}
              <div className="mt-1.5">
                <SlaBadge temperature={temperature} />
              </div>
            </div>
          </div>
        </section>

        {/* Sections (preenchidas nas próximas tasks) */}
        {/* TASK 5: Embudo */}
        {/* TASK 6: Custom attributes */}
        {/* TASK 7: Labels */}
        {/* TASK 8: Contact info editable */}
        {/* TASK 9: AI summary + actions */}
      </div>
    </aside>
  );
}
```

- [ ] **Step 3: Update caller signature**

In `apps/web/src/app/(app)/inbox/[id]/page.tsx`, find where `<ConversationSidePanel ... />` is mounted. Change props from `{ contactId, currentConversationId }` to `{ conversationId }`:

```typescript
<ConversationSidePanel conversationId={conversationId} />
```

(`conversationId` is the `id` from useParams in the page.)

- [ ] **Step 4: Typecheck**

```bash
./apps/web/node_modules/.bin/tsc -p apps/web --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/inbox/sla-badge.tsx apps/web/src/components/inbox/conversation-side-panel.tsx apps/web/src/app/\(app\)/inbox/\[id\]/page.tsx
git commit -m "feat(web): refactor side panel — header + SLA badge + lead-detail endpoint"
```

---

## Task 5: Side panel — seção Embudo (funnel + stage selector inline)

**Files:**

- Modify: `apps/web/src/components/inbox/conversation-side-panel.tsx`

- [ ] **Step 1: Adicionar seção Embudo**

Após o header `<section>` no side panel, adicionar antes do comentário `{/* TASK 6 */}`:

```typescript
{data.card && (
  <section className="rounded-md border bg-card p-3 space-y-2">
    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      Embudo
    </p>
    <p className="text-sm font-medium">{data.card.funnel.name}</p>
    <select
      className="w-full rounded border bg-background px-2 py-1.5 text-sm"
      value={data.card.stage.id}
      onChange={(e) => moveStageMut.mutate(e.target.value)}
      disabled={moveStageMut.isPending}
    >
      {(data.funnels.find((f) => f.id === data.card!.funnel.id)?.stages ?? []).map((s) => (
        <option key={s.id} value={s.id}>{s.name}</option>
      ))}
    </select>
    {data.card.value && (
      <p className="text-xs text-muted-foreground">
        Valor: <span className="font-medium text-foreground">{data.card.value}</span>
      </p>
    )}
  </section>
)}
```

- [ ] **Step 2: Adicionar mutation pra mover stage**

No topo do componente, junto com a query:

```typescript
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
// ...
const qc = useQueryClient();
const moveStageMut = useMutation({
  mutationFn: (stageId: string) =>
    api(`/api/kanban/cards/${data?.card?.id}/move`, {
      method: 'POST',
      body: JSON.stringify({ stageId }),
    }),
  onSuccess: () => {
    toast.success('Etapa atualizada');
    qc.invalidateQueries({ queryKey: ['lead-detail', conversationId] });
  },
  onError: (err) => toast.error(err instanceof Error ? err.message : 'Erro ao mover'),
});
```

**Verify:** Endpoint `POST /api/kanban/cards/:id/move` should exist (it's used by the kanban drag-drop). If the method/path is different, find the actual one in `apps/api/src/routes/kanban.ts` and adapt.

- [ ] **Step 3: Typecheck**

```bash
./apps/web/node_modules/.bin/tsc -p apps/web --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/inbox/conversation-side-panel.tsx
git commit -m "feat(web): side panel — seção Embudo com stage selector inline"
```

---

## Task 6: Side panel — seção Atributos custom

**Files:**

- Modify: `apps/web/src/components/inbox/conversation-side-panel.tsx`

- [ ] **Step 1: Implementar sección**

Após a seção Embudo, antes do comentário `{/* TASK 7 */}`:

```typescript
{data.customAttributeDefs.length > 0 && (
  <CustomAttrsSection
    defs={data.customAttributeDefs}
    values={data.contact.customAttrs ?? {}}
    conversationId={conversationId}
  />
)}
```

E adicionar o componente no mesmo arquivo (abaixo do `ConversationSidePanel`):

```typescript
interface CustomAttrsSectionProps {
  defs: LeadDetail['customAttributeDefs'];
  values: Record<string, unknown>;
  conversationId: string;
}

function CustomAttrsSection({ defs, values, conversationId }: CustomAttrsSectionProps) {
  const qc = useQueryClient();
  const [local, setLocal] = useState<Record<string, unknown>>(values);

  const saveMut = useMutation({
    mutationFn: (next: Record<string, unknown>) =>
      api(`/api/conversations/${conversationId}/contact`, {
        method: 'PATCH',
        body: JSON.stringify({ customAttrs: next }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lead-detail', conversationId] }),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Erro ao salvar atributo'),
  });

  function updateField(key: string, value: unknown) {
    const next = { ...local, [key]: value };
    setLocal(next);
    saveMut.mutate(next);
  }

  return (
    <section className="rounded-md border bg-card p-3 space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Atributos
      </p>
      {defs.map((def) => {
        const current = local[def.key];
        if (def.type === 'SELECT' && def.options) {
          return (
            <div key={def.id} className="space-y-1">
              <label className="text-xs">{def.label}</label>
              <select
                className="w-full rounded border bg-background px-2 py-1 text-sm"
                value={typeof current === 'string' ? current : ''}
                onChange={(e) => updateField(def.key, e.target.value || null)}
              >
                <option value="">—</option>
                {def.options.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </div>
          );
        }
        if (def.type === 'NUMBER') {
          return (
            <div key={def.id} className="space-y-1">
              <label className="text-xs">{def.label}</label>
              <input
                type="number"
                className="w-full rounded border bg-background px-2 py-1 text-sm"
                value={typeof current === 'number' ? current : ''}
                onChange={(e) => updateField(def.key, e.target.value ? Number(e.target.value) : null)}
              />
            </div>
          );
        }
        if (def.type === 'DATE') {
          return (
            <div key={def.id} className="space-y-1">
              <label className="text-xs">{def.label}</label>
              <input
                type="date"
                className="w-full rounded border bg-background px-2 py-1 text-sm"
                value={typeof current === 'string' ? current : ''}
                onChange={(e) => updateField(def.key, e.target.value || null)}
              />
            </div>
          );
        }
        // STRING
        return (
          <div key={def.id} className="space-y-1">
            <label className="text-xs">{def.label}</label>
            <input
              type="text"
              className="w-full rounded border bg-background px-2 py-1 text-sm"
              value={typeof current === 'string' ? current : ''}
              onChange={(e) => updateField(def.key, e.target.value || null)}
              onBlur={() => saveMut.mutate(local)}
            />
          </div>
        );
      })}
    </section>
  );
}
```

Add `useState` to imports if missing:

```typescript
import { useState } from 'react';
```

- [ ] **Step 2: Typecheck + commit**

```bash
./apps/web/node_modules/.bin/tsc -p apps/web --noEmit
git add apps/web/src/components/inbox/conversation-side-panel.tsx
git commit -m "feat(web): side panel — seção Atributos custom editável inline"
```

---

## Task 7: Side panel — seção Etiquetas (chip toggle)

**Files:**

- Modify: `apps/web/src/components/inbox/conversation-side-panel.tsx`

- [ ] **Step 1: Implementar seção**

Após `{/* TASK 7 */}`:

```typescript
<LabelsSection
  applied={data.conversation.labels}
  available={data.allLabels.filter((l) => l.scope === 'CONVERSATION' || l.scope === 'BOTH')}
  conversationId={conversationId}
/>
```

Componente abaixo:

```typescript
interface LabelsSectionProps {
  applied: Array<{ id: string; name: string; color: string }>;
  available: LeadDetail['allLabels'];
  conversationId: string;
}

function LabelsSection({ applied, available, conversationId }: LabelsSectionProps) {
  const qc = useQueryClient();
  const appliedIds = new Set(applied.map((l) => l.id));

  const toggleMut = useMutation({
    mutationFn: async ({ labelId, action }: { labelId: string; action: 'add' | 'remove' }) => {
      if (action === 'add') {
        return api(`/api/conversations/${conversationId}/labels`, {
          method: 'POST',
          body: JSON.stringify({ labelId }),
        });
      }
      return api(`/api/conversations/${conversationId}/labels/${labelId}`, { method: 'DELETE' });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lead-detail', conversationId] }),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Erro'),
  });

  return (
    <section className="rounded-md border bg-card p-3 space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Etiquetas
      </p>
      <div className="flex flex-wrap gap-1.5">
        {available.map((l) => {
          const isApplied = appliedIds.has(l.id);
          return (
            <button
              key={l.id}
              type="button"
              onClick={() =>
                toggleMut.mutate({ labelId: l.id, action: isApplied ? 'remove' : 'add' })
              }
              disabled={toggleMut.isPending}
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs transition-colors ${
                isApplied
                  ? 'border border-transparent text-white'
                  : 'border border-dashed text-muted-foreground hover:border-foreground hover:text-foreground'
              }`}
              style={isApplied ? { backgroundColor: l.color } : undefined}
            >
              {l.name}
            </button>
          );
        })}
        {available.length === 0 && (
          <p className="text-xs text-muted-foreground">Nenhuma etiqueta. Crie em Configurações → Etiquetas.</p>
        )}
      </div>
    </section>
  );
}
```

**Verify:** Endpoints `POST /api/conversations/:id/labels` + `DELETE /api/conversations/:id/labels/:labelId` exist. Look in `apps/api/src/routes/conversations.ts` or similar. If different, adapt.

- [ ] **Step 2: Typecheck + commit**

```bash
./apps/web/node_modules/.bin/tsc -p apps/web --noEmit
git add apps/web/src/components/inbox/conversation-side-panel.tsx
git commit -m "feat(web): side panel — seção Etiquetas com toggle inline"
```

---

## Task 8: Side panel — seção Contato editável

**Files:**

- Modify: `apps/web/src/components/inbox/conversation-side-panel.tsx`

- [ ] **Step 1: Implementar seção**

Após `{/* TASK 8 */}`:

```typescript
<ContactInfoSection contact={data.contact} conversationId={conversationId} />
```

Componente:

```typescript
function ContactInfoSection({
  contact,
  conversationId,
}: {
  contact: LeadDetail['contact'];
  conversationId: string;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(contact.name ?? '');
  const [email, setEmail] = useState(contact.email ?? '');

  const saveMut = useMutation({
    mutationFn: (patch: { name?: string | null; email?: string | null }) =>
      api(`/api/conversations/${conversationId}/contact`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lead-detail', conversationId] }),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Erro'),
  });

  return (
    <section className="rounded-md border bg-card p-3 space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Contato
      </p>
      <div className="space-y-1">
        <label className="text-xs">Nome</label>
        <input
          type="text"
          className="w-full rounded border bg-background px-2 py-1 text-sm"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== (contact.name ?? '') && saveMut.mutate({ name: name || null })}
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs">Email</label>
        <input
          type="email"
          className="w-full rounded border bg-background px-2 py-1 text-sm"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={() => email !== (contact.email ?? '') && saveMut.mutate({ email: email || null })}
        />
      </div>
      <p className="text-[10px] text-muted-foreground">
        Telefone: {contact.phoneNumber} (não editável)
      </p>
    </section>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
./apps/web/node_modules/.bin/tsc -p apps/web --noEmit
git add apps/web/src/components/inbox/conversation-side-panel.tsx
git commit -m "feat(web): side panel — seção Contato com edição inline de nome+email"
```

---

## Task 9: Side panel — Resumo IA + ações inferiores

**Files:**

- Modify: `apps/web/src/components/inbox/conversation-side-panel.tsx`

- [ ] **Step 1: Implementar seção AI summary + ações**

Após `{/* TASK 9 */}`:

```typescript
<AiSummarySection conversation={data.conversation} conversationId={conversationId} />
<ActionsSection conversation={data.conversation} conversationId={conversationId} />
```

Componentes:

```typescript
function AiSummarySection({
  conversation,
  conversationId,
}: {
  conversation: LeadDetail['conversation'];
  conversationId: string;
}) {
  const qc = useQueryClient();
  const summarizeMut = useMutation({
    mutationFn: () =>
      api(`/api/conversations/${conversationId}/ai/summarize`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lead-detail', conversationId] });
      toast.success('Resumo gerado');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Erro IA'),
  });

  return (
    <section className="rounded-md border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Resumo IA
        </p>
        <button
          type="button"
          onClick={() => summarizeMut.mutate()}
          disabled={summarizeMut.isPending}
          className="text-xs text-primary hover:underline disabled:opacity-50"
        >
          {summarizeMut.isPending ? 'Gerando…' : conversation.aiSummary ? 'Atualizar' : 'Gerar'}
        </button>
      </div>
      {conversation.aiSummary ? (
        <p className="text-xs text-muted-foreground whitespace-pre-wrap">{conversation.aiSummary}</p>
      ) : (
        <p className="text-xs text-muted-foreground italic">Nenhum resumo ainda.</p>
      )}
    </section>
  );
}

function ActionsSection({
  conversation,
  conversationId,
}: {
  conversation: LeadDetail['conversation'];
  conversationId: string;
}) {
  const qc = useQueryClient();
  const updateMut = useMutation({
    mutationFn: (status: 'OPEN' | 'RESOLVED' | 'PENDING') =>
      api(`/api/conversations/${conversationId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lead-detail', conversationId] });
      toast.success('Status atualizado');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Erro'),
  });

  return (
    <section className="rounded-md border bg-card p-3 space-y-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Ações
      </p>
      {conversation.status !== 'RESOLVED' && (
        <button
          type="button"
          onClick={() => updateMut.mutate('RESOLVED')}
          disabled={updateMut.isPending}
          className="w-full rounded bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          Marcar como resolvida
        </button>
      )}
      {conversation.status === 'RESOLVED' && (
        <button
          type="button"
          onClick={() => updateMut.mutate('OPEN')}
          disabled={updateMut.isPending}
          className="w-full rounded border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
        >
          Reabrir
        </button>
      )}
    </section>
  );
}
```

**Verify endpoint:** `POST /api/conversations/:id/ai/summarize` exists. The grep earlier confirmed line 685 references it. Confirm the path/method.

- [ ] **Step 2: Typecheck + commit**

```bash
./apps/web/node_modules/.bin/tsc -p apps/web --noEmit
git add apps/web/src/components/inbox/conversation-side-panel.tsx
git commit -m "feat(web): side panel — resumo IA + ações de status"
```

---

## Task 10: Side panel — real-time WS subscriptions

**Files:**

- Modify: `apps/web/src/components/inbox/conversation-side-panel.tsx`

- [ ] **Step 1: Subscribe a eventos WS pra invalidar lead-detail**

No topo do componente, junto com a query:

```typescript
import { useEffect } from 'react';
import { useRealtimeStore } from '@/lib/realtime-store';
// ...

const ws = useRealtimeStore((s) => s.lastEvent);
useEffect(() => {
  if (!ws) return;
  const eventsToWatch = [
    'contact.updated',
    'conversation.label_applied',
    'conversation.label_removed',
    'card.moved',
    'card.updated',
    'conversation.status_changed',
    'welcome.completed',
    'welcome.failed',
  ];
  if (eventsToWatch.includes(ws.event)) {
    qc.invalidateQueries({ queryKey: ['lead-detail', conversationId] });
  }
}, [ws, conversationId, qc]);
```

**Note:** Adapt to actual realtime store shape. Look at `apps/web/src/lib/realtime-store.ts` if `lastEvent` is not the actual selector. The store may expose `subscribe(channel, handler)` or `useEvent('event.name', handler)`.

- [ ] **Step 2: Typecheck + commit**

```bash
./apps/web/node_modules/.bin/tsc -p apps/web --noEmit
git add apps/web/src/components/inbox/conversation-side-panel.tsx
git commit -m "feat(web): side panel — invalidate lead-detail em WS events"
```

---

## Task 11: Chat — separadores de dia

**Files:**

- Modify: `apps/web/src/app/(app)/inbox/[id]/page.tsx`

- [ ] **Step 1: Adicionar helper de grouping**

Próximo do `timeline` useMemo (~line 1030), adicionar uma transformação:

```typescript
import { format, isSameDay, isToday, isYesterday } from 'date-fns';
import { ptBR } from 'date-fns/locale';

// Group timeline items by day for rendering day separators.
function dayLabel(d: Date): string {
  if (isToday(d)) return 'Hoje';
  if (isYesterday(d)) return 'Ontem';
  // ex: "Segunda, 15 de maio"
  return format(d, "EEEE, dd 'de' MMMM", { locale: ptBR });
}
```

If `date-fns` is not installed, install it:

```bash
cd apps/web && pnpm add date-fns
```

(date-fns is usually in Next.js projects; check `package.json` first.)

- [ ] **Step 2: Render day separators no map do timeline**

Localizar `{timeline.map((item) =>` (~line 1508). Envolver com lógica de tracking de dia atual:

```typescript
{(() => {
  let lastDay: string | null = null;
  return timeline.map((item) => {
    const itemDate = new Date(item.createdAt);
    const dayKey = format(itemDate, 'yyyy-MM-dd');
    const showSeparator = dayKey !== lastDay;
    lastDay = dayKey;
    return (
      <div key={item.id}>
        {showSeparator && (
          <div className="flex items-center justify-center py-3">
            <span className="rounded-full bg-muted px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {dayLabel(itemDate)}
            </span>
          </div>
        )}
        {/* ...existing item render ...*/}
      </div>
    );
  });
})()}
```

**Adapt to actual code structure**: the existing `{timeline.map((item) => ...)` likely has a complex JSX body. Wrap the existing body inside the new `<div key={item.id}>` along with the separator. The IIFE approach above maintains the `lastDay` state across iterations.

- [ ] **Step 3: Typecheck + commit**

```bash
./apps/web/node_modules/.bin/tsc -p apps/web --noEmit
git add apps/web/src/app/\(app\)/inbox/\[id\]/page.tsx apps/web/package.json apps/web/pnpm-lock.yaml 2>/dev/null || git add apps/web/
git commit -m "feat(web): chat timeline — separadores de dia (Hoje/Ontem/EEEE dd 'de' MMMM)"
```

---

## Task 12: Chat — badge AI_AGENT no MessageItem

**Files:**

- Modify: `apps/web/src/app/(app)/inbox/[id]/page.tsx`

- [ ] **Step 1: Estender MessageItem type**

Encontrar `interface MessageItem` (~line 127) e adicionar:

```typescript
interface MessageItem {
  // ...campos existentes
  senderType: 'CUSTOMER' | 'AGENT' | 'AI_AGENT' | 'SYSTEM';
}
```

- [ ] **Step 2: Renderizar badge condicional**

No render do message bubble (procurar pelo OUTBOUND/INBOUND switch), adicionar acima do conteúdo:

```typescript
{msg.kind === 'msg' && msg.senderType === 'AI_AGENT' && (
  <div className="mb-1 inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700">
    <Sparkles className="h-2.5 w-2.5" />
    Agente IA
  </div>
)}
```

Adicionar import:

```typescript
import { Sparkles } from 'lucide-react';
```

(If `Sparkles` doesn't exist in your lucide-react version, use `Bot` instead — already imported.)

- [ ] **Step 3: Typecheck + commit**

```bash
./apps/web/node_modules/.bin/tsc -p apps/web --noEmit
git add apps/web/src/app/\(app\)/inbox/\[id\]/page.tsx
git commit -m "feat(web): chat — badge 'Agente IA' nas mensagens com senderType=AI_AGENT"
```

---

## Task 13: Chat — "Lido até aqui" marker + scroll-to-bottom button

**Files:**

- Modify: `apps/web/src/app/(app)/inbox/[id]/page.tsx`

- [ ] **Step 1: Track última msg lida ao abrir conversa**

No topo do componente, próximo dos outros useState:

```typescript
const [readUpToTs, setReadUpToTs] = useState<number | null>(null);

useEffect(() => {
  // Quando a conversa carrega, marca a última msg INBOUND como "lido até aqui"
  if (!data?.conversation.messages) return;
  const lastInbound = [...data.conversation.messages]
    .reverse()
    .find((m) => m.direction === 'INBOUND');
  if (lastInbound && readUpToTs === null) {
    setReadUpToTs(new Date(lastInbound.createdAt).getTime());
  }
}, [data?.conversation.id]); // só dispara quando muda de conversa
```

- [ ] **Step 2: Render marker entre msgs**

No render do timeline (após o day separator), adicionar lógica:

```typescript
// Dentro do map, antes do bubble:
{
  readUpToTs !== null &&
    new Date(item.createdAt).getTime() > readUpToTs &&
    /* prev item já passou — só render uma vez */
    (() => {
      // implementar via ref ou comparar com previousItem se disponível.
      return null;
    })();
}
```

**Better approach — render marker via IIFE com tracker:**

```typescript
{(() => {
  let lastDay: string | null = null;
  let markerShown = false;
  return timeline.map((item) => {
    const itemDate = new Date(item.createdAt);
    const dayKey = format(itemDate, 'yyyy-MM-dd');
    const showSeparator = dayKey !== lastDay;
    lastDay = dayKey;
    const showReadMarker =
      readUpToTs !== null && !markerShown && itemDate.getTime() > readUpToTs;
    if (showReadMarker) markerShown = true;
    return (
      <div key={item.id}>
        {showSeparator && (/* day separator */)}
        {showReadMarker && (
          <div className="flex items-center gap-2 py-2">
            <div className="h-px flex-1 bg-primary" />
            <span className="text-[10px] font-medium uppercase tracking-wider text-primary">
              Novas mensagens
            </span>
            <div className="h-px flex-1 bg-primary" />
          </div>
        )}
        {/* existing render */}
      </div>
    );
  });
})()}
```

- [ ] **Step 3: Scroll-to-bottom button**

Adicionar próximo ao container do chat:

```typescript
const [showScrollDown, setShowScrollDown] = useState(false);
const scrollRef = useRef<HTMLDivElement>(null);

function checkScroll() {
  const el = scrollRef.current;
  if (!el) return;
  const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  setShowScrollDown(distFromBottom > 200);
}

function scrollToBottom() {
  scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
}

// No container do scroll: ref={scrollRef} onScroll={checkScroll}
// Renderizar próximo ao input area:
{showScrollDown && (
  <button
    type="button"
    onClick={scrollToBottom}
    className="absolute bottom-24 right-6 rounded-full border bg-card p-2 shadow-lg hover:bg-accent"
    aria-label="Ir para última mensagem"
  >
    <ChevronDown className="h-4 w-4" />
  </button>
)}
```

Add `ChevronDown` import if not already (likely is). And `useRef` if not.

- [ ] **Step 4: Typecheck + commit**

```bash
./apps/web/node_modules/.bin/tsc -p apps/web --noEmit
git add apps/web/src/app/\(app\)/inbox/\[id\]/page.tsx
git commit -m "feat(web): chat — marker 'lido até aqui' + botão scroll-to-bottom"
```

---

## Task 14: Build final + smoke

**Files:** nenhum (só validação)

- [ ] **Step 1: Build full**

```bash
export PATH="$HOME/.node22-portable/node-v22.13.1-win-x64:$PATH"
pnpm build
```

Expected: PASS em 5/5 packages.

- [ ] **Step 2: Lint + typecheck**

```bash
pnpm lint
pnpm typecheck
```

- [ ] **Step 3: Tests**

```bash
DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5435/neura_ai' \
REDIS_URL='redis://127.0.0.1:6379' \
pnpm --filter @neura/api test
```

Expected: PASS (suíte da Fase A+B+followups).

- [ ] **Step 4: Smoke manual (opcional)**

Se ambiente dev disponível:

1. `pnpm dev`
2. Browser → login → abrir conversa do inbox
3. Side panel: ver header com SLA badge, embudo, atributos, etiquetas, contato, resumo IA, ações
4. Editar nome do contato inline → blur → salva
5. Click numa etiqueta → toggle add/remove
6. Mudar stage no dropdown → kanban atualiza
7. Chat: ver separadores de dia, badge "Agente IA" em mensagens do bot
8. Scroll up → ver botão flutuante de ir ao fim

- [ ] **Step 5: Commit final se necessário**

```bash
git add -A
git commit -m "chore(welcome-flow-fase-c): ajustes finais lint/typecheck"
```

---

## Critérios de Aceite — Fase C

- [ ] `pnpm build` PASS em todos os packages
- [ ] `pnpm typecheck` PASS
- [ ] Side panel mostra header com SLA temperature badge
- [ ] Seção Embudo permite mover stage sem abrir kanban
- [ ] Atributos custom editáveis inline com auto-save
- [ ] Etiquetas: chip click toggle add/remove
- [ ] Contato: nome + email editáveis inline
- [ ] Resumo IA: botão gerar/atualizar funcional
- [ ] Ações: marcar resolvida + reabrir
- [ ] WS subscription invalida lead-detail em mudanças relevantes
- [ ] Chat: separadores de dia visíveis (Hoje/Ontem/data)
- [ ] Mensagens do bot têm badge "Agente IA"
- [ ] Marker "Novas mensagens" aparece na primeira não-lida
- [ ] Botão scroll-to-bottom aparece quando scroll está fora do fundo

## Próximas fases

- **Fase D**: Wizard de onboarding ao criar inbox + presets por tipo de negócio
- Follow-ups gerais do produto (não-welcome-flow): backlog separado
