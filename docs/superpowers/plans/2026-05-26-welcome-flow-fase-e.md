# Welcome Flow Fase E — Asignación interna por opção — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cuando welcome flow rotea por categoria, atribuir a conversação a un funcionário específico (sin alterar el chat público). Cliente sigue en el mismo número/chat; internamente la conversação tem `assignedAgentId` setado, notificação vai pro responsável, badge "→ Funcionário" aparece no card kanban.

**Architecture:** Estender `WelcomeOption` com `targetUserId` (FK a User, opcional). `applyTagWithRouting` aceita parâmetro `assignAgentId` opcional e faz `conversation.update({ assignedAgentId })`. Welcome worker passa `option.targetUserId` quando matchea. Fallback path usa `WelcomeFlow.fallbackUserId` quando configurado. UI editor ganha select "Atribuir a" por opção. Backward-compat: campos nullable; flows existentes não atribuem se não tiverem targetUserId.

**Tech Stack:** Prisma 6 + Hono + Zod (api), Next.js + react-query + shadcn Select (web), Vitest.

**Spec base:** Discussão em chat 2026-05-26 sobre derivação interna (sin link wa.me). Welcome flow A-D já em main.

---

## File Structure

### Schema
- Modify: `packages/database/prisma/schema.prisma` — add `WelcomeOption.targetUserId String?` + `WelcomeFlow.fallbackUserId String?` + relações back em `User`

### API
- Modify: `apps/api/src/services/auto-routing.ts` — `applyTagWithRouting` aceita `assignAgentId?: string | null`, faz `conversation.update({ assignedAgentId })` + publishEvent `conversation.assigned`
- Modify: `apps/api/src/welcome-worker.ts` — passa `option.targetUserId` em `applyTagWithRouting`
- Modify: `apps/api/src/services/welcome-flow.ts` — `markFailed` passa `flow.fallbackUserId` em `applyTagWithRouting`
- Modify: `apps/api/src/routes/welcome-flows.ts` — `optionUpsertSchema` ganha `targetUserId`; flow schemas ganham `fallbackUserId`; validação membership existe
- Modify: `apps/api/src/routes/welcome-presets.ts` — `apply-preset` aceita resolve de `targetUserName` por nome

### Shared
- Modify: `packages/shared/src/welcome-presets.ts` — `WelcomePresetOption` ganha `targetUserName?: string`; presets podem sugerir usuários por nome (ex: agro preset → Ariel/Marcos/Diego)

### Web
- Modify: `apps/web/src/components/settings/welcome-flow-options-editor.tsx` — adicionar select "Atribuir a" por linha
- Modify: `apps/web/src/app/(app)/settings/welcome-flows/[inboxId]/page.tsx` — select "Atribuir fallback a" na sessão fallback; carregar lista de members do workspace

### Tests
- Modify: `apps/api/tests/auto-routing.test.ts` — adicionar tests pra assignAgentId
- Modify: `apps/api/tests/welcome-flow.test.ts` — adicionar test pra markFailed com fallbackUserId
- Modify: `apps/api/tests/welcome-flows-route.test.ts` — adicionar test pra targetUserId membership validation

---

## Task 1: Schema migration — targetUserId + fallbackUserId

**Files:**
- Modify: `packages/database/prisma/schema.prisma`

- [ ] **Step 1: Adicionar campos no schema**

Localizar `model WelcomeOption` (linha ~1255) e adicionar campo + relação:

```prisma
model WelcomeOption {
  id              String   @id @default(cuid())
  flowId          String
  position        Int
  label           String
  description     String?
  matchKeywords   String[]
  targetLabelId   String
  targetFunnelId  String?
  targetStageId   String?
  targetUserId    String?
  createdAt       DateTime @default(now())

  flow         WelcomeFlow @relation(fields: [flowId], references: [id], onDelete: Cascade)
  targetLabel  Label       @relation("WelcomeOptionLabel", fields: [targetLabelId], references: [id], onDelete: Restrict)
  targetFunnel Funnel?     @relation("WelcomeOptionFunnel", fields: [targetFunnelId], references: [id], onDelete: SetNull)
  targetStage  Stage?      @relation("WelcomeOptionStage", fields: [targetStageId], references: [id], onDelete: SetNull)
  targetUser   User?       @relation("WelcomeOptionTargetUser", fields: [targetUserId], references: [id], onDelete: SetNull)

  @@unique([flowId, position])
  @@index([flowId])
  @@map("welcome_options")
}
```

