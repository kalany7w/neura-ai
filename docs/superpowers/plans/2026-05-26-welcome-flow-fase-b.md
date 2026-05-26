# Welcome Flow Fase B — UI de Configuração — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expor a configuração do welcome flow + auto-routing pela UI de admin: listagem por inbox, editor completo (prompt, opções drag-drop, fallback, timeouts), campos de routing no editor de labels, e um modo de teste pra enviar mensagem real pra um número de prova. Sem essa fase, admin precisa popular WelcomeFlow via Prisma Studio / SQL.

**Architecture:** Routes Hono novos em `apps/api/src/routes/welcome-flows.ts` com CRUD do flow + sub-CRUD de options + endpoint de test. Pages Next.js em `apps/web/src/app/(app)/settings/welcome-flows/` (list + editor). Update do form de labels com campos routing. Padrão: react-hook-form + zodResolver + react-query + sonner + shadcn — mesmo pattern que `settings/labels`, `settings/sla`, `settings/templates`.

**Tech Stack:** Hono 4 + Zod (api), Next.js 15 App Router + react-hook-form + @tanstack/react-query + @dnd-kit + shadcn/ui + sonner + zod (web). Vitest pra unit tests dos handlers.

**Spec base:** `docs/superpowers/specs/2026-05-26-welcome-flow-autorouting-design.md` (Fase B section)
**Fase A:** completa em branch `feat/welcome-flow-fase-a` (PR #1). Esta branch (`feat/welcome-flow-fase-b`) está stacked em cima.

---

## File Structure

### API routes (Hono)
- Create: `apps/api/src/routes/welcome-flows.ts` — CRUD do flow (GET/POST/PUT/DELETE), sub-CRUD options, endpoint de test
- Modify: `apps/api/src/routes/labels.ts` — schema Zod ganha `routesToFunnelId` + `routesToStageId`
- Modify: `apps/api/src/index.ts` — wire `welcomeFlowsRouter`

### Web pages (Next.js)
- Create: `apps/web/src/app/(app)/settings/welcome-flows/page.tsx` — list por inbox + status + link "editar"
- Create: `apps/web/src/app/(app)/settings/welcome-flows/[inboxId]/page.tsx` — editor completo

### Web components
- Create: `apps/web/src/components/settings/welcome-flow-options-editor.tsx` — drag-drop list de options (extraído pra arquivo próprio porque é a parte mais complexa do editor)
- Create: `apps/web/src/components/settings/welcome-flow-test-dialog.tsx` — modal pra "enviar teste pra meu número"
- Modify: `apps/web/src/app/(app)/settings/labels/page.tsx` — adicionar campos routing no form
- Modify: `apps/web/src/components/layout/sidebar.tsx` — adicionar "Fluxo de boas-vindas" em Configurações

### shadcn components a instalar
- `textarea` — pra prompt multi-linha (não está em components/ui ainda)
- `select` — pra dropdowns de funnel/stage (não está)
- `switch` — pra toggle enabled (não está)

### Tests
- Create: `apps/api/tests/welcome-flows-route.test.ts` — integration tests dos handlers (CRUD + test endpoint mockado)

---

## Task 1: Install shadcn components missing (textarea, select, switch)

**Files:**
- Auto-created: `apps/web/src/components/ui/textarea.tsx`, `select.tsx`, `switch.tsx`
- Modified: `apps/web/package.json` (deps Radix Primitives novos)

- [ ] **Step 1: Verificar quais componentes já existem**

```bash
ls apps/web/src/components/ui/
```

Expected: NÃO listar `textarea.tsx`, `select.tsx`, `switch.tsx`.

- [ ] **Step 2: Adicionar via shadcn CLI**

```bash
cd apps/web
pnpm dlx shadcn@latest add textarea select switch
```

Expected: 3 arquivos criados em `src/components/ui/`. Pode instalar `@radix-ui/react-select` e `@radix-ui/react-switch` em deps.

- [ ] **Step 3: Verificar e typecheck**

```bash
cd ../..
pnpm --filter @neura/web typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ui/textarea.tsx apps/web/src/components/ui/select.tsx apps/web/src/components/ui/switch.tsx apps/web/package.json apps/web/pnpm-lock.yaml 2>/dev/null || git add apps/web/
git commit -m "chore(web): adiciona shadcn components textarea/select/switch pra welcome flow editor"
```

---

## Task 2: Routes welcome-flows.ts — CRUD do flow (GET/POST/PUT/DELETE)

**Files:**
- Create: `apps/api/src/routes/welcome-flows.ts`

- [ ] **Step 1: Criar arquivo com handlers base**

```typescript
import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';
import { requirePermission } from '../middlewares/permissions.js';
import { audit } from '../services/audit.js';
import { publishEvent } from '../redis-pub.js';

export const welcomeFlowsRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

const flowUpsertSchema = z.object({
  prompt: z.string().min(1).max(2_000),
  fallbackLabelId: z.string().nullable().optional(),
  fallbackFunnelId: z.string().nullable().optional(),
  fallbackStageId: z.string().nullable().optional(),
  fallbackTimeoutMinutes: z.number().int().min(0).max(60).default(2),
  maxAttempts: z.number().int().min(1).max(10).default(2),
  enabled: z.boolean().default(true),
});

/**
 * GET /api/inboxes/:inboxId/welcome-flow
 * Retorna o flow da inbox + options ordenadas. Retorna 404 se não existir.
 */
welcomeFlowsRouter.get('/inboxes/:inboxId/welcome-flow', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const { inboxId } = c.req.param();

  // Garante que a inbox pertence ao workspace
  const inbox = await prisma.inbox.findFirst({
    where: { id: inboxId, workspaceId },
    select: { id: true, name: true },
  });
  if (!inbox) return c.json({ error: 'inbox_not_found' }, 404);

  const flow = await prisma.welcomeFlow.findUnique({
    where: { inboxId },
    include: { options: { orderBy: { position: 'asc' } } },
  });
  if (!flow) return c.json({ error: 'not_found', inbox }, 404);

  return c.json({ flow, inbox });
});

/**
 * POST /api/inboxes/:inboxId/welcome-flow
 * Cria o flow (1 por inbox). Falha 409 se já existir.
 */
welcomeFlowsRouter.post(
  '/inboxes/:inboxId/welcome-flow',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const { inboxId } = c.req.param();

    const inbox = await prisma.inbox.findFirst({
      where: { id: inboxId, workspaceId },
      select: { id: true },
    });
    if (!inbox) return c.json({ error: 'inbox_not_found' }, 404);

    const body = await c.req.json().catch(() => null);
    const parsed = flowUpsertSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

    try {
      const flow = await prisma.welcomeFlow.create({
        data: { workspaceId, inboxId, ...parsed.data },
        include: { options: true },
      });

      await audit({
        workspaceId,
        actorId: c.get('userId'),
        action: 'welcome_flow.created',
        resource: `WelcomeFlow:${flow.id}`,
      });

      await publishEvent(workspaceId, 'settings', 'welcome_flow.created', {
        inboxId,
        flowId: flow.id,
      });

      return c.json({ flow }, 201);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') return c.json({ error: 'already_exists' }, 409);
      throw err;
    }
  },
);

/**
 * PUT /api/inboxes/:inboxId/welcome-flow
 * Atualiza o flow existente.
 */
welcomeFlowsRouter.put(
  '/inboxes/:inboxId/welcome-flow',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const { inboxId } = c.req.param();

    const body = await c.req.json().catch(() => null);
    const parsed = flowUpsertSchema.partial().safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

    const flow = await prisma.welcomeFlow.findFirst({
      where: { inboxId, workspaceId },
      select: { id: true },
    });
    if (!flow) return c.json({ error: 'not_found' }, 404);

    const updated = await prisma.welcomeFlow.update({
      where: { id: flow.id },
      data: parsed.data,
      include: { options: { orderBy: { position: 'asc' } } },
    });

    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'welcome_flow.updated',
      resource: `WelcomeFlow:${flow.id}`,
      metadata: { changes: parsed.data },
    });

    await publishEvent(workspaceId, 'settings', 'welcome_flow.updated', {
      inboxId,
      flowId: flow.id,
    });

    return c.json({ flow: updated });
  },
);

/**
 * DELETE /api/inboxes/:inboxId/welcome-flow
 * Remove o flow (soft via enabled=false, ou hard delete se ?hard=true).
 */
welcomeFlowsRouter.delete(
  '/inboxes/:inboxId/welcome-flow',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const { inboxId } = c.req.param();
    const hard = c.req.query('hard') === 'true';

    const flow = await prisma.welcomeFlow.findFirst({
      where: { inboxId, workspaceId },
      select: { id: true },
    });
    if (!flow) return c.json({ error: 'not_found' }, 404);

    if (hard) {
      await prisma.welcomeFlow.delete({ where: { id: flow.id } });
    } else {
      await prisma.welcomeFlow.update({
        where: { id: flow.id },
        data: { enabled: false },
      });
    }

    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: hard ? 'welcome_flow.deleted' : 'welcome_flow.disabled',
      resource: `WelcomeFlow:${flow.id}`,
    });

    return c.json({ ok: true });
  },
);
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @neura/api typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/welcome-flows.ts
git commit -m "feat(api): routes welcome-flows CRUD do flow (GET/POST/PUT/DELETE)"
```

---

## Task 3: Routes welcome-flows.ts — Options sub-CRUD

**Files:**
- Modify: `apps/api/src/routes/welcome-flows.ts` (adicionar handlers)

- [ ] **Step 1: Adicionar schema e handlers de options**

Adicionar ao final do `welcome-flows.ts` (antes do final do arquivo):

```typescript
const optionUpsertSchema = z.object({
  position: z.number().int().min(1).max(10),
  label: z.string().min(1).max(60),
  description: z.string().max(120).nullable().optional(),
  matchKeywords: z.array(z.string().min(1).max(40)).max(10).default([]),
  targetLabelId: z.string().min(1),
  targetFunnelId: z.string().nullable().optional(),
  targetStageId: z.string().nullable().optional(),
});

async function assertFlowInWorkspace(
  flowId: string,
  workspaceId: string,
): Promise<{ id: string } | null> {
  return prisma.welcomeFlow.findFirst({
    where: { id: flowId, workspaceId },
    select: { id: true },
  });
}

/**
 * POST /api/welcome-flows/:flowId/options
 * Adiciona opção ao flow. Posição deve ser única dentro do flow.
 */
welcomeFlowsRouter.post(
  '/welcome-flows/:flowId/options',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const { flowId } = c.req.param();

    const flow = await assertFlowInWorkspace(flowId, workspaceId);
    if (!flow) return c.json({ error: 'flow_not_found' }, 404);

    const body = await c.req.json().catch(() => null);
    const parsed = optionUpsertSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

    try {
      const option = await prisma.welcomeOption.create({
        data: { flowId, ...parsed.data, description: parsed.data.description ?? null },
      });

      await audit({
        workspaceId,
        actorId: c.get('userId'),
        action: 'welcome_flow.option_created',
        resource: `WelcomeOption:${option.id}`,
        metadata: { flowId },
      });

      return c.json({ option }, 201);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') return c.json({ error: 'position_taken' }, 409);
      throw err;
    }
  },
);

/**
 * PUT /api/welcome-flows/:flowId/options/:optionId
 * Atualiza opção.
 */
welcomeFlowsRouter.put(
  '/welcome-flows/:flowId/options/:optionId',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const { flowId, optionId } = c.req.param();

    const flow = await assertFlowInWorkspace(flowId, workspaceId);
    if (!flow) return c.json({ error: 'flow_not_found' }, 404);

    const body = await c.req.json().catch(() => null);
    const parsed = optionUpsertSchema.partial().safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

    const existing = await prisma.welcomeOption.findFirst({
      where: { id: optionId, flowId },
      select: { id: true },
    });
    if (!existing) return c.json({ error: 'option_not_found' }, 404);

    try {
      const option = await prisma.welcomeOption.update({
        where: { id: optionId },
        data: parsed.data,
      });

      await audit({
        workspaceId,
        actorId: c.get('userId'),
        action: 'welcome_flow.option_updated',
        resource: `WelcomeOption:${optionId}`,
        metadata: { flowId, changes: parsed.data },
      });

      return c.json({ option });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') return c.json({ error: 'position_taken' }, 409);
      throw err;
    }
  },
);

/**
 * DELETE /api/welcome-flows/:flowId/options/:optionId
 * Remove opção.
 */
welcomeFlowsRouter.delete(
  '/welcome-flows/:flowId/options/:optionId',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const { flowId, optionId } = c.req.param();

    const flow = await assertFlowInWorkspace(flowId, workspaceId);
    if (!flow) return c.json({ error: 'flow_not_found' }, 404);

    const existing = await prisma.welcomeOption.findFirst({
      where: { id: optionId, flowId },
      select: { id: true },
    });
    if (!existing) return c.json({ error: 'option_not_found' }, 404);

    await prisma.welcomeOption.delete({ where: { id: optionId } });

    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'welcome_flow.option_deleted',
      resource: `WelcomeOption:${optionId}`,
      metadata: { flowId },
    });

    return c.json({ ok: true });
  },
);

/**
 * POST /api/welcome-flows/:flowId/options/reorder
 * Reordena opções. Body: { orderedIds: string[] }
 * Atribui position = 1..N na ordem fornecida.
 */
welcomeFlowsRouter.post(
  '/welcome-flows/:flowId/options/reorder',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const { flowId } = c.req.param();

    const flow = await assertFlowInWorkspace(flowId, workspaceId);
    if (!flow) return c.json({ error: 'flow_not_found' }, 404);

    const body = await c.req.json().catch(() => null);
    const schema = z.object({ orderedIds: z.array(z.string()).min(1).max(10) });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

    // Update em transação: position negativa temporária pra evitar collision unique
    // depois aplica final.
    await prisma.$transaction(async (tx) => {
      // 1. mover todas pra negativo (preserva)
      for (const id of parsed.data.orderedIds) {
        const opt = await tx.welcomeOption.findFirst({
          where: { id, flowId },
          select: { id: true, position: true },
        });
        if (opt) {
          await tx.welcomeOption.update({
            where: { id },
            data: { position: -opt.position },
          });
        }
      }
      // 2. aplicar nova ordem
      for (let i = 0; i < parsed.data.orderedIds.length; i++) {
        const id = parsed.data.orderedIds[i]!;
        await tx.welcomeOption.update({
          where: { id },
          data: { position: i + 1 },
        });
      }
    });

    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'welcome_flow.options_reordered',
      resource: `WelcomeFlow:${flowId}`,
    });

    return c.json({ ok: true });
  },
);
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @neura/api typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/welcome-flows.ts
git commit -m "feat(api): routes welcome-flows sub-CRUD de options + reorder"
```

---

## Task 4: Routes welcome-flows.ts — Test endpoint

**Files:**
- Modify: `apps/api/src/routes/welcome-flows.ts` (adicionar handler test)

- [ ] **Step 1: Adicionar test endpoint**

```typescript
/**
 * POST /api/welcome-flows/:flowId/test
 * Envia mensagem de teste pra um número arbitrário. Cria conversa temporária
 * + Message AI_AGENT + enfileira outbound INTERACTIVE.
 * Body: { phoneNumber: string (E.164) }
 */
import { sendWelcome } from '../services/welcome-flow.js';

welcomeFlowsRouter.post(
  '/welcome-flows/:flowId/test',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const { flowId } = c.req.param();

    const flow = await prisma.welcomeFlow.findFirst({
      where: { id: flowId, workspaceId },
      include: { options: { orderBy: { position: 'asc' } } },
    });
    if (!flow) return c.json({ error: 'flow_not_found' }, 404);
    if (!flow.enabled) return c.json({ error: 'flow_disabled' }, 400);
    if (flow.options.length === 0) return c.json({ error: 'no_options' }, 400);

    const body = await c.req.json().catch(() => null);
    const schema = z.object({
      phoneNumber: z.string().regex(/^\+\d{8,15}$/, 'phoneNumber inválido (use E.164)'),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

    // Upsert contato de teste (não cria duplicate)
    const contact = await prisma.contact.upsert({
      where: {
        workspaceId_phoneNumber: { workspaceId, phoneNumber: parsed.data.phoneNumber },
      },
      create: {
        workspaceId,
        phoneNumber: parsed.data.phoneNumber,
        name: 'Teste Welcome',
      },
      update: {},
    });

    // Conversa de teste — sempre cria nova pra não afetar conversas reais
    const conv = await prisma.conversation.create({
      data: {
        workspaceId,
        inboxId: flow.inboxId,
        contactId: contact.id,
        status: 'OPEN',
      },
    });

    // Chama o serviço — usa o enqueueOutbound real (vai pro Baileys via worker)
    await sendWelcome({ workspaceId, conversationId: conv.id });

    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'welcome_flow.tested',
      resource: `WelcomeFlow:${flowId}`,
      metadata: { phoneNumber: parsed.data.phoneNumber, conversationId: conv.id },
    });

    return c.json({ ok: true, conversationId: conv.id });
  },
);
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @neura/api typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/welcome-flows.ts
git commit -m "feat(api): routes welcome-flows endpoint de test (envia mensagem real)"
```

---

## Task 5: Labels route — campos routing routesToFunnelId/routesToStageId

**Files:**
- Modify: `apps/api/src/routes/labels.ts`

- [ ] **Step 1: Estender schema Zod**

No topo de `labels.ts`, encontrar o `labelSchema` (atualmente: name, color, scope). Estender:

```typescript
const labelSchema = z.object({
  name: z.string().min(1).max(40),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'color deve ser hex #RRGGBB')
    .default('#94a3b8'),
  scope: z.enum(['CONTACT', 'CONVERSATION', 'BOTH']).default('BOTH'),
  routesToFunnelId: z.string().nullable().optional(),
  routesToStageId: z.string().nullable().optional(),
});
```

- [ ] **Step 2: Atualizar handler POST**

O `create` já usa spread `...parsed.data` — os novos campos passam automaticamente. **Mas adicionar validação extra**: se `routesToFunnelId` setado, `routesToStageId` também deve estar setado (e o stage deve pertencer a esse funnel).

No handler POST, antes do `prisma.label.create`:

```typescript
if (parsed.data.routesToFunnelId) {
  if (!parsed.data.routesToStageId) {
    return c.json({ error: 'routing_requires_stage' }, 400);
  }
  const stage = await prisma.stage.findFirst({
    where: {
      id: parsed.data.routesToStageId,
      funnelId: parsed.data.routesToFunnelId,
    },
    select: { id: true },
  });
  if (!stage) return c.json({ error: 'invalid_stage_for_funnel' }, 400);
}
```

- [ ] **Step 3: Atualizar handler PUT (mesma validação)**

Encontrar o PUT handler. Adicionar a mesma validação antes do `prisma.label.update`.

- [ ] **Step 4: Atualizar handler GET — incluir os campos**

O GET atual retorna `findMany` sem `select` específico — automaticamente inclui as novas colunas. Verificar se o response shape esperado pela UI tem os campos. Se houver `select: { id, name, color, scope }` explícito, adicionar os 2 campos.

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @neura/api typecheck
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/labels.ts
git commit -m "feat(api): labels route ganha campos routesToFunnelId/routesToStageId + validação"
```

---

## Task 6: Wire welcomeFlowsRouter em apps/api/src/index.ts

**Files:**
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Import e mount**

Adicionar import junto com os outros routers:

```typescript
import { welcomeFlowsRouter } from './routes/welcome-flows.js';
```

Adicionar `app.route(...)` junto com os outros, por exemplo após `app.route('/api/labels', labelsRouter);`:

```typescript
// Welcome flows — base path '/api' porque os endpoints variam entre
// /api/inboxes/:id/welcome-flow e /api/welcome-flows/:id/...
app.route('/api', welcomeFlowsRouter);
```

- [ ] **Step 2: Build api**

```bash
pnpm --filter @neura/api build
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/index.ts
git commit -m "feat(api): wire welcomeFlowsRouter"
```

---

## Task 7: Tests unit/integration para welcome-flows route

**Files:**
- Create: `apps/api/tests/welcome-flows-route.test.ts`

- [ ] **Step 1: Escrever testes integration**

```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { prisma } from '@neura/database';

// Helper pra simular um request via fetch contra a app Hono
async function setupFixtures() {
  await prisma.welcomeOption.deleteMany();
  await prisma.welcomeFlow.deleteMany();
  await prisma.stage.deleteMany();
  await prisma.funnel.deleteMany();
  await prisma.label.deleteMany();
  await prisma.inbox.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();

  const user = await prisma.user.create({
    data: { email: 'admin@test.com', name: 'Admin' },
  });
  const ws = await prisma.workspace.create({
    data: {
      name: 'Test WS',
      slug: 'test-ws-wf',
      members: { create: { userId: user.id, role: 'ADMIN' } },
    },
  });
  const inbox = await prisma.inbox.create({
    data: { workspaceId: ws.id, name: 'WA', type: 'WHATSAPP', status: 'CONNECTED' },
  });
  const label = await prisma.label.create({
    data: { workspaceId: ws.id, name: 'Compra', color: '#10b981' },
  });
  const funnel = await prisma.funnel.create({
    data: { workspaceId: ws.id, name: 'Vendas' },
  });
  const stage = await prisma.stage.create({
    data: { funnelId: funnel.id, name: 'Lead', order: 0 },
  });
  return { user, ws, inbox, label, funnel, stage };
}

// Para teste isolado dos handlers, importamos diretamente as funções de prisma —
// testando o domínio sem montar Hono completo. Testes E2E completos com middleware
// auth ficam pra E2E playwright depois.

describe('welcome-flows route — DB layer', () => {
  let fixtures: Awaited<ReturnType<typeof setupFixtures>>;

  beforeAll(async () => {
    fixtures = await setupFixtures();
  });

  beforeEach(async () => {
    await prisma.welcomeOption.deleteMany();
    await prisma.welcomeFlow.deleteMany();
  });

  it('cria flow para uma inbox', async () => {
    const flow = await prisma.welcomeFlow.create({
      data: {
        workspaceId: fixtures.ws.id,
        inboxId: fixtures.inbox.id,
        prompt: 'Olá!',
        enabled: true,
        maxAttempts: 2,
        fallbackTimeoutMinutes: 2,
      },
    });
    expect(flow.id).toBeTruthy();
    expect(flow.prompt).toBe('Olá!');
  });

  it('bloqueia 2 flows na mesma inbox (unique constraint)', async () => {
    await prisma.welcomeFlow.create({
      data: {
        workspaceId: fixtures.ws.id,
        inboxId: fixtures.inbox.id,
        prompt: 'A',
      },
    });
    await expect(
      prisma.welcomeFlow.create({
        data: {
          workspaceId: fixtures.ws.id,
          inboxId: fixtures.inbox.id,
          prompt: 'B',
        },
      }),
    ).rejects.toThrow();
  });

  it('adiciona option e respeita unique (flowId, position)', async () => {
    const flow = await prisma.welcomeFlow.create({
      data: {
        workspaceId: fixtures.ws.id,
        inboxId: fixtures.inbox.id,
        prompt: 'A',
      },
    });
    await prisma.welcomeOption.create({
      data: {
        flowId: flow.id,
        position: 1,
        label: 'Compra',
        matchKeywords: [],
        targetLabelId: fixtures.label.id,
      },
    });
    await expect(
      prisma.welcomeOption.create({
        data: {
          flowId: flow.id,
          position: 1,
          label: 'Outro',
          matchKeywords: [],
          targetLabelId: fixtures.label.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('options vinculadas a label com Restrict bloqueiam deleção da label', async () => {
    const flow = await prisma.welcomeFlow.create({
      data: { workspaceId: fixtures.ws.id, inboxId: fixtures.inbox.id, prompt: 'A' },
    });
    await prisma.welcomeOption.create({
      data: {
        flowId: flow.id,
        position: 1,
        label: 'X',
        matchKeywords: [],
        targetLabelId: fixtures.label.id,
      },
    });
    await expect(prisma.label.delete({ where: { id: fixtures.label.id } })).rejects.toThrow();
  });

  it('cascade: deletar flow remove options', async () => {
    const flow = await prisma.welcomeFlow.create({
      data: { workspaceId: fixtures.ws.id, inboxId: fixtures.inbox.id, prompt: 'A' },
    });
    await prisma.welcomeOption.create({
      data: {
        flowId: flow.id,
        position: 1,
        label: 'X',
        matchKeywords: [],
        targetLabelId: fixtures.label.id,
      },
    });
    await prisma.welcomeFlow.delete({ where: { id: flow.id } });
    const orphan = await prisma.welcomeOption.findFirst({ where: { flowId: flow.id } });
    expect(orphan).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar testes**

```bash
DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5435/neura_ai' \
  pnpm --filter @neura/api test -- tests/welcome-flows-route.test.ts
```

Expected: PASS (5 testes).

- [ ] **Step 3: Commit**

```bash
git add apps/api/tests/welcome-flows-route.test.ts
git commit -m "test(api): welcome-flows route DB layer (constraints + cascade)"
```

---

## Task 8: Page /settings/welcome-flows — list por inbox

**Files:**
- Create: `apps/web/src/app/(app)/settings/welcome-flows/page.tsx`

- [ ] **Step 1: Implementar página de listagem**

```typescript
'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, MessageSquarePlus, Circle, CircleCheck, CircleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';

interface InboxItem {
  id: string;
  name: string;
  type: 'WHATSAPP' | 'TELEGRAM' | 'EMAIL' | 'WEBCHAT';
  status: string;
  welcomeFlow?: {
    id: string;
    enabled: boolean;
    optionsCount: number;
  } | null;
}

export default function WelcomeFlowsListPage() {
  const { data, isLoading } = useQuery<{ inboxes: InboxItem[] }>({
    queryKey: ['welcome-flows-list'],
    queryFn: () => api('/api/inboxes?includeWelcomeFlow=true'),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Fluxo de boas-vindas</h1>
        <p className="text-muted-foreground">
          Configure mensagens automáticas iniciais com opções pra classificar conversas e rotear pra
          funis no kanban.
        </p>
      </div>

      {isLoading && <p className="text-muted-foreground">Carregando…</p>}

      {data?.inboxes && data.inboxes.length === 0 && (
        <div className="rounded-lg border bg-card p-8 text-center">
          <p className="text-muted-foreground">
            Nenhuma inbox configurada ainda. Crie uma em{' '}
            <Link className="underline" href="/inboxes">
              Inboxes
            </Link>{' '}
            antes de configurar fluxo.
          </p>
        </div>
      )}

      <div className="space-y-2">
        {data?.inboxes.map((inbox) => {
          const flow = inbox.welcomeFlow;
          const statusIcon = !flow ? (
            <Circle className="h-4 w-4 text-muted-foreground" />
          ) : flow.enabled ? (
            <CircleCheck className="h-4 w-4 text-emerald-500" />
          ) : (
            <CircleAlert className="h-4 w-4 text-amber-500" />
          );
          const statusText = !flow
            ? 'não configurado'
            : flow.enabled
              ? `ativo · ${flow.optionsCount} opções`
              : 'desativado';

          return (
            <Link
              key={inbox.id}
              href={`/settings/welcome-flows/${inbox.id}`}
              className="flex items-center justify-between rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50"
            >
              <div className="flex items-center gap-3">
                <MessageSquarePlus className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="font-medium">{inbox.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {inbox.type} · {inbox.status}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5 text-xs">
                  {statusIcon}
                  <span className="text-muted-foreground">{statusText}</span>
                </div>
                <Button variant="ghost" size="sm">
                  Editar
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Estender inboxes route pra incluir welcomeFlow (se necessário)**

A página chama `/api/inboxes?includeWelcomeFlow=true`. Verificar se a route já aceita esse query param. Se NÃO, modificar `apps/api/src/routes/inboxes.ts` para incluir:

```typescript
// dentro do GET / handler:
const includeWelcomeFlow = c.req.query('includeWelcomeFlow') === 'true';

const inboxes = await prisma.inbox.findMany({
  where: { workspaceId },
  include: includeWelcomeFlow
    ? {
        welcomeFlow: {
          select: {
            id: true,
            enabled: true,
            _count: { select: { options: true } },
          },
        },
      }
    : undefined,
  orderBy: { createdAt: 'asc' },
});

// Map pra response shape esperado pela UI
const mapped = inboxes.map((i) => ({
  ...i,
  welcomeFlow: i.welcomeFlow
    ? {
        id: i.welcomeFlow.id,
        enabled: i.welcomeFlow.enabled,
        optionsCount: i.welcomeFlow._count.options,
      }
    : null,
}));

return c.json({ inboxes: mapped });
```

- [ ] **Step 3: Typecheck + build web**

```bash
pnpm --filter @neura/api typecheck
pnpm --filter @neura/web typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/\(app\)/settings/welcome-flows/page.tsx apps/api/src/routes/inboxes.ts
git commit -m "feat(web): página /settings/welcome-flows com lista por inbox"
```

---

## Task 9: Page editor — prompt + flags básicas

**Files:**
- Create: `apps/web/src/app/(app)/settings/welcome-flows/[inboxId]/page.tsx`

- [ ] **Step 1: Implementar editor com prompt + flags**

```typescript
'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ChevronLeft, Save, Send } from 'lucide-react';
import { toast } from 'sonner';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface FlowResponse {
  flow: {
    id: string;
    prompt: string;
    fallbackLabelId: string | null;
    fallbackFunnelId: string | null;
    fallbackStageId: string | null;
    fallbackTimeoutMinutes: number;
    maxAttempts: number;
    enabled: boolean;
    options: WelcomeOption[];
  };
  inbox: { id: string; name: string };
}

interface WelcomeOption {
  id: string;
  position: number;
  label: string;
  description: string | null;
  matchKeywords: string[];
  targetLabelId: string;
  targetFunnelId: string | null;
  targetStageId: string | null;
}

interface LabelOpt {
  id: string;
  name: string;
  color: string;
}
interface FunnelOpt {
  id: string;
  name: string;
  stages: { id: string; name: string }[];
}

const flowSchema = z.object({
  prompt: z.string().min(1).max(2_000),
  enabled: z.boolean(),
  fallbackLabelId: z.string().nullable(),
  fallbackFunnelId: z.string().nullable(),
  fallbackStageId: z.string().nullable(),
  fallbackTimeoutMinutes: z.number().int().min(0).max(60),
  maxAttempts: z.number().int().min(1).max(10),
});
type FlowInput = z.infer<typeof flowSchema>;

export default function WelcomeFlowEditorPage() {
  const params = useParams<{ inboxId: string }>();
  const inboxId = params.inboxId;
  const router = useRouter();
  const qc = useQueryClient();
  const [submitting, setSubmitting] = useState(false);

  const { data, isLoading, isError } = useQuery<FlowResponse | { error: string; inbox: { id: string; name: string } }>({
    queryKey: ['welcome-flow', inboxId],
    queryFn: async () => {
      try {
        return await api(`/api/inboxes/${inboxId}/welcome-flow`);
      } catch (err) {
        // 404 esperado quando flow não existe ainda — retorna inbox info
        if (err instanceof ApiError && err.status === 404) {
          return err.body as { error: string; inbox: { id: string; name: string } };
        }
        throw err;
      }
    },
  });

  const { data: labelsData } = useQuery<{ labels: LabelOpt[] }>({
    queryKey: ['labels'],
    queryFn: () => api('/api/labels'),
  });

  const { data: funnelsData } = useQuery<{ funnels: FunnelOpt[] }>({
    queryKey: ['funnels-with-stages'],
    queryFn: () => api('/api/kanban/funnels?includeStages=true'),
  });

  const hasFlow = data && 'flow' in data;
  const inbox = data?.inbox;

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<FlowInput>({
    resolver: zodResolver(flowSchema),
    defaultValues: {
      prompt: 'Olá! Como podemos ajudar?\n\n1. Compra\n2. Suporte',
      enabled: true,
      fallbackLabelId: null,
      fallbackFunnelId: null,
      fallbackStageId: null,
      fallbackTimeoutMinutes: 2,
      maxAttempts: 2,
    },
    values: hasFlow
      ? {
          prompt: data.flow.prompt,
          enabled: data.flow.enabled,
          fallbackLabelId: data.flow.fallbackLabelId,
          fallbackFunnelId: data.flow.fallbackFunnelId,
          fallbackStageId: data.flow.fallbackStageId,
          fallbackTimeoutMinutes: data.flow.fallbackTimeoutMinutes,
          maxAttempts: data.flow.maxAttempts,
        }
      : undefined,
  });

  const fallbackFunnelId = watch('fallbackFunnelId');
  const fallbackStages = funnelsData?.funnels.find((f) => f.id === fallbackFunnelId)?.stages ?? [];

  async function onSave(values: FlowInput) {
    setSubmitting(true);
    try {
      const method = hasFlow ? 'PUT' : 'POST';
      await api(`/api/inboxes/${inboxId}/welcome-flow`, {
        method,
        body: JSON.stringify(values),
      });
      toast.success(hasFlow ? 'Fluxo atualizado' : 'Fluxo criado');
      await qc.invalidateQueries({ queryKey: ['welcome-flow', inboxId] });
      await qc.invalidateQueries({ queryKey: ['welcome-flows-list'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar');
    } finally {
      setSubmitting(false);
    }
  }

  if (isLoading) return <p className="text-muted-foreground">Carregando…</p>;
  if (isError || !inbox) {
    return (
      <div className="space-y-4">
        <p className="text-destructive">Erro ao carregar fluxo. Inbox existe?</p>
        <Button onClick={() => router.push('/settings/welcome-flows')}>Voltar</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Link href="/settings/welcome-flows" className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-3xl font-bold">{inbox.name}</h1>
          <p className="text-muted-foreground">Fluxo de boas-vindas</p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSave)} className="space-y-6">
        <div className="rounded-lg border bg-card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Configurações gerais</h2>
            <div className="flex items-center gap-2">
              <Label htmlFor="enabled" className="text-sm">
                Ativo
              </Label>
              <Switch
                id="enabled"
                checked={watch('enabled')}
                onCheckedChange={(v) => setValue('enabled', v)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="prompt">Mensagem inicial</Label>
            <Textarea
              id="prompt"
              {...register('prompt')}
              rows={6}
              placeholder="Olá {{contact.name}}! Como podemos ajudar?"
            />
            <p className="text-xs text-muted-foreground">
              Suporta placeholder <code>{'{{contact.name}}'}</code>. Quando o nome do contato for
              vazio, substitui por "cliente".
            </p>
            {errors.prompt && <p className="text-xs text-destructive">{errors.prompt.message}</p>}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="maxAttempts">Máx. tentativas do cliente</Label>
              <Input
                id="maxAttempts"
                type="number"
                min={1}
                max={10}
                {...register('maxAttempts', { valueAsNumber: true })}
              />
              <p className="text-xs text-muted-foreground">
                Após N respostas sem match, aplica fallback.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="fallbackTimeoutMinutes">Timeout pra texto plano (min)</Label>
              <Input
                id="fallbackTimeoutMinutes"
                type="number"
                min={0}
                max={60}
                {...register('fallbackTimeoutMinutes', { valueAsNumber: true })}
              />
              <p className="text-xs text-muted-foreground">
                Se cliente não responder o botão interativo em X min, reenviamos como texto. 0 =
                desativado.
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-5 space-y-4">
          <h2 className="font-semibold">Fallback (se nenhuma opção matchea)</h2>

          <div className="space-y-2">
            <Label>Etiqueta aplicada</Label>
            <Select
              value={watch('fallbackLabelId') ?? 'none'}
              onValueChange={(v) => setValue('fallbackLabelId', v === 'none' ? null : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Nenhuma" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Nenhuma</SelectItem>
                {labelsData?.labels.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Funil destino</Label>
              <Select
                value={watch('fallbackFunnelId') ?? 'none'}
                onValueChange={(v) => {
                  setValue('fallbackFunnelId', v === 'none' ? null : v);
                  setValue('fallbackStageId', null);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Nenhum" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Nenhum</SelectItem>
                  {funnelsData?.funnels.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Etapa inicial</Label>
              <Select
                value={watch('fallbackStageId') ?? 'none'}
                onValueChange={(v) => setValue('fallbackStageId', v === 'none' ? null : v)}
                disabled={!fallbackFunnelId}
              >
                <SelectTrigger>
                  <SelectValue placeholder={fallbackFunnelId ? 'Selecione' : 'Escolha funil antes'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Nenhum</SelectItem>
                  {fallbackStages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="submit" disabled={submitting}>
            <Save className="mr-2 h-4 w-4" />
            {submitting ? 'Salvando…' : 'Salvar'}
          </Button>
        </div>
      </form>

      {/* Options editor + test dialog vão aqui — tarefas 10 e 11 */}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @neura/web typecheck
```

Expected: PASS. Se reclamar de `kanban/funnels?includeStages=true` retornar shape esperado, ajustar a query do API ou o tipo `FunnelOpt`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/\(app\)/settings/welcome-flows/\[inboxId\]/page.tsx
git commit -m "feat(web): editor /settings/welcome-flows/:inboxId (prompt + flags + fallback)"
```

---

## Task 10: Options editor component (drag-drop)

**Files:**
- Create: `apps/web/src/components/settings/welcome-flow-options-editor.tsx`
- Modify: `apps/web/src/app/(app)/settings/welcome-flows/[inboxId]/page.tsx` (mount component)

- [ ] **Step 1: Criar componente**

```typescript
'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface WelcomeOption {
  id: string;
  position: number;
  label: string;
  description: string | null;
  matchKeywords: string[];
  targetLabelId: string;
  targetFunnelId: string | null;
  targetStageId: string | null;
}

interface LabelOpt {
  id: string;
  name: string;
  color: string;
}

interface FunnelOpt {
  id: string;
  name: string;
  stages: { id: string; name: string }[];
}

interface Props {
  flowId: string;
  options: WelcomeOption[];
  labels: LabelOpt[];
  funnels: FunnelOpt[];
}

export function WelcomeFlowOptionsEditor({ flowId, options, labels, funnels }: Props) {
  const qc = useQueryClient();
  const [items, setItems] = useState(options);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const reorderMut = useMutation({
    mutationFn: (orderedIds: string[]) =>
      api(`/api/welcome-flows/${flowId}/options/reorder`, {
        method: 'POST',
        body: JSON.stringify({ orderedIds }),
      }),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Erro ao reordenar'),
  });

  const addMut = useMutation({
    mutationFn: () =>
      api<{ option: WelcomeOption }>(`/api/welcome-flows/${flowId}/options`, {
        method: 'POST',
        body: JSON.stringify({
          position: items.length + 1,
          label: 'Nova opção',
          matchKeywords: [],
          targetLabelId: labels[0]?.id ?? '',
        }),
      }),
    onSuccess: (resp) => {
      setItems([...items, resp.option]);
      qc.invalidateQueries({ queryKey: ['welcome-flow'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Erro'),
  });

  const removeMut = useMutation({
    mutationFn: (optionId: string) =>
      api(`/api/welcome-flows/${flowId}/options/${optionId}`, { method: 'DELETE' }),
    onSuccess: (_, optionId) => {
      setItems(items.filter((o) => o.id !== optionId));
      qc.invalidateQueries({ queryKey: ['welcome-flow'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Erro'),
  });

  const updateMut = useMutation({
    mutationFn: ({ optionId, patch }: { optionId: string; patch: Partial<WelcomeOption> }) =>
      api(`/api/welcome-flows/${flowId}/options/${optionId}`, {
        method: 'PUT',
        body: JSON.stringify(patch),
      }),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Erro'),
  });

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = items.findIndex((i) => i.id === active.id);
    const newIndex = items.findIndex((i) => i.id === over.id);
    const newItems = arrayMove(items, oldIndex, newIndex);
    setItems(newItems);
    reorderMut.mutate(newItems.map((i) => i.id));
  }

  function updateField(optionId: string, patch: Partial<WelcomeOption>) {
    setItems(items.map((o) => (o.id === optionId ? { ...o, ...patch } : o)));
    updateMut.mutate({ optionId, patch });
  }

  return (
    <div className="rounded-lg border bg-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Opções do menu (max 10)</h2>
        <Button
          type="button"
          size="sm"
          onClick={() => addMut.mutate()}
          disabled={addMut.isPending || items.length >= 10}
        >
          <Plus className="mr-1 h-4 w-4" />
          Adicionar
        </Button>
      </div>

      {items.length === 0 && (
        <p className="text-muted-foreground text-sm">
          Sem opções ainda. Adicione pelo menos uma pra ativar o fluxo.
        </p>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-3">
            {items.map((opt) => (
              <SortableOptionRow
                key={opt.id}
                option={opt}
                labels={labels}
                funnels={funnels}
                onUpdate={(patch) => updateField(opt.id, patch)}
                onRemove={() => removeMut.mutate(opt.id)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

interface RowProps {
  option: WelcomeOption;
  labels: LabelOpt[];
  funnels: FunnelOpt[];
  onUpdate: (patch: Partial<WelcomeOption>) => void;
  onRemove: () => void;
}

function SortableOptionRow({ option, labels, funnels, onUpdate, onRemove }: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: option.id,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const stages = funnels.find((f) => f.id === option.targetFunnelId)?.stages ?? [];
  const [keywordInput, setKeywordInput] = useState('');

  return (
    <div ref={setNodeRef} style={style} className="rounded-md border bg-muted/30 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <button
          {...attributes}
          {...listeners}
          type="button"
          className="cursor-grab text-muted-foreground hover:text-foreground"
          aria-label="Arrastar"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <span className="text-xs font-mono text-muted-foreground">#{option.position}</span>
        <Input
          value={option.label}
          onChange={(e) => onUpdate({ label: e.target.value })}
          className="flex-1"
          placeholder="Ex: Compra"
        />
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>

      <Input
        value={option.description ?? ''}
        onChange={(e) => onUpdate({ description: e.target.value || null })}
        placeholder="Descrição (opcional, aparece abaixo do título no menu)"
      />

      <div className="grid grid-cols-3 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Etiqueta aplicada</Label>
          <Select
            value={option.targetLabelId}
            onValueChange={(v) => onUpdate({ targetLabelId: v })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Escolha" />
            </SelectTrigger>
            <SelectContent>
              {labels.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Funil</Label>
          <Select
            value={option.targetFunnelId ?? 'none'}
            onValueChange={(v) =>
              onUpdate({ targetFunnelId: v === 'none' ? null : v, targetStageId: null })
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="Nenhum" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Nenhum</SelectItem>
              {funnels.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Etapa</Label>
          <Select
            value={option.targetStageId ?? 'none'}
            onValueChange={(v) => onUpdate({ targetStageId: v === 'none' ? null : v })}
            disabled={!option.targetFunnelId}
          >
            <SelectTrigger>
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Nenhuma</SelectItem>
              {stages.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Palavras-chave (separadas por enter)</Label>
        <div className="flex flex-wrap gap-1 rounded-md border bg-background p-2 min-h-10">
          {option.matchKeywords.map((k, i) => (
            <span
              key={`${k}-${i}`}
              className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs"
            >
              {k}
              <button
                type="button"
                onClick={() =>
                  onUpdate({ matchKeywords: option.matchKeywords.filter((_, idx) => idx !== i) })
                }
                className="text-muted-foreground hover:text-destructive"
              >
                ×
              </button>
            </span>
          ))}
          <input
            type="text"
            className="flex-1 bg-transparent text-sm outline-none min-w-20"
            value={keywordInput}
            onChange={(e) => setKeywordInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && keywordInput.trim()) {
                e.preventDefault();
                const next = [...option.matchKeywords, keywordInput.trim()];
                onUpdate({ matchKeywords: next });
                setKeywordInput('');
              }
            }}
            placeholder="adicionar palavra-chave..."
          />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount no editor page**

Em `apps/web/src/app/(app)/settings/welcome-flows/[inboxId]/page.tsx`, antes do `</div>` final do return, e depois do form de configurações gerais + fallback (mas FORA do form), adicionar:

```typescript
{hasFlow && data.flow.options !== undefined && labelsData && funnelsData && (
  <WelcomeFlowOptionsEditor
    flowId={data.flow.id}
    options={data.flow.options}
    labels={labelsData.labels}
    funnels={funnelsData.funnels}
  />
)}
```

E import no topo:
```typescript
import { WelcomeFlowOptionsEditor } from '@/components/settings/welcome-flow-options-editor';
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @neura/web typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/settings/welcome-flow-options-editor.tsx apps/web/src/app/\(app\)/settings/welcome-flows/\[inboxId\]/page.tsx
git commit -m "feat(web): options editor drag-drop com CRUD + keywords + routing por opção"
```

---

## Task 11: Test mode dialog

**Files:**
- Create: `apps/web/src/components/settings/welcome-flow-test-dialog.tsx`
- Modify: `apps/web/src/app/(app)/settings/welcome-flows/[inboxId]/page.tsx` (botão pra abrir dialog)

- [ ] **Step 1: Criar dialog**

```typescript
'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Send } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

const schema = z.object({
  phoneNumber: z.string().regex(/^\+\d{8,15}$/, 'Use formato E.164: +5511999999999'),
});
type Input = z.infer<typeof schema>;

interface Props {
  flowId: string;
  flowEnabled: boolean;
  optionsCount: number;
}

export function WelcomeFlowTestDialog({ flowId, flowEnabled, optionsCount }: Props) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<Input>({
    resolver: zodResolver(schema),
  });

  async function onSubmit(values: Input) {
    setSubmitting(true);
    try {
      await api(`/api/welcome-flows/${flowId}/test`, {
        method: 'POST',
        body: JSON.stringify(values),
      });
      toast.success('Mensagem de teste enviada! Verifica seu WhatsApp.');
      reset();
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao enviar teste');
    } finally {
      setSubmitting(false);
    }
  }

  const disabled = !flowEnabled || optionsCount === 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" disabled={disabled}>
          <Send className="mr-2 h-4 w-4" />
          Enviar teste
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enviar teste do fluxo</DialogTitle>
          <DialogDescription>
            O número receberá a mensagem real com as opções configuradas. Use seu próprio celular
            pra validar que aparece corretamente.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="phoneNumber">Número (E.164)</Label>
            <Input
              id="phoneNumber"
              placeholder="+5511999999999"
              {...register('phoneNumber')}
            />
            {errors.phoneNumber && (
              <p className="text-xs text-destructive">{errors.phoneNumber.message}</p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Enviando…' : 'Enviar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Mount no editor (header do page)**

Em `[inboxId]/page.tsx`, no header do page (ao lado do título), adicionar:

```typescript
import { WelcomeFlowTestDialog } from '@/components/settings/welcome-flow-test-dialog';
```

E no JSX, ao lado do `<Button type="submit">Salvar</Button>`:

```typescript
{hasFlow && (
  <WelcomeFlowTestDialog
    flowId={data.flow.id}
    flowEnabled={data.flow.enabled}
    optionsCount={data.flow.options.length}
  />
)}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @neura/web typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/settings/welcome-flow-test-dialog.tsx apps/web/src/app/\(app\)/settings/welcome-flows/\[inboxId\]/page.tsx
git commit -m "feat(web): dialog 'enviar teste' que dispara welcome real pra número informado"
```

---

## Task 12: Labels page — campos routing no form

**Files:**
- Modify: `apps/web/src/app/(app)/settings/labels/page.tsx`

- [ ] **Step 1: Estender schema Zod no front e form**

No topo do `labels/page.tsx`, encontrar o `schema` e estender:

```typescript
const schema = z.object({
  name: z.string().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  scope: z.enum(['CONTACT', 'CONVERSATION', 'BOTH']).default('BOTH'),
  routesToFunnelId: z.string().nullable().optional(),
  routesToStageId: z.string().nullable().optional(),
});
```

- [ ] **Step 2: Carregar funis + stages**

Adicionar `useQuery` pra funnels (mesma source que o welcome-flow editor):

```typescript
const { data: funnelsData } = useQuery<{ funnels: { id: string; name: string; stages: { id: string; name: string }[] }[] }>({
  queryKey: ['funnels-with-stages'],
  queryFn: () => api('/api/kanban/funnels?includeStages=true'),
});
```

- [ ] **Step 3: Adicionar 2 selects no form de criar/editar label**

Após o select de `scope` no JSX do form:

```typescript
<div className="space-y-2">
  <Label>Funil destino (auto-routing)</Label>
  <Select
    value={watch('routesToFunnelId') ?? 'none'}
    onValueChange={(v) => {
      setValue('routesToFunnelId', v === 'none' ? null : v);
      setValue('routesToStageId', null);
    }}
  >
    <SelectTrigger>
      <SelectValue placeholder="Nenhum (label não rotear)" />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="none">Nenhum</SelectItem>
      {funnelsData?.funnels.map((f) => (
        <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
      ))}
    </SelectContent>
  </Select>
  <p className="text-xs text-muted-foreground">
    Se configurado, aplicar essa etiqueta cria card no funil/etapa abaixo.
  </p>
</div>

{watch('routesToFunnelId') && (
  <div className="space-y-2">
    <Label>Etapa inicial</Label>
    <Select
      value={watch('routesToStageId') ?? 'none'}
      onValueChange={(v) => setValue('routesToStageId', v === 'none' ? null : v)}
    >
      <SelectTrigger>
        <SelectValue placeholder="Escolha a etapa" />
      </SelectTrigger>
      <SelectContent>
        {(funnelsData?.funnels.find((f) => f.id === watch('routesToFunnelId'))?.stages ?? []).map(
          (s) => (
            <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
          ),
        )}
      </SelectContent>
    </Select>
  </div>
)}
```

E imports:

```typescript
import { useForm } from 'react-hook-form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
```

(`useForm` já está; só garantir `watch`/`setValue` no destructure.)

- [ ] **Step 4: Atualizar list de labels — mostrar chip "→ Funil/Etapa" se tem routing**

Encontrar onde os labels são listados (provavelmente um `.map((label) => ...)`). Ao lado do nome do label, adicionar:

```typescript
{label.routesToFunnelId && (
  <span className="inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
    → Pipeline
  </span>
)}
```

(Versão simples; pode evoluir pra mostrar nome do funil se quiser carregar tudo.)

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @neura/web typecheck
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/\(app\)/settings/labels/page.tsx
git commit -m "feat(web): labels form ganha selects de funil/etapa pra auto-routing"
```

---

## Task 13: Sidebar — adicionar item "Fluxo de boas-vindas"

**Files:**
- Modify: `apps/web/src/components/layout/sidebar.tsx`

- [ ] **Step 1: Adicionar nav item**

Encontrar o array `groups` no `sidebar.tsx`. Dentro do grupo "Configurações", adicionar (sugerido depois de "Templates"):

```typescript
{ href: '/settings/welcome-flows', label: 'Fluxo de boas-vindas', icon: MessageSquarePlus, roles: ['ADMIN', 'SUPERVISOR'] },
```

E adicionar `MessageSquarePlus` ao import de `lucide-react`:

```typescript
import {
  // ...existentes
  MessageSquarePlus,
} from 'lucide-react';
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @neura/web typecheck
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/layout/sidebar.tsx
git commit -m "feat(web): sidebar — adiciona link 'Fluxo de boas-vindas' em Configurações"
```

---

## Task 14: Build final + smoke test UI

**Files:** nenhum (só validação)

- [ ] **Step 1: Build full**

```bash
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

Expected: PASS (incluindo os tests novos de welcome-flows-route + os de Fase A).

- [ ] **Step 4: Smoke test manual (opcional)**

Se ambiente dev disponível:

```bash
pnpm dev
```

Em outra janela / no browser:
1. Login em `http://localhost:7302`
2. Ir pra `/settings/welcome-flows` — ver lista de inboxes
3. Clicar uma inbox sem flow — ver editor vazio com defaults
4. Salvar — flow é criado
5. Adicionar 2 opções drag-drop, configurar routing
6. Salvar
7. Voltar pra `/settings/welcome-flows` — ver chip "ativo · 2 opções"
8. Ir em `/settings/labels` — ver campos novos de routing no form

- [ ] **Step 5: Commit final se necessário**

```bash
git add -A
git commit -m "chore(welcome-flow-fase-b): ajustes finais lint/typecheck"
```

---

## Critérios de Aceite — Fase B

- [ ] `pnpm build` PASS em api, web, waworker, shared, database
- [ ] `pnpm typecheck` PASS
- [ ] Tests novos de welcome-flows-route passam
- [ ] Admin consegue criar welcome flow inteiro só pela UI sem tocar Prisma Studio
- [ ] Modo de teste envia mensagem real pra um número
- [ ] Editor de labels permite setar `routesToFunnelId` + `routesToStageId`
- [ ] Sidebar mostra link "Fluxo de boas-vindas" pra admin/supervisor

## Próximas fases (referência)

- **Fase C**: Lead detail panel refactor (estilo Kommo) + chat timeline com separadores
- **Fase D**: Wizard de onboarding + presets por tipo de negócio
- **Follow-ups pendentes**: Whisper transcript path (#38), parallel parse_reply race (#39), card title/position consistency (#40), pgvector Unsupported annotation (#36), card paralelo unique constraint (#37)