Localizar `model WelcomeFlow` (próximo, linha ~1212) e adicionar:

```prisma
  fallbackUserId String?
  fallbackUser   User?   @relation("WelcomeFlowFallbackUser", fields: [fallbackUserId], references: [id], onDelete: SetNull)
```

Em `model User` (linha ~124), adicionar relações back:

```prisma
  welcomeOptionsTargetingMe WelcomeOption[] @relation("WelcomeOptionTargetUser")
  welcomeFlowsFallbackToMe  WelcomeFlow[]   @relation("WelcomeFlowFallbackUser")
```

- [ ] **Step 2: Gerar migration**

```bash
cd packages/database
export PATH="$HOME/.node22-portable/node-v22.13.1-win-x64:$PATH"
pnpm prisma migrate dev --name add_welcome_target_user
```

Expected: cria migration com `ALTER TABLE "welcome_options" ADD COLUMN "targetUserId" TEXT;` + FK constraint + idem para welcome_flows.fallbackUserId.

**ATENÇÃO**: revisar SQL gerado antes — se Prisma propor DROP de algo (pgvector drift), limpar manualmente igual fizemos em Fase A/B.

- [ ] **Step 3: Regenerar client**

```bash
pnpm prisma generate
```

- [ ] **Step 4: Typecheck**

```bash
cd ../..
pnpm --filter @neura/database typecheck
pnpm --filter @neura/api typecheck
pnpm --filter @neura/web typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/
git commit -m "feat(db): adiciona WelcomeOption.targetUserId + WelcomeFlow.fallbackUserId"
```

---

## Task 2: applyTagWithRouting aceita assignAgentId

**Files:**
- Modify: `apps/api/src/services/auto-routing.ts`
- Modify: `apps/api/tests/auto-routing.test.ts`

- [ ] **Step 1: Escrever test falhando**

Em `apps/api/tests/auto-routing.test.ts`, no `describe('applyTagWithRouting', ...)`, adicionar:

```typescript
  it('atribui conversa ao assignAgentId quando passado', async () => {
    // Criar user + membership pro workspace
    const user = await prisma.user.create({
      data: { email: 'ariel@test.com', name: 'Ariel' },
    });
    await prisma.membership.create({
      data: { userId: user.id, workspaceId, role: 'AGENT' },
    });

    await applyTagWithRouting({
      workspaceId,
      conversationId,
      labelId,
      source: 'welcome_flow',
      assignAgentId: user.id,
    });

    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { assignedAgentId: true },
    });
    expect(conv?.assignedAgentId).toBe(user.id);

    // cleanup pra próximos tests
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { assignedAgentId: null },
    });
    await prisma.membership.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });

  it('não modifica assignedAgentId quando assignAgentId é null/undefined', async () => {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { assignedAgentId: null },
    });

    await applyTagWithRouting({
      workspaceId,
      conversationId,
      labelId,
      source: 'welcome_flow',
    });

    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { assignedAgentId: true },
    });
    expect(conv?.assignedAgentId).toBeNull();
  });
```

- [ ] **Step 2: Rodar test para confirmar falha**

```bash
cd apps/api
export PATH="$HOME/.node22-portable/node-v22.13.1-win-x64:$PATH"
export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5435/neura_ai'
export REDIS_URL='redis://127.0.0.1:6379'
./node_modules/.bin/vitest run tests/auto-routing.test.ts
```

Expected: 2 testes falhando — `applyTagWithRouting` não aceita `assignAgentId`.

- [ ] **Step 3: Implementar mudança**

Em `apps/api/src/services/auto-routing.ts`:

```typescript
interface ApplyTagParams {
  workspaceId: string;
  conversationId: string;
  labelId: string;
  source: RoutingSource;
  actorId?: string | null;
  assignAgentId?: string | null;
}

export async function applyTagWithRouting(params: ApplyTagParams): Promise<void> {
  const { workspaceId, conversationId, labelId, source, actorId = null, assignAgentId } = params;

  // ...código existente até depois do publishEvent label_applied...

  // Atribuir agente se especificado (NOVO)
  if (assignAgentId) {
    // Validar que user é member do workspace antes de atribuir
    const member = await prisma.membership.findFirst({
      where: { userId: assignAgentId, workspaceId },
      select: { id: true },
    });
    if (member) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { assignedAgentId: assignAgentId },
      });
      await publishEvent(workspaceId, 'conversations', 'conversation.assigned', {
        conversationId,
        assignedAgentId: assignAgentId,
        reason: source,
      });
    } else {
      logger.warn(
        { workspaceId, conversationId, assignAgentId },
        'applyTagWithRouting: assignAgentId not member of workspace, skipping assignment',
      );
    }
  }

  // ...resto do código (card creation etc) continua igual...
}
```

Inserir o bloco de atribuição DEPOIS do `publishEvent` de label_applied e ANTES do `if (label.routesToFunnelId ...)` que cria o card.

- [ ] **Step 4: Rodar testes**

```bash
./node_modules/.bin/vitest run tests/auto-routing.test.ts
```

Expected: PASS (todos os testes existentes + os 2 novos).

- [ ] **Step 5: Typecheck**

```bash
cd ../..
pnpm --filter @neura/api typecheck
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/auto-routing.ts apps/api/tests/auto-routing.test.ts
git commit -m "feat(auto-routing): aceita assignAgentId opcional + validação membership"
```

---

## Task 3: Welcome worker passa option.targetUserId

**Files:**
- Modify: `apps/api/src/welcome-worker.ts`

- [ ] **Step 1: Adicionar targetUserId no select da option lookup**

Localizar `prisma.welcomeFlow.findUnique` em `handleParseReply` (~linha 91):

```typescript
  const flow = await prisma.welcomeFlow.findUnique({
    where: { inboxId: conv.inboxId },
    include: { options: { orderBy: { position: 'asc' } } },
  });
```

Já inclui `options` completas → `targetUserId` já vem no objeto. Confirmar com grep.

- [ ] **Step 2: Passar targetUserId em applyTagWithRouting**

Localizar a chamada de `applyTagWithRouting` no welcome-worker (~linha 155):

```typescript
  if (match) {
    const fullOpt = flow.options.find((o) => o.id === match.id);
    if (fullOpt) {
      await applyTagWithRouting({
        workspaceId,
        conversationId,
        labelId: fullOpt.targetLabelId,
        source: 'welcome_flow',
        assignAgentId: fullOpt.targetUserId,
      });
    }
    // ...
  }
```

Adicionar `assignAgentId: fullOpt.targetUserId` na chamada.

- [ ] **Step 3: Typecheck**

```bash
export PATH="$HOME/.node22-portable/node-v22.13.1-win-x64:$PATH"
pnpm --filter @neura/api typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/welcome-worker.ts
git commit -m "feat(welcome-worker): passa option.targetUserId pra atribuir agente na rota"
```

---

## Task 4: Welcome-flow markFailed usa fallbackUserId

**Files:**
- Modify: `apps/api/src/services/welcome-flow.ts`
- Modify: `apps/api/tests/welcome-flow.test.ts`

- [ ] **Step 1: Atualizar markFailed pra incluir fallbackUserId**

Em `apps/api/src/services/welcome-flow.ts`, localizar `markFailed` (~linha 220) onde busca o flow:

```typescript
  const flow = await prisma.welcomeFlow.findUnique({
    where: { inboxId: conv.inboxId },
    select: { fallbackLabelId: true, fallbackUserId: true },
  });
```

Adicionar `fallbackUserId` no select.

E na chamada de `applyTagWithRouting` dentro de `markFailed`:

```typescript
  if (flow?.fallbackLabelId) {
    await applyTagWithRouting({
      workspaceId,
      conversationId,
      labelId: flow.fallbackLabelId,
      source: 'welcome_flow',
      assignAgentId: flow.fallbackUserId,
    });
  }
```

- [ ] **Step 2: Adicionar test pra markFailed com fallbackUserId**

Em `apps/api/tests/welcome-flow.test.ts`, no `describe('markFailed', ...)`, adicionar:

```typescript
  it('atribui conversa ao fallbackUserId se configurado', async () => {
    const user = await prisma.user.create({
      data: { email: 'ariel-fallback@test.com', name: 'Ariel Fallback' },
    });
    await prisma.membership.create({
      data: { userId: user.id, workspaceId, role: 'AGENT' },
    });

    await prisma.welcomeFlow.update({
      where: { id: flowId },
      data: { fallbackLabelId: labelId, fallbackUserId: user.id },
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { isAwaitingWelcomeChoice: true, welcomeAttempts: 2 },
    });

    await markFailed({ workspaceId, conversationId });

    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { assignedAgentId: true },
    });
    expect(conv?.assignedAgentId).toBe(user.id);

    // cleanup
    await prisma.welcomeFlow.update({
      where: { id: flowId },
      data: { fallbackLabelId: null, fallbackUserId: null },
    });
    await prisma.membership.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });
```

- [ ] **Step 3: Rodar tests**

```bash
cd apps/api
export PATH="$HOME/.node22-portable/node-v22.13.1-win-x64:$PATH"
export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5435/neura_ai'
export REDIS_URL='redis://127.0.0.1:6379'
./node_modules/.bin/vitest run tests/welcome-flow.test.ts
```

Expected: PASS (incluindo o test novo).

- [ ] **Step 4: Commit**

```bash
cd ../..
git add apps/api/src/services/welcome-flow.ts apps/api/tests/welcome-flow.test.ts
git commit -m "feat(welcome-flow): markFailed atribui fallbackUserId quando configurado"
```

---

## Task 5: Routes welcome-flows estende schemas Zod

**Files:**
- Modify: `apps/api/src/routes/welcome-flows.ts`

- [ ] **Step 1: Estender schemas Zod**

Em `apps/api/src/routes/welcome-flows.ts`:

```typescript
const flowUpsertSchema = z.object({
  prompt: z.string().min(1).max(2_000),
  fallbackLabelId: z.string().nullable().optional(),
  fallbackFunnelId: z.string().nullable().optional(),
  fallbackStageId: z.string().nullable().optional(),
  fallbackUserId: z.string().nullable().optional(),
  fallbackTimeoutMinutes: z.number().int().min(0).max(60).default(2),
  maxAttempts: z.number().int().min(1).max(10).default(2),
  enabled: z.boolean().default(true),
});

const optionUpsertSchema = z.object({
  position: z.number().int().min(1).max(10),
  label: z.string().min(1).max(60),
  description: z.string().max(120).nullable().optional(),
  matchKeywords: z.array(z.string().min(1).max(40)).max(10).default([]),
  targetLabelId: z.string().min(1),
  targetFunnelId: z.string().nullable().optional(),
  targetStageId: z.string().nullable().optional(),
  targetUserId: z.string().nullable().optional(),
});
```

- [ ] **Step 2: Adicionar validação cruzada (user é member do workspace)**

Criar helper no mesmo arquivo, após `assertFlowInWorkspace`:

```typescript
async function assertUserInWorkspace(
  userId: string | null | undefined,
  workspaceId: string,
): Promise<boolean> {
  if (!userId) return true; // null is OK (nem todos opções precisam ter user)
  const member = await prisma.membership.findFirst({
    where: { userId, workspaceId },
    select: { id: true },
  });
  return !!member;
}
```

Em todos os handlers POST/PUT que aceitam `targetUserId` ou `fallbackUserId`, após o `parsed.success` check e antes do `create`/`update`:

```typescript
if (parsed.data.targetUserId && !(await assertUserInWorkspace(parsed.data.targetUserId, workspaceId))) {
  return c.json({ error: 'user_not_in_workspace' }, 400);
}
```

Para flow upsert handlers, aplicar a `fallbackUserId` em vez:

```typescript
if (parsed.data.fallbackUserId && !(await assertUserInWorkspace(parsed.data.fallbackUserId, workspaceId))) {
  return c.json({ error: 'fallback_user_not_in_workspace' }, 400);
}
```

Adicionar nas funções:
- `POST /inboxes/:inboxId/welcome-flow` (fallbackUserId)
- `PUT /inboxes/:inboxId/welcome-flow` (fallbackUserId)
- `POST /welcome-flows/:flowId/options` (targetUserId)
- `PUT /welcome-flows/:flowId/options/:optionId` (targetUserId)

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @neura/api typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/welcome-flows.ts
git commit -m "feat(api): welcome-flows routes aceitam targetUserId/fallbackUserId + validação membership"
```

---

## Task 6: Welcome presets ganham targetUserName

**Files:**
- Modify: `packages/shared/src/welcome-presets.ts`
- Modify: `apps/api/src/routes/welcome-presets.ts`

- [ ] **Step 1: Adicionar campo targetUserName no preset interface**

Em `packages/shared/src/welcome-presets.ts`:

```typescript
export interface WelcomePresetOption {
  position: number;
  label: string;
  description?: string;
  matchKeywords: string[];
  targetLabelName: string;
  targetFunnelName?: string;
  targetStageName?: string;
  targetUserName?: string;
}

export interface WelcomePreset {
  id: string;
  name: string;
  description: string;
  prompt: string;
  fallbackLabelName?: string;
  fallbackFunnelName?: string;
  fallbackUserName?: string;
  options: WelcomePresetOption[];
}
```

- [ ] **Step 2: Adicionar preset de drones agrícolas**

Adicionar ao array `WELCOME_PRESETS` (depois do `agency`):

```typescript
  {
    id: 'drones-agro',
    name: 'Drones agrícolas',
    description: 'Venda + manutenção de drones para pulverização, siembra e monitoreo',
    prompt: 'Olá {{contact.name}}! Bem-vindo. Como podemos te ajudar?',
    fallbackLabelName: 'Lead',
    fallbackUserName: 'Ariel',
    options: [
      {
        position: 1,
        label: 'Comprar drone',
        description: 'Quero adquirir um equipamento',
        matchKeywords: ['comprar', 'orçamento', 'preço', 'cotação'],
        targetLabelName: 'Vendas',
        targetFunnelName: 'Vendas',
        targetStageName: 'Novo lead',
        targetUserName: 'Ariel',
      },
      {
        position: 2,
        label: 'Conhecer / saber mais',
        description: 'Quero entender como funciona',
        matchKeywords: ['informação', 'saber', 'conhecer', 'detalhes'],
        targetLabelName: 'Lead',
        targetFunnelName: 'Lead',
        targetStageName: 'Triagem',
        targetUserName: 'Ariel',
      },
      {
        position: 3,
        label: 'Manutenção preventiva',
        description: 'Revisão do meu equipamento',
        matchKeywords: ['manutenção', 'revisão', 'check'],
        targetLabelName: 'Manutenção',
        targetFunnelName: 'Manutenção',
        targetStageName: 'Solicitação',
        targetUserName: 'Marcos',
      },
      {
        position: 4,
        label: 'Reparação / falha',
        description: 'Meu drone parou de funcionar',
        matchKeywords: ['quebrou', 'falha', 'reparo', 'conserto', 'problema'],
        targetLabelName: 'Reparação',
        targetFunnelName: 'Reparação',
        targetStageName: 'Diagnóstico',
        targetUserName: 'Diego',
      },
    ],
  },
```

- [ ] **Step 3: Atualizar apply-preset endpoint pra resolver targetUserName**

Em `apps/api/src/routes/welcome-presets.ts`, no handler `apply-preset`, depois da resolução de labels/funnels:

```typescript
    // Resolve targetUserName por nome (case-insensitive, busca members do workspace via User.name)
    const userNamesNeeded = new Set<string>();
    for (const opt of preset.options) {
      if (opt.targetUserName) userNamesNeeded.add(opt.targetUserName);
    }
    if (preset.fallbackUserName) userNamesNeeded.add(preset.fallbackUserName);

    const memberships = await prisma.membership.findMany({
      where: { workspaceId },
      include: { user: { select: { id: true, name: true } } },
    });
    const userByName = new Map<string, string>();
    for (const m of memberships) {
      if (m.user.name) userByName.set(m.user.name.toLowerCase(), m.user.id);
    }
```

E na criação do flow:

```typescript
    const flow = await prisma.welcomeFlow.create({
      data: {
        // ...campos existentes...
        fallbackUserId: preset.fallbackUserName
          ? userByName.get(preset.fallbackUserName.toLowerCase()) ?? null
          : null,
        options: {
          create: preset.options.map((opt) => {
            // ...lookup label/funnel/stage como antes...
            return {
              position: opt.position,
              label: opt.label,
              description: opt.description ?? null,
              matchKeywords: opt.matchKeywords,
              targetLabelId: label.id,
              targetFunnelId: funnelId ?? null,
              targetStageId: stageId ?? null,
              targetUserId: opt.targetUserName
                ? userByName.get(opt.targetUserName.toLowerCase()) ?? null
                : null,
            };
          }),
        },
      },
      // ...
    });
```

**Importante**: se `targetUserName` aparece no preset mas nenhum member do workspace tem esse nome → `targetUserId = null` (silencioso, fallback). Admin pode editar depois.

- [ ] **Step 4: Typecheck + build shared**

```bash
pnpm --filter @neura/shared build
pnpm --filter @neura/api typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/welcome-presets.ts apps/api/src/routes/welcome-presets.ts
git commit -m "feat(presets): adiciona drones-agro preset + targetUserName resolution"
```

---

## Task 7: UI editor — select "Atribuir a" por opção

**Files:**
- Modify: `apps/web/src/components/settings/welcome-flow-options-editor.tsx`
- Modify: `apps/web/src/app/(app)/settings/welcome-flows/[inboxId]/page.tsx`

- [ ] **Step 1: Estender props do options editor**

Em `apps/web/src/components/settings/welcome-flow-options-editor.tsx`, adicionar interface:

```typescript
interface MemberOpt {
  id: string;
  name: string | null;
  email: string;
}

interface Props {
  flowId: string;
  options: WelcomeOption[];
  labels: LabelOpt[];
  funnels: FunnelOpt[];
  members: MemberOpt[];
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
  targetUserId: string | null;
}
```

E em `SortableOptionRow`, adicionar `members` prop + select novo (após o grid de 3 selects atual):

```typescript
        <div className="space-y-1">
          <Label className="text-xs">Atribuir a</Label>
          <Select
            value={option.targetUserId ?? 'none'}
            onValueChange={(v) => onUpdate({ targetUserId: v === 'none' ? null : v })}
          >
            <SelectTrigger>
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Ninguém (manual)</SelectItem>
              {members.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name ?? m.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
```

Adicionar `members` no destructure de Props e passar pra `SortableOptionRow`.

- [ ] **Step 2: Buscar members + passar pro editor**

Em `apps/web/src/app/(app)/settings/welcome-flows/[inboxId]/page.tsx`, junto com outras queries:

```typescript
const { data: membersData } = useQuery<{ members: MemberOpt[] }>({
  queryKey: ['workspace-members'],
  queryFn: () => api('/api/workspaces/current/members'),
});

interface MemberOpt {
  id: string;
  name: string | null;
  email: string;
}
```

E passar pra `WelcomeFlowOptionsEditor`:

```typescript
{hasFlow && labelsData && funnelsData && membersData && (
  <WelcomeFlowOptionsEditor
    flowId={data.flow.id}
    options={data.flow.options}
    labels={labelsData.labels}
    funnels={funnelsData.funnels}
    members={membersData.members}
  />
)}
```

**Verificar endpoint**: `GET /api/workspaces/current/members` ou similar pra listar members do workspace ativo. Se não existir com esse path, procurar em `apps/api/src/routes/workspaces.ts` o nome real (pode ser `/api/workspaces/:id/members` ou retornado em `/api/workspaces/current`).

- [ ] **Step 3: Adicionar fallback user select na sessão fallback**

Em mesma página, na seção fallback (depois do fallback label/funnel/stage), adicionar:

```typescript
<div className="space-y-2">
  <Label>Atribuir fallback a</Label>
  <Select
    value={watch('fallbackUserId') ?? 'none'}
    onValueChange={(v) => setValue('fallbackUserId', v === 'none' ? null : v)}
  >
    <SelectTrigger>
      <SelectValue placeholder="Ninguém" />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="none">Ninguém</SelectItem>
      {membersData?.members.map((m) => (
        <SelectItem key={m.id} value={m.id}>
          {m.name ?? m.email}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
  <p className="text-xs text-muted-foreground">
    Se nenhuma opção matchear após N attempts, atribui a este usuário.
  </p>
</div>
```

E estender `flowSchema`:

```typescript
const flowSchema = z.object({
  prompt: z.string().min(1).max(2_000),
  enabled: z.boolean(),
  fallbackLabelId: z.string().nullable(),
  fallbackFunnelId: z.string().nullable(),
  fallbackStageId: z.string().nullable(),
  fallbackUserId: z.string().nullable(),
  fallbackTimeoutMinutes: z.number().int().min(0).max(60),
  maxAttempts: z.number().int().min(1).max(10),
});
```

E nos `values` da useForm, adicionar `fallbackUserId: data.flow.fallbackUserId` quando hasFlow + `fallbackUserId: null` nos defaultValues.

- [ ] **Step 4: Typecheck**

```bash
./apps/web/node_modules/.bin/tsc -p apps/web --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/welcome-flow-options-editor.tsx apps/web/src/app/\(app\)/settings/welcome-flows/\[inboxId\]/page.tsx
git commit -m "feat(web): editor options + fallback ganham select 'Atribuir a'"
```

---

## Task 8: Build final + smoke

**Files:** nenhum (validação)

- [ ] **Step 1: Build full**

```bash
export PATH="$HOME/.node22-portable/node-v22.13.1-win-x64:$PATH"
pnpm build
```

Expected: PASS 5/5.

- [ ] **Step 2: Tests**

```bash
DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5435/neura_ai' \
REDIS_URL='redis://127.0.0.1:6379' \
pnpm --filter @neura/api test
```

Expected: PASS — 38 testes existentes + 3 testes novos (assignAgentId, assignAgentId null, markFailed fallbackUserId).

- [ ] **Step 3: Typecheck full**

```bash
pnpm typecheck
```

- [ ] **Step 4: Commit final se necessário**

```bash
git add -A
git commit -m "chore(welcome-flow-fase-e): ajustes finais lint/typecheck" 2>/dev/null || true
```

---

## Critérios de Aceite — Fase E

- [ ] `pnpm build` PASS
- [ ] `pnpm test` PASS — 41+ testes verde
- [ ] Editor options tem select "Atribuir a" mostrando members do workspace
- [ ] Editor fallback tem select "Atribuir fallback a"
- [ ] Aplicar opção do welcome flow com `targetUserId` configurado → `Conversation.assignedAgentId` setado + WS `conversation.assigned` publicado
- [ ] Welcome falhado com `fallbackUserId` configurado → atribui ao usuário fallback
- [ ] Preset drones-agro cria flow com options atribuídas a Ariel/Marcos/Diego (se esses members existirem no workspace)
- [ ] Tentar setar `targetUserId` de user que não é member → 400 `user_not_in_workspace`
- [ ] Side panel mostra "Atribuído: <nome>" quando carrega conversa atribuída

## Refs

- Fase A-D já mergeada em main
- Schema `Conversation.assignedAgentId` já existe (campo pré-existente)
- WS event `conversation.assigned` já existe (do código de bulk assign)
