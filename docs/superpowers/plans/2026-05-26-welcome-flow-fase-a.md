# Welcome Flow Fase A — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar o backend do welcome flow interativo: schema, services, BullMQ workers, hooks no waworker, e testes. Sem UI ainda (Fase B).

**Architecture:** Quando chega primeira mensagem inbound dum cliente novo numa inbox que tem WelcomeFlow habilitado, o waworker enfileira job `welcome-process:trigger`. Worker BullMQ no api side processa: envia listMessage interativo via outbound queue, marca conversa awaiting. Quando cliente responde, parser identifica opção via número/keyword/fuzzy OpenAI, aplica tag e cria card no funil destino. Worker cron faz fallback a texto plano após timeout, e fallback humano após N attempts.

**Tech Stack:** Prisma 6 (Postgres + pgvector), Hono 4, BullMQ 5 com Redis 7, ioredis, OpenAI SDK, Vitest, Baileys (waworker), TypeScript 5.7.

**Spec base:** `docs/superpowers/specs/2026-05-26-welcome-flow-autorouting-design.md`

---

## File Structure

### Schema (Prisma)

- Modify: `packages/database/prisma/schema.prisma` — novos models `WelcomeFlow`, `WelcomeOption`; colunas novas em `Contact`, `Conversation`, `Label`, `Message`, `Workspace`; novo enum `MessageSender`.

### Shared types

- Modify: `packages/shared/src/queue.ts` — extender `SendMessageJob.type` com `'INTERACTIVE'`, add `interactiveOptions` field; novo `QUEUE_WELCOME_PROCESS` constant e `WelcomeProcessJob` interface.

### API services (lógica core)

- Create: `apps/api/src/services/auto-routing.ts` — aplica tag + cria card em funil destino.
- Create: `apps/api/src/services/welcome-flow.ts` — `shouldTriggerWelcome`, `sendWelcome`, `retryAsText`, `markCompleted`, `markFailed`.
- Create: `apps/api/src/services/welcome-parser.ts` — parseReply (número/keyword/exact/fuzzy).

### API workers (BullMQ + cron)

- Create: `apps/api/src/welcome-worker.ts` — consumer BullMQ da queue `welcome-process`.
- Create: `apps/api/src/welcome-scheduler.ts` — cron 30s para timeout fallback.

### API routes (hook leve em route existente)

- Modify: `apps/api/src/routes/messages.ts` — quando inbound chega com `conversation.isAwaitingWelcomeChoice`, rotear pra welcome parser via queue.

### API boot

- Modify: `apps/api/src/index.ts` — importar `welcomeWorker` e `startWelcomeScheduler`.

### Waworker

- Modify: `apps/waworker/src/baileys/events.ts` — após `persistInboundMessage`, detectar primeira mensagem inbound de contato sem `welcomeRespondedAt` em inbox com flow habilitado, enfileirar job em `welcome-process`. Também: detectar `buttonReply` / `listResponseMessage` e mapear pro Message normal.
- Modify: `apps/waworker/src/queue/outbound.ts` — handler novo pra `type === 'INTERACTIVE'` que monta listMessage via Baileys.
- Create: `apps/waworker/src/welcome-trigger.ts` — helper `enqueueWelcomeProcess(payload)` que conecta ao Redis e adiciona job em `welcome-process` queue.

### Constants

- Modify: `apps/api/src/services/audit.ts` — adicionar constantes de actions (`welcome.triggered`, `welcome.completed`, `welcome.failed`, `card.auto_routed`).

### Tests

- Create: `apps/api/tests/welcome-parser.test.ts` — unit.
- Create: `apps/api/tests/auto-routing.test.ts` — unit.
- Create: `apps/api/tests/welcome-flow.test.ts` — unit.
- Create: `apps/api/tests/integration/welcome-flow.test.ts` — integration end-to-end mockado.

---

## Task 1: Migration Prisma — schema novo

**Files:**

- Modify: `packages/database/prisma/schema.prisma`

- [ ] **Step 1: Adicionar enum `MessageSender` e estender model `Message`**

Editar `packages/database/prisma/schema.prisma`. Logo antes do `enum MessageDirection` adicionar:

```prisma
enum MessageSender {
  CUSTOMER
  AGENT
  AI_AGENT
  SYSTEM
}
```

E no model `Message`, adicionar a coluna nova logo após o último campo escalar e antes das relações:

```prisma
  senderType MessageSender @default(CUSTOMER)
```

- [ ] **Step 2: Adicionar colunas em `Contact`, `Conversation`, `Label`**

No model `Contact`, adicionar:

```prisma
  welcomeRespondedAt DateTime?
```

No model `Conversation`, adicionar:

```prisma
  isAwaitingWelcomeChoice Boolean   @default(false)
  welcomeAttempts         Int       @default(0)
  welcomeFallbackSent     Boolean   @default(false)
  welcomeSentAt           DateTime?
```

No model `Label`, adicionar (entre os campos escalares):

```prisma
  routesToFunnelId String?
  routesToStageId  String?
```

E nas relações do `Label`:

```prisma
  routesToFunnel Funnel? @relation("LabelRoutesToFunnel", fields: [routesToFunnelId], references: [id], onDelete: SetNull)
  routesToStage  Stage?  @relation("LabelRoutesToStage", fields: [routesToStageId], references: [id], onDelete: SetNull)
```

No model `Funnel`, adicionar relação back:

```prisma
  routedFromLabels Label[] @relation("LabelRoutesToFunnel")
```

No model `Stage`, adicionar relação back:

```prisma
  routedFromLabels Label[] @relation("LabelRoutesToStage")
```

No model `Workspace`, adicionar:

```prisma
  aiAgentName       String  @default("Agente IA")
  aiAgentAvatarUrl  String?
```

- [ ] **Step 3: Adicionar models `WelcomeFlow` e `WelcomeOption`**

No final do schema, antes do último `@@map`:

```prisma
model WelcomeFlow {
  id                     String   @id @default(cuid())
  workspaceId            String
  inboxId                String   @unique
  prompt                 String   @db.Text
  fallbackLabelId        String?
  fallbackFunnelId       String?
  fallbackStageId        String?
  fallbackTimeoutMinutes Int      @default(2)
  maxAttempts            Int      @default(2)
  enabled                Boolean  @default(true)
  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt

  workspace      Workspace       @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  inbox          Inbox           @relation(fields: [inboxId], references: [id], onDelete: Cascade)
  fallbackLabel  Label?          @relation("WelcomeFlowFallbackLabel", fields: [fallbackLabelId], references: [id], onDelete: SetNull)
  fallbackFunnel Funnel?         @relation("WelcomeFlowFallbackFunnel", fields: [fallbackFunnelId], references: [id], onDelete: SetNull)
  fallbackStage  Stage?          @relation("WelcomeFlowFallbackStage", fields: [fallbackStageId], references: [id], onDelete: SetNull)
  options        WelcomeOption[]

  @@index([workspaceId])
  @@map("welcome_flows")
}

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
  createdAt       DateTime @default(now())

  flow         WelcomeFlow @relation(fields: [flowId], references: [id], onDelete: Cascade)
  targetLabel  Label       @relation("WelcomeOptionLabel", fields: [targetLabelId], references: [id], onDelete: Restrict)
  targetFunnel Funnel?     @relation("WelcomeOptionFunnel", fields: [targetFunnelId], references: [id], onDelete: SetNull)
  targetStage  Stage?      @relation("WelcomeOptionStage", fields: [targetStageId], references: [id], onDelete: SetNull)

  @@unique([flowId, position])
  @@index([flowId])
  @@map("welcome_options")
}
```

Adicionar relações back nos models `Inbox`, `Label`, `Funnel`, `Stage`, `Workspace`:

```prisma
// Em Workspace:
welcomeFlows WelcomeFlow[]

// Em Inbox:
welcomeFlow WelcomeFlow?

// Em Label (existente):
welcomeOptionsAsTarget WelcomeOption[] @relation("WelcomeOptionLabel")
welcomeFlowFallback    WelcomeFlow[]   @relation("WelcomeFlowFallbackLabel")

// Em Funnel:
welcomeOptionsAsTarget WelcomeOption[] @relation("WelcomeOptionFunnel")
welcomeFlowFallback    WelcomeFlow[]   @relation("WelcomeFlowFallbackFunnel")

// Em Stage:
welcomeOptionsAsTarget WelcomeOption[] @relation("WelcomeOptionStage")
welcomeFlowFallback    WelcomeFlow[]   @relation("WelcomeFlowFallbackStage")
```

- [ ] **Step 4: Gerar migration**

```bash
cd packages/database
pnpm prisma migrate dev --name add_welcome_flow_and_routing
```

Expected: cria arquivo em `prisma/migrations/<timestamp>_add_welcome_flow_and_routing/migration.sql` com os DDL changes, e roda contra DB local automaticamente.

- [ ] **Step 5: Regenerar client**

```bash
pnpm db:generate
```

Expected: regenera `packages/database/generated/client` com os novos models e tipos.

- [ ] **Step 6: Commit**

```bash
cd ../..
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/
git commit -m "feat(db): adiciona welcome flow schema (models + colunas + enum MessageSender)"
```

---

## Task 2: Audit action constants

**Files:**

- Modify: `apps/api/src/services/audit.ts`

- [ ] **Step 1: Adicionar exports de actions**

No final de `apps/api/src/services/audit.ts`, antes do EOF:

```typescript
// Welcome flow + auto-routing actions
export const AUDIT_ACTIONS = {
  WELCOME_TRIGGERED: 'welcome.triggered',
  WELCOME_COMPLETED: 'welcome.completed',
  WELCOME_FAILED: 'welcome.failed',
  WELCOME_FALLBACK_SENT: 'welcome.fallback_sent',
  CARD_AUTO_ROUTED: 'card.auto_routed',
} as const;
```

- [ ] **Step 2: Verificar build typecheck**

```bash
pnpm --filter @neura/api typecheck
```

Expected: PASS (sem erros).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/audit.ts
git commit -m "feat(audit): adiciona constantes de actions pro welcome flow"
```

---

## Task 3: Estender SendMessageJob + adicionar WelcomeProcessJob

**Files:**

- Modify: `packages/shared/src/queue.ts`

- [ ] **Step 1: Estender SendMessageJob.type com INTERACTIVE**

Em `packages/shared/src/queue.ts`, no campo `type` do `SendMessageJob`:

```typescript
// ANTES:
type: 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT';

// DEPOIS:
type: 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'INTERACTIVE';
```

E adicionar novo campo opcional:

```typescript
  /** Para type === 'INTERACTIVE': estrutura do listMessage do Baileys */
  interactivePayload?: {
    title: string;          // header do listMessage
    body: string;           // texto principal (o prompt)
    footer?: string;        // footer opcional
    buttonText: string;     // label do botão que abre a lista (ex: "Ver opções")
    options: Array<{
      rowId: string;        // = WelcomeOption.id
      title: string;        // = WelcomeOption.label
      description?: string; // = WelcomeOption.description
    }>;
  };
```

- [ ] **Step 2: Adicionar QUEUE_WELCOME_PROCESS + WelcomeProcessJob**

No mesmo arquivo, após `QUEUE_CSAT_SEND`:

```typescript
// Queue de processamento do welcome flow. Producer: waworker (trigger) + api (retry).
// Consumer: welcome-worker no api side.
export const QUEUE_WELCOME_PROCESS = 'welcome-process';

/**
 * Job de processamento do welcome flow. Discriminado por `kind`:
 * - 'trigger': primeira mensagem inbound detectada — checar se deve enviar welcome.
 * - 'parse_reply': cliente respondeu enquanto conversa estava awaiting — parsear opção.
 * - 'retry_text': timeout passou sem reply — reenviar prompt em texto plano.
 * - 'fallback_human': N attempts sem match — aplicar fallback label, liberar pra humano.
 */
export interface WelcomeProcessJob {
  workspaceId: string;
  conversationId: string;
  kind: 'trigger' | 'parse_reply' | 'retry_text' | 'fallback_human';
  /** Para 'parse_reply': Message.id do reply do cliente. */
  messageId?: string;
}
```

- [ ] **Step 3: Build shared package**

```bash
pnpm --filter @neura/shared build
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/queue.ts
git commit -m "feat(shared): adiciona INTERACTIVE type e WelcomeProcessJob no queue contract"
```

---

## Task 4: Service `auto-routing.ts`

**Files:**

- Create: `apps/api/src/services/auto-routing.ts`
- Create: `apps/api/tests/auto-routing.test.ts`

- [ ] **Step 1: Escrever teste falhando**

Criar `apps/api/tests/auto-routing.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { prisma } from '@neura/database';
import { applyTagWithRouting } from '../src/services/auto-routing.js';

let workspaceId: string;
let inboxId: string;
let contactId: string;
let conversationId: string;
let labelId: string;
let funnelId: string;
let stageId: string;

beforeAll(async () => {
  // Cleanup
  await prisma.cardLabel.deleteMany();
  await prisma.card.deleteMany();
  await prisma.conversationLabel.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.stage.deleteMany();
  await prisma.funnel.deleteMany();
  await prisma.label.deleteMany();
  await prisma.inbox.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.workspace.deleteMany();

  const ws = await prisma.workspace.create({
    data: { name: 'Auto-routing Test WS', slug: 'auto-routing-test' },
  });
  workspaceId = ws.id;

  const inbox = await prisma.inbox.create({
    data: { workspaceId, name: 'WA Test', type: 'WHATSAPP', status: 'CONNECTED' },
  });
  inboxId = inbox.id;

  const funnel = await prisma.funnel.create({
    data: { workspaceId, name: 'Vendas' },
  });
  funnelId = funnel.id;

  const stage = await prisma.stage.create({
    data: { funnelId, workspaceId, name: 'Lead', order: 0 },
  });
  stageId = stage.id;

  const label = await prisma.label.create({
    data: {
      workspaceId,
      name: 'Compra',
      color: '#10b981',
      routesToFunnelId: funnelId,
      routesToStageId: stageId,
    },
  });
  labelId = label.id;

  const contact = await prisma.contact.create({
    data: { workspaceId, phoneNumber: '+5511999998888', name: 'Test Contact' },
  });
  contactId = contact.id;

  const conv = await prisma.conversation.create({
    data: { workspaceId, inboxId, contactId, status: 'OPEN' },
  });
  conversationId = conv.id;
});

afterEach(async () => {
  await prisma.cardLabel.deleteMany();
  await prisma.card.deleteMany();
  await prisma.conversationLabel.deleteMany();
});

describe('applyTagWithRouting', () => {
  it('aplica label na conversa', async () => {
    await applyTagWithRouting({
      workspaceId,
      conversationId,
      labelId,
      source: 'welcome_flow',
    });

    const links = await prisma.conversationLabel.findMany({ where: { conversationId } });
    expect(links).toHaveLength(1);
    expect(links[0]?.labelId).toBe(labelId);
  });

  it('cria card no funil destino quando label tem routing', async () => {
    await applyTagWithRouting({
      workspaceId,
      conversationId,
      labelId,
      source: 'welcome_flow',
    });

    const cards = await prisma.card.findMany({ where: { conversationId } });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.funnelId).toBe(funnelId);
    expect(cards[0]?.stageId).toBe(stageId);
  });

  it('é idempotente — chamar 2x não cria 2 cards', async () => {
    await applyTagWithRouting({ workspaceId, conversationId, labelId, source: 'welcome_flow' });
    await applyTagWithRouting({ workspaceId, conversationId, labelId, source: 'welcome_flow' });

    const cards = await prisma.card.findMany({ where: { conversationId } });
    expect(cards).toHaveLength(1);
  });

  it('cria card paralelo se label rotear pra outro funil', async () => {
    const funnel2 = await prisma.funnel.create({
      data: { workspaceId, name: 'Suporte' },
    });
    const stage2 = await prisma.stage.create({
      data: { funnelId: funnel2.id, workspaceId, name: 'Triagem', order: 0 },
    });
    const label2 = await prisma.label.create({
      data: {
        workspaceId,
        name: 'Manutenção',
        color: '#f59e0b',
        routesToFunnelId: funnel2.id,
        routesToStageId: stage2.id,
      },
    });

    await applyTagWithRouting({ workspaceId, conversationId, labelId, source: 'welcome_flow' });
    await applyTagWithRouting({
      workspaceId,
      conversationId,
      labelId: label2.id,
      source: 'welcome_flow',
    });

    const cards = await prisma.card.findMany({ where: { conversationId } });
    expect(cards).toHaveLength(2);
    expect(new Set(cards.map((c) => c.funnelId))).toEqual(new Set([funnelId, funnel2.id]));
  });

  it('não cria card se label não tem routing configurado', async () => {
    const labelSemRouting = await prisma.label.create({
      data: { workspaceId, name: 'VIP', color: '#a855f7' },
    });

    await applyTagWithRouting({
      workspaceId,
      conversationId,
      labelId: labelSemRouting.id,
      source: 'manual_tag',
    });

    const cards = await prisma.card.findMany({ where: { conversationId } });
    expect(cards).toHaveLength(0);

    const links = await prisma.conversationLabel.findMany({ where: { conversationId } });
    expect(links).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Rodar teste para confirmar que falha**

```bash
pnpm --filter @neura/api test -- tests/auto-routing.test.ts
```

Expected: FAIL com erro de import `applyTagWithRouting` (módulo não existe).

- [ ] **Step 3: Implementar `apps/api/src/services/auto-routing.ts`**

```typescript
import { prisma } from '../db.js';
import { publishEvent } from '../redis-pub.js';
import { audit, AUDIT_ACTIONS } from './audit.js';
import { logger } from '../logger.js';

type RoutingSource = 'welcome_flow' | 'manual_tag' | 'rule';

interface ApplyTagParams {
  workspaceId: string;
  conversationId: string;
  labelId: string;
  source: RoutingSource;
  actorId?: string | null;
}

/**
 * Aplica label na conversa. Se a label tem routesToFunnelId, cria card no
 * funil+stage destino (idempotente: não cria duplicado se já existe card
 * ativo nesse funil).
 *
 * Source identifica quem disparou — usado em audit log + WS payload.
 */
export async function applyTagWithRouting(params: ApplyTagParams): Promise<void> {
  const { workspaceId, conversationId, labelId, source, actorId = null } = params;

  // 1. Validar que label pertence ao workspace
  const label = await prisma.label.findFirst({
    where: { id: labelId, workspaceId },
    select: { id: true, routesToFunnelId: true, routesToStageId: true, name: true },
  });
  if (!label) {
    logger.warn({ workspaceId, conversationId, labelId }, 'Label not found in workspace');
    return;
  }

  // 2. Aplicar ConversationLabel (idempotente via upsert)
  await prisma.conversationLabel.upsert({
    where: { conversationId_labelId: { conversationId, labelId } },
    create: { conversationId, labelId },
    update: {},
  });

  await publishEvent(workspaceId, 'conversations', 'conversation.label_applied', {
    conversationId,
    labelId,
    labelName: label.name,
    source,
  });

  // 3. Se label rotear, criar card (idempotente: skip se já existe card ativo)
  if (label.routesToFunnelId && label.routesToStageId) {
    const existing = await prisma.card.findFirst({
      where: {
        conversationId,
        funnelId: label.routesToFunnelId,
        // Apenas cards ativos contam (won/lost não bloqueiam novo card)
        stage: { outcome: 'IN_PROGRESS' },
      },
      select: { id: true },
    });

    if (!existing) {
      const card = await prisma.card.create({
        data: {
          workspaceId,
          funnelId: label.routesToFunnelId,
          stageId: label.routesToStageId,
          conversationId,
          title: `Conversa #${conversationId.slice(-6)}`,
        },
      });

      // Espelhar label tambem no card
      await prisma.cardLabel.create({ data: { cardId: card.id, labelId } });

      await publishEvent(workspaceId, 'kanban', 'card.created', {
        cardId: card.id,
        funnelId: label.routesToFunnelId,
        stageId: label.routesToStageId,
        conversationId,
        autoRouted: true,
        source,
      });

      audit({
        workspaceId,
        actorId,
        action: AUDIT_ACTIONS.CARD_AUTO_ROUTED,
        resource: `card:${card.id}`,
        metadata: { source, labelId, conversationId, funnelId: label.routesToFunnelId },
      });
    }
  }
}
```

- [ ] **Step 4: Rodar testes para confirmar que passam**

```bash
pnpm --filter @neura/api test -- tests/auto-routing.test.ts
```

Expected: PASS (5 testes).

- [ ] **Step 5: Verificar typecheck**

```bash
pnpm --filter @neura/api typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/auto-routing.ts apps/api/tests/auto-routing.test.ts
git commit -m "feat(api): adiciona service auto-routing.applyTagWithRouting + tests"
```

---

## Task 5: Service `welcome-flow.ts`

**Files:**

- Create: `apps/api/src/services/welcome-flow.ts`
- Create: `apps/api/tests/welcome-flow.test.ts`

- [ ] **Step 1: Escrever testes**

Criar `apps/api/tests/welcome-flow.test.ts`:

```typescript
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { prisma } from '@neura/database';
import {
  shouldTriggerWelcome,
  sendWelcome,
  markCompleted,
  markFailed,
} from '../src/services/welcome-flow.js';

let workspaceId: string;
let inboxId: string;
let contactId: string;
let conversationId: string;
let flowId: string;
let labelId: string;

beforeAll(async () => {
  // Cleanup das tabelas que vamos usar
  await prisma.welcomeOption.deleteMany();
  await prisma.welcomeFlow.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.label.deleteMany();
  await prisma.inbox.deleteMany();
  await prisma.workspace.deleteMany();

  const ws = await prisma.workspace.create({
    data: { name: 'Welcome Flow Test', slug: 'welcome-test' },
  });
  workspaceId = ws.id;

  const inbox = await prisma.inbox.create({
    data: { workspaceId, name: 'WA', type: 'WHATSAPP', status: 'CONNECTED' },
  });
  inboxId = inbox.id;

  const label = await prisma.label.create({
    data: { workspaceId, name: 'Compra', color: '#10b981' },
  });
  labelId = label.id;

  const flow = await prisma.welcomeFlow.create({
    data: {
      workspaceId,
      inboxId,
      prompt: 'Olá! Como podemos ajudar?',
      enabled: true,
      maxAttempts: 2,
      fallbackTimeoutMinutes: 2,
      options: {
        create: [
          { position: 1, label: 'Compra', matchKeywords: ['comprar'], targetLabelId: labelId },
          {
            position: 2,
            label: 'Suporte',
            matchKeywords: ['suporte', 'ajuda'],
            targetLabelId: labelId,
          },
        ],
      },
    },
  });
  flowId = flow.id;
});

beforeEach(async () => {
  await prisma.conversation.deleteMany();
  await prisma.contact.deleteMany({ where: { workspaceId } });

  const contact = await prisma.contact.create({
    data: { workspaceId, phoneNumber: '+5511999990001', name: 'Cliente Test' },
  });
  contactId = contact.id;

  const conv = await prisma.conversation.create({
    data: { workspaceId, inboxId, contactId, status: 'OPEN' },
  });
  conversationId = conv.id;
});

describe('shouldTriggerWelcome', () => {
  it('retorna true pra primeira mensagem em conversa nova sem welcome respondido', async () => {
    const result = await shouldTriggerWelcome({ workspaceId, conversationId, contactId });
    expect(result).toBe(true);
  });

  it('retorna false se contato já respondeu welcome antes', async () => {
    await prisma.contact.update({
      where: { id: contactId },
      data: { welcomeRespondedAt: new Date() },
    });
    const result = await shouldTriggerWelcome({ workspaceId, conversationId, contactId });
    expect(result).toBe(false);
  });

  it('retorna false se conversa já está awaiting welcome choice', async () => {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { isAwaitingWelcomeChoice: true },
    });
    const result = await shouldTriggerWelcome({ workspaceId, conversationId, contactId });
    expect(result).toBe(false);
  });

  it('retorna false se inbox não tem flow habilitado', async () => {
    await prisma.welcomeFlow.update({ where: { id: flowId }, data: { enabled: false } });
    const result = await shouldTriggerWelcome({ workspaceId, conversationId, contactId });
    expect(result).toBe(false);

    // Restore pra próximos testes
    await prisma.welcomeFlow.update({ where: { id: flowId }, data: { enabled: true } });
  });
});

describe('sendWelcome', () => {
  it('marca conversa como awaiting + welcomeSentAt + enfileira outbound INTERACTIVE', async () => {
    const enqueueSpy = vi.fn().mockResolvedValue(undefined);
    await sendWelcome({ workspaceId, conversationId }, { enqueueOutbound: enqueueSpy });

    const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
    expect(conv?.isAwaitingWelcomeChoice).toBe(true);
    expect(conv?.welcomeSentAt).not.toBeNull();

    expect(enqueueSpy).toHaveBeenCalledOnce();
    const job = enqueueSpy.mock.calls[0]?.[0];
    expect(job.type).toBe('INTERACTIVE');
    expect(job.interactivePayload.options).toHaveLength(2);
  });
});

describe('markCompleted', () => {
  it('limpa awaiting, marca welcomeRespondedAt no contato, audita', async () => {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { isAwaitingWelcomeChoice: true, welcomeAttempts: 1 },
    });

    await markCompleted({ workspaceId, conversationId, contactId, optionId: 'fake' });

    const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
    expect(conv?.isAwaitingWelcomeChoice).toBe(false);

    const contact = await prisma.contact.findUnique({ where: { id: contactId } });
    expect(contact?.welcomeRespondedAt).not.toBeNull();
  });
});

describe('markFailed', () => {
  it('limpa awaiting + aplica fallbackLabel se configurado', async () => {
    await prisma.welcomeFlow.update({
      where: { id: flowId },
      data: { fallbackLabelId: labelId },
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { isAwaitingWelcomeChoice: true, welcomeAttempts: 2 },
    });

    await markFailed({ workspaceId, conversationId });

    const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
    expect(conv?.isAwaitingWelcomeChoice).toBe(false);

    const links = await prisma.conversationLabel.findMany({ where: { conversationId } });
    expect(links).toHaveLength(1);
    expect(links[0]?.labelId).toBe(labelId);

    // Restore
    await prisma.welcomeFlow.update({ where: { id: flowId }, data: { fallbackLabelId: null } });
  });
});
```

- [ ] **Step 2: Rodar e ver falha**

```bash
pnpm --filter @neura/api test -- tests/welcome-flow.test.ts
```

Expected: FAIL com import errors.

- [ ] **Step 3: Implementar `apps/api/src/services/welcome-flow.ts`**

```typescript
import { prisma } from '../db.js';
import { publishEvent } from '../redis-pub.js';
import { audit, AUDIT_ACTIONS } from './audit.js';
import { applyTagWithRouting } from './auto-routing.js';
import { enqueueOutbound } from '../queue.js';
import { logger } from '../logger.js';
import type { SendMessageJob } from '@neura/shared/queue';

type EnqueueOutboundFn = (job: SendMessageJob) => Promise<void>;

interface ShouldTriggerParams {
  workspaceId: string;
  conversationId: string;
  contactId: string;
}

export async function shouldTriggerWelcome(params: ShouldTriggerParams): Promise<boolean> {
  const { workspaceId, conversationId, contactId } = params;

  const [contact, conversation] = await Promise.all([
    prisma.contact.findFirst({
      where: { id: contactId, workspaceId },
      select: { welcomeRespondedAt: true },
    }),
    prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: {
        inboxId: true,
        isAwaitingWelcomeChoice: true,
      },
    }),
  ]);

  if (!contact || !conversation) return false;
  if (contact.welcomeRespondedAt) return false;
  if (conversation.isAwaitingWelcomeChoice) return false;

  const flow = await prisma.welcomeFlow.findUnique({
    where: { inboxId: conversation.inboxId },
    select: { enabled: true, options: { select: { id: true }, take: 1 } },
  });

  if (!flow || !flow.enabled) return false;
  if (flow.options.length === 0) return false;

  return true;
}

interface SendWelcomeParams {
  workspaceId: string;
  conversationId: string;
}

interface SendWelcomeDeps {
  enqueueOutbound?: EnqueueOutboundFn;
}

/**
 * Envia o welcome: marca conversa como awaiting, persiste Message do bot,
 * enfileira outbound INTERACTIVE. `deps.enqueueOutbound` é injetado pra testes.
 */
export async function sendWelcome(
  params: SendWelcomeParams,
  deps: SendWelcomeDeps = {},
): Promise<void> {
  const { workspaceId, conversationId } = params;
  const enqueue = deps.enqueueOutbound ?? enqueueOutbound;

  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: {
      inboxId: true,
      contact: { select: { id: true, phoneNumber: true, name: true } },
      inbox: { select: { name: true } },
    },
  });
  if (!conv || !conv.contact?.phoneNumber) {
    logger.warn({ conversationId }, 'sendWelcome: conversa ou contato inválido');
    return;
  }

  const flow = await prisma.welcomeFlow.findUnique({
    where: { inboxId: conv.inboxId },
    include: { options: { orderBy: { position: 'asc' } } },
  });
  if (!flow || !flow.enabled || flow.options.length === 0) {
    logger.warn({ conversationId }, 'sendWelcome: flow não habilitado ou sem opções');
    return;
  }

  // Substituir placeholders no prompt
  const prompt = flow.prompt.replace(/\{\{contact\.name\}\}/g, conv.contact.name || 'cliente');

  // Persistir Message do bot (AI_AGENT, OUTBOUND, INTERACTIVE)
  const msg = await prisma.message.create({
    data: {
      workspaceId,
      conversationId,
      direction: 'OUTBOUND',
      type: 'TEXT', // armazenado como TEXT no DB (visível pra agente)
      senderType: 'AI_AGENT',
      content: prompt,
      status: 'PENDING',
    },
  });

  // Marcar conversa awaiting
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      isAwaitingWelcomeChoice: true,
      welcomeSentAt: new Date(),
      welcomeAttempts: { increment: 1 },
    },
  });

  // Enfileirar job INTERACTIVE
  const job: SendMessageJob = {
    inboxId: conv.inboxId,
    workspaceId,
    conversationId,
    messageId: msg.id,
    to: conv.contact.phoneNumber,
    type: 'INTERACTIVE',
    text: prompt,
    interactivePayload: {
      title: 'Atendimento',
      body: prompt,
      buttonText: 'Ver opções',
      options: flow.options.map((o) => ({
        rowId: o.id,
        title: o.label,
        description: o.description ?? undefined,
      })),
    },
  };

  await enqueue(job);

  audit({
    workspaceId,
    actorId: null,
    action: AUDIT_ACTIONS.WELCOME_TRIGGERED,
    resource: `conversation:${conversationId}`,
    metadata: { flowId: flow.id, optionsCount: flow.options.length },
  });

  await publishEvent(workspaceId, 'conversations', 'welcome.triggered', {
    conversationId,
    messageId: msg.id,
  });
}

interface MarkCompletedParams {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  optionId: string;
}

export async function markCompleted(params: MarkCompletedParams): Promise<void> {
  const { workspaceId, conversationId, contactId, optionId } = params;

  await Promise.all([
    prisma.conversation.update({
      where: { id: conversationId },
      data: { isAwaitingWelcomeChoice: false },
    }),
    prisma.contact.update({
      where: { id: contactId },
      data: { welcomeRespondedAt: new Date() },
    }),
  ]);

  audit({
    workspaceId,
    actorId: null,
    action: AUDIT_ACTIONS.WELCOME_COMPLETED,
    resource: `conversation:${conversationId}`,
    metadata: { optionId },
  });

  await publishEvent(workspaceId, 'conversations', 'welcome.completed', {
    conversationId,
    optionId,
  });
}

interface MarkFailedParams {
  workspaceId: string;
  conversationId: string;
}

export async function markFailed(params: MarkFailedParams): Promise<void> {
  const { workspaceId, conversationId } = params;

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { isAwaitingWelcomeChoice: false },
  });

  // Aplica fallback label se configurado
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { inboxId: true },
  });
  if (!conv) return;

  const flow = await prisma.welcomeFlow.findUnique({
    where: { inboxId: conv.inboxId },
    select: { fallbackLabelId: true },
  });

  if (flow?.fallbackLabelId) {
    await applyTagWithRouting({
      workspaceId,
      conversationId,
      labelId: flow.fallbackLabelId,
      source: 'welcome_flow',
    });
  }

  audit({
    workspaceId,
    actorId: null,
    action: AUDIT_ACTIONS.WELCOME_FAILED,
    resource: `conversation:${conversationId}`,
    metadata: { fallbackLabelId: flow?.fallbackLabelId ?? null },
  });

  await publishEvent(workspaceId, 'conversations', 'welcome.failed', {
    conversationId,
    fallbackLabelApplied: flow?.fallbackLabelId ?? null,
  });
}

interface RetryAsTextParams {
  workspaceId: string;
  conversationId: string;
}

export async function retryAsText(
  params: RetryAsTextParams,
  deps: SendWelcomeDeps = {},
): Promise<void> {
  const { workspaceId, conversationId } = params;
  const enqueue = deps.enqueueOutbound ?? enqueueOutbound;

  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: {
      inboxId: true,
      welcomeFallbackSent: true,
      contact: { select: { id: true, phoneNumber: true, name: true } },
    },
  });
  if (!conv?.contact?.phoneNumber || conv.welcomeFallbackSent) return;

  const flow = await prisma.welcomeFlow.findUnique({
    where: { inboxId: conv.inboxId },
    include: { options: { orderBy: { position: 'asc' } } },
  });
  if (!flow) return;

  const lines = [
    flow.prompt.replace(/\{\{contact\.name\}\}/g, conv.contact.name || 'cliente'),
    '',
    ...flow.options.map((o) => `${o.position}. ${o.label}`),
    '',
    'Responda com o número da opção desejada.',
  ];
  const textPlain = lines.join('\n');

  const msg = await prisma.message.create({
    data: {
      workspaceId,
      conversationId,
      direction: 'OUTBOUND',
      type: 'TEXT',
      senderType: 'AI_AGENT',
      content: textPlain,
      status: 'PENDING',
    },
  });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { welcomeFallbackSent: true },
  });

  await enqueue({
    inboxId: conv.inboxId,
    workspaceId,
    conversationId,
    messageId: msg.id,
    to: conv.contact.phoneNumber,
    type: 'TEXT',
    text: textPlain,
  });

  audit({
    workspaceId,
    actorId: null,
    action: AUDIT_ACTIONS.WELCOME_FALLBACK_SENT,
    resource: `conversation:${conversationId}`,
  });
}
```

- [ ] **Step 4: Rodar testes**

```bash
pnpm --filter @neura/api test -- tests/welcome-flow.test.ts
```

Expected: PASS (7+ testes).

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @neura/api typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/welcome-flow.ts apps/api/tests/welcome-flow.test.ts
git commit -m "feat(api): adiciona service welcome-flow (trigger/send/complete/fail/retry) + tests"
```

---

## Task 6: Service `welcome-parser.ts`

**Files:**

- Create: `apps/api/src/services/welcome-parser.ts`
- Create: `apps/api/tests/welcome-parser.test.ts`

- [ ] **Step 1: Escrever testes**

Criar `apps/api/tests/welcome-parser.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { parseReply, type WelcomeOptionLite } from '../src/services/welcome-parser.js';

const opts: WelcomeOptionLite[] = [
  { id: 'opt1', position: 1, label: 'Compra', matchKeywords: ['comprar', 'quero comprar'] },
  { id: 'opt2', position: 2, label: 'Suporte', matchKeywords: ['ajuda', 'suporte'] },
  { id: 'opt3', position: 3, label: 'Outros', matchKeywords: [] },
];

describe('parseReply — match exato por buttonReply', () => {
  it('matchea pelo rowId', async () => {
    const result = await parseReply(
      { kind: 'button_reply', rowId: 'opt2', selectedDisplayText: 'Suporte' },
      opts,
    );
    expect(result?.id).toBe('opt2');
  });
});

describe('parseReply — match por número', () => {
  it('matchea "1"', async () => {
    const r = await parseReply({ kind: 'text', text: '1' }, opts);
    expect(r?.id).toBe('opt1');
  });

  it('matchea "2."', async () => {
    const r = await parseReply({ kind: 'text', text: '2.' }, opts);
    expect(r?.id).toBe('opt2');
  });

  it('não matchea "5" (fora de range)', async () => {
    const r = await parseReply({ kind: 'text', text: '5' }, opts);
    expect(r).toBeNull();
  });
});

describe('parseReply — match exato por label', () => {
  it('matchea "Compra"', async () => {
    const r = await parseReply({ kind: 'text', text: 'Compra' }, opts);
    expect(r?.id).toBe('opt1');
  });

  it('matchea case-insensitive', async () => {
    const r = await parseReply({ kind: 'text', text: 'suporte' }, opts);
    expect(r?.id).toBe('opt2');
  });
});

describe('parseReply — match por keyword', () => {
  it('matchea "quero comprar um produto" via keyword', async () => {
    const r = await parseReply({ kind: 'text', text: 'quero comprar um produto' }, opts);
    expect(r?.id).toBe('opt1');
  });

  it('matchea "preciso de ajuda" via keyword "ajuda"', async () => {
    const r = await parseReply({ kind: 'text', text: 'preciso de ajuda' }, opts);
    expect(r?.id).toBe('opt2');
  });
});

describe('parseReply — fallback OpenAI', () => {
  it('chama OpenAI quando nada matchea localmente e retorna match', async () => {
    const fuzzyMock = vi.fn().mockResolvedValue('opt1');

    const r = await parseReply({ kind: 'text', text: 'tô interessado em adquirir' }, opts, {
      fuzzyMatchFn: fuzzyMock,
    });

    expect(fuzzyMock).toHaveBeenCalledOnce();
    expect(r?.id).toBe('opt1');
  });

  it('retorna null se OpenAI também não matchea', async () => {
    const fuzzyMock = vi.fn().mockResolvedValue(null);
    const r = await parseReply({ kind: 'text', text: 'xyz aleatório' }, opts, {
      fuzzyMatchFn: fuzzyMock,
    });
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falha**

```bash
pnpm --filter @neura/api test -- tests/welcome-parser.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implementar `apps/api/src/services/welcome-parser.ts`**

```typescript
import OpenAI from 'openai';
import { env } from '../env.js';
import { logger } from '../logger.js';

export interface WelcomeOptionLite {
  id: string;
  position: number;
  label: string;
  matchKeywords: string[];
}

export type ReplyInput =
  | { kind: 'button_reply'; rowId: string; selectedDisplayText?: string }
  | { kind: 'text'; text: string }
  | { kind: 'audio'; transcript: string };

interface ParserDeps {
  fuzzyMatchFn?: (text: string, options: WelcomeOptionLite[]) => Promise<string | null>;
}

const openaiClient = env.OPENAI_API_KEY ? new OpenAI({ apiKey: env.OPENAI_API_KEY }) : null;

/**
 * Fuzzy match via OpenAI. Recebe texto livre + opções, retorna rowId ou null.
 * Modelo: gpt-4o-mini (rápido + barato). Temperature 0 pra determinismo.
 */
async function defaultFuzzyMatch(
  text: string,
  options: WelcomeOptionLite[],
): Promise<string | null> {
  if (!openaiClient) {
    logger.warn('OpenAI client não configurado — fuzzy match indisponível');
    return null;
  }

  const optList = options
    .map(
      (o) =>
        `${o.position}. id=${o.id} | ${o.label} | keywords: ${o.matchKeywords.join(', ') || '(nenhuma)'}`,
    )
    .join('\n');

  const prompt = `Você é um classificador. O cliente disse: "${text}"

Opções disponíveis:
${optList}

Retorne SOMENTE o id da opção mais adequada, ou "none" se nenhuma se aplica claramente.`;

  try {
    const completion = await openaiClient.chat.completions.create({
      model: env.OPENAI_CHAT_MODEL ?? 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 50,
    });
    const raw = completion.choices[0]?.message?.content?.trim() ?? '';
    if (raw === 'none' || !raw) return null;
    // Aceitar resposta com qualquer prefixo/sufixo — só o id matters
    const match = options.find((o) => raw.includes(o.id));
    return match?.id ?? null;
  } catch (err) {
    logger.error({ err }, 'OpenAI fuzzy match falhou');
    return null;
  }
}

const normalize = (s: string): string => s.trim().toLowerCase();

/**
 * Identifica qual WelcomeOption o cliente escolheu. Estratégias em ordem:
 * 1. buttonReply.rowId → match exato
 * 2. text == número (1, 2, 3, "1.") → match por position
 * 3. text == label normalizado → match por label
 * 4. text contém qualquer matchKeyword → match por keyword
 * 5. Fallback: OpenAI fuzzy match
 */
export async function parseReply(
  input: ReplyInput,
  options: WelcomeOptionLite[],
  deps: ParserDeps = {},
): Promise<WelcomeOptionLite | null> {
  const fuzzy = deps.fuzzyMatchFn ?? defaultFuzzyMatch;

  // 1. buttonReply
  if (input.kind === 'button_reply') {
    return options.find((o) => o.id === input.rowId) ?? null;
  }

  const rawText = input.kind === 'text' ? input.text : input.transcript;
  const text = normalize(rawText);
  if (!text) return null;

  // 2. Match por número
  const numMatch = text.match(/^(\d{1,2})[\.\)]?$/);
  if (numMatch) {
    const pos = parseInt(numMatch[1]!, 10);
    return options.find((o) => o.position === pos) ?? null;
  }

  // 3. Match exato por label
  const byLabel = options.find((o) => normalize(o.label) === text);
  if (byLabel) return byLabel;

  // 4. Match por keyword (substring)
  const byKeyword = options.find((o) => o.matchKeywords.some((k) => text.includes(normalize(k))));
  if (byKeyword) return byKeyword;

  // 5. Fuzzy fallback
  const fuzzyId = await fuzzy(rawText, options);
  return fuzzyId ? (options.find((o) => o.id === fuzzyId) ?? null) : null;
}
```

- [ ] **Step 4: Rodar testes**

```bash
pnpm --filter @neura/api test -- tests/welcome-parser.test.ts
```

Expected: PASS (todos).

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @neura/api typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/welcome-parser.ts apps/api/tests/welcome-parser.test.ts
git commit -m "feat(api): adiciona service welcome-parser (number/label/keyword/openai-fuzzy)"
```

---

## Task 7: Worker BullMQ `welcome-worker.ts`

**Files:**

- Create: `apps/api/src/welcome-worker.ts`

- [ ] **Step 1: Implementar consumer**

Criar `apps/api/src/welcome-worker.ts`:

```typescript
import { Worker, Queue, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_WELCOME_PROCESS, type WelcomeProcessJob } from '@neura/shared/queue';
import { env } from './env.js';
import { logger } from './logger.js';
import { prisma } from './db.js';
import {
  shouldTriggerWelcome,
  sendWelcome,
  markCompleted,
  markFailed,
  retryAsText,
} from './services/welcome-flow.js';
import { parseReply, type WelcomeOptionLite } from './services/welcome-parser.js';
import { applyTagWithRouting } from './services/auto-routing.js';

const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const welcomeProcessQueue = new Queue<WelcomeProcessJob>(QUEUE_WELCOME_PROCESS, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: 3600, count: 1_000 },
    removeOnFail: { age: 24 * 3600 },
  },
});

export async function enqueueWelcomeProcess(job: WelcomeProcessJob): Promise<void> {
  await welcomeProcessQueue.add('process', job);
}

async function handleTrigger(job: WelcomeProcessJob): Promise<void> {
  const { workspaceId, conversationId } = job;
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: { contactId: true },
  });
  if (!conv) return;

  const ok = await shouldTriggerWelcome({
    workspaceId,
    conversationId,
    contactId: conv.contactId,
  });
  if (!ok) {
    logger.debug({ conversationId }, 'shouldTriggerWelcome=false, skipping');
    return;
  }

  await sendWelcome({ workspaceId, conversationId });
}

async function handleParseReply(job: WelcomeProcessJob): Promise<void> {
  const { workspaceId, conversationId, messageId } = job;
  if (!messageId) {
    logger.warn({ conversationId }, 'parse_reply sem messageId');
    return;
  }

  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: {
      inboxId: true,
      contactId: true,
      welcomeAttempts: true,
      isAwaitingWelcomeChoice: true,
    },
  });
  if (!conv || !conv.isAwaitingWelcomeChoice) return;

  const msg = await prisma.message.findFirst({
    where: { id: messageId, workspaceId },
    select: { type: true, content: true, metadata: true },
  });
  if (!msg) return;

  const flow = await prisma.welcomeFlow.findUnique({
    where: { inboxId: conv.inboxId },
    include: { options: { orderBy: { position: 'asc' } } },
  });
  if (!flow || !flow.enabled) return;

  const optionsLite: WelcomeOptionLite[] = flow.options.map((o) => ({
    id: o.id,
    position: o.position,
    label: o.label,
    matchKeywords: o.matchKeywords,
  }));

  // Construir ReplyInput baseado no tipo da Message
  // metadata pode trazer { interactiveRowId, interactiveDisplayText } se for button reply
  // (preenchido pelo waworker quando detecta listResponseMessage)
  const meta = (msg.metadata ?? {}) as Record<string, unknown>;
  let replyInput;
  if (typeof meta.interactiveRowId === 'string') {
    replyInput = {
      kind: 'button_reply' as const,
      rowId: meta.interactiveRowId,
      selectedDisplayText:
        typeof meta.interactiveDisplayText === 'string' ? meta.interactiveDisplayText : undefined,
    };
  } else if (msg.type === 'AUDIO') {
    // Esperar transcrição (Whisper worker já roda assíncrono). Se ainda não tem,
    // re-enfileirar com delay.
    if (typeof meta.transcript !== 'string' || !meta.transcript) {
      await enqueueWelcomeProcess({ ...job });
      // Atraso simples via job options seria melhor; por simplicidade re-enfileira.
      return;
    }
    replyInput = { kind: 'audio' as const, transcript: meta.transcript };
  } else {
    replyInput = { kind: 'text' as const, text: msg.content ?? '' };
  }

  const match = await parseReply(replyInput, optionsLite);

  if (match) {
    // Aplicar routing
    const fullOpt = flow.options.find((o) => o.id === match.id);
    if (fullOpt) {
      await applyTagWithRouting({
        workspaceId,
        conversationId,
        labelId: fullOpt.targetLabelId,
        source: 'welcome_flow',
      });
    }
    await markCompleted({
      workspaceId,
      conversationId,
      contactId: conv.contactId,
      optionId: match.id,
    });
    return;
  }

  // No match: incrementar attempts
  const newAttempts = conv.welcomeAttempts + 1;
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { welcomeAttempts: newAttempts },
  });

  if (newAttempts >= flow.maxAttempts) {
    // Fallback: aplica fallback label e libera pra humano
    await markFailed({ workspaceId, conversationId });
  } else {
    // Re-enviar prompt com prefixo "Não entendi"
    await retryAsText({ workspaceId, conversationId });
  }
}

async function handleRetryText(job: WelcomeProcessJob): Promise<void> {
  const { workspaceId, conversationId } = job;
  await retryAsText({ workspaceId, conversationId });
}

async function handleFallbackHuman(job: WelcomeProcessJob): Promise<void> {
  const { workspaceId, conversationId } = job;
  await markFailed({ workspaceId, conversationId });
}

export const welcomeWorker = new Worker<WelcomeProcessJob>(
  QUEUE_WELCOME_PROCESS,
  async (job: Job<WelcomeProcessJob>) => {
    const { kind } = job.data;
    logger.info(
      { jobId: job.id, kind, conversationId: job.data.conversationId },
      'welcome-worker processing',
    );
    switch (kind) {
      case 'trigger':
        return handleTrigger(job.data);
      case 'parse_reply':
        return handleParseReply(job.data);
      case 'retry_text':
        return handleRetryText(job.data);
      case 'fallback_human':
        return handleFallbackHuman(job.data);
      default:
        logger.warn({ kind }, 'welcome-worker kind desconhecido');
    }
  },
  {
    connection: bullConnection,
    concurrency: 5,
  },
);

welcomeWorker.on('failed', (job, err) => {
  logger.error(
    { jobId: job?.id, conversationId: job?.data.conversationId, err: err.message },
    'welcome-worker job failed',
  );
});
```

- [ ] **Step 2: Verificar typecheck**

```bash
pnpm --filter @neura/api typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/welcome-worker.ts
git commit -m "feat(api): adiciona welcome-worker BullMQ consumer (trigger/parse/retry/fallback)"
```

---

## Task 8: Scheduler `welcome-scheduler.ts`

**Files:**

- Create: `apps/api/src/welcome-scheduler.ts`

- [ ] **Step 1: Implementar cron**

Criar `apps/api/src/welcome-scheduler.ts`:

```typescript
import { prisma } from './db.js';
import { logger } from './logger.js';
import { enqueueWelcomeProcess } from './welcome-worker.js';

const POLL_INTERVAL_MS = 30_000;

let timer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  try {
    // Busca conversas awaiting que passaram do timeout e não tiveram fallback texto ainda.
    // Usa cross-join com WelcomeFlow pra pegar fallbackTimeoutMinutes da inbox.
    const candidates = await prisma.$queryRaw<Array<{ id: string; workspaceId: string }>>`
      SELECT c.id, c."workspaceId"
      FROM conversations c
      JOIN welcome_flows wf ON wf."inboxId" = c."inboxId"
      WHERE c."isAwaitingWelcomeChoice" = true
        AND c."welcomeFallbackSent" = false
        AND c."welcomeSentAt" IS NOT NULL
        AND wf.enabled = true
        AND wf."fallbackTimeoutMinutes" > 0
        AND c."welcomeSentAt" < NOW() - (wf."fallbackTimeoutMinutes" || ' minutes')::interval
      LIMIT 100
    `;

    for (const row of candidates) {
      await enqueueWelcomeProcess({
        workspaceId: row.workspaceId,
        conversationId: row.id,
        kind: 'retry_text',
      });
    }

    if (candidates.length > 0) {
      logger.info({ count: candidates.length }, 'welcome-scheduler: enfileirado retry_text');
    }
  } catch (err) {
    logger.error({ err }, 'welcome-scheduler tick falhou');
  }
}

export function startWelcomeScheduler(): void {
  if (timer) return;
  logger.info('Iniciando welcome-scheduler (poll 30s)');
  timer = setInterval(tick, POLL_INTERVAL_MS);
  // Roda uma vez no boot pra não esperar 30s
  void tick();
}

export function stopWelcomeScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @neura/api typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/welcome-scheduler.ts
git commit -m "feat(api): adiciona welcome-scheduler (poll 30s pra retry_text por timeout)"
```

---

## Task 9: Hook em `routes/messages.ts` para inbound em awaiting

**Files:**

- Modify: `apps/api/src/routes/messages.ts`

- [ ] **Step 1: Localizar handler de inbound message processing**

```bash
grep -n "message.new\|publishEvent.*message" apps/api/src/routes/messages.ts | head -10
```

Identificar onde, após persistir uma Message inbound, podemos hookar a decisão "está awaiting? rotear pro parser".

- [ ] **Step 2: Adicionar hook após persist Message INBOUND**

Em `apps/api/src/routes/messages.ts`, localizar o ponto onde uma Message INBOUND é criada (provavelmente via `prisma.message.create({ data: { direction: 'INBOUND', ... } })`). Logo após a criação e após `publishEvent('message.new')`, adicionar:

```typescript
import { enqueueWelcomeProcess } from '../welcome-worker.js';

// ...dentro do handler que persiste inbound...

// Hook welcome flow: se conversa está awaiting choice, rotear msg pro parser.
const convCheck = await prisma.conversation.findFirst({
  where: { id: conversationId, workspaceId },
  select: { isAwaitingWelcomeChoice: true },
});
if (convCheck?.isAwaitingWelcomeChoice) {
  await enqueueWelcomeProcess({
    workspaceId,
    conversationId,
    kind: 'parse_reply',
    messageId: newMessage.id,
  });
}
```

**Nota**: o waworker também persiste mensagens inbound diretamente via `events.ts/persistInboundMessage`, sem passar pela route messages.ts. O hook análogo no waworker virá na Task 11.

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @neura/api typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/messages.ts
git commit -m "feat(api): rotear inbound pra welcome parser se conversa awaiting"
```

---

## Task 10: Wire welcome-worker + scheduler em `apps/api/src/index.ts`

**Files:**

- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Importar e bootar**

Em `apps/api/src/index.ts`, junto com os outros workers e schedulers:

```typescript
// Logo abaixo dos imports existentes:
import { welcomeWorker } from './welcome-worker.js';
import { startWelcomeScheduler } from './welcome-scheduler.js';

// Logo após os startXxxScheduler() existentes (procurar startAutomationScheduler):
startWelcomeScheduler();

// welcomeWorker já se inicializa no import. Adicionar log informativo:
logger.info({ worker: 'welcome' }, 'Welcome worker iniciado');
```

- [ ] **Step 2: Build do api**

```bash
pnpm --filter @neura/api build
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/index.ts
git commit -m "feat(api): wire welcome-worker + scheduler no boot"
```

---

## Task 11: Hook no waworker — trigger welcome em primeira mensagem inbound

**Files:**

- Modify: `apps/waworker/src/baileys/events.ts`
- Create: `apps/waworker/src/welcome-trigger.ts`

- [ ] **Step 1: Criar producer do welcome-process queue no waworker**

Criar `apps/waworker/src/welcome-trigger.ts`:

```typescript
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_WELCOME_PROCESS, type WelcomeProcessJob } from '@neura/shared/queue';
import { env } from './env.js';

const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const welcomeQueue = new Queue<WelcomeProcessJob>(QUEUE_WELCOME_PROCESS, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: 3600, count: 1_000 },
    removeOnFail: { age: 24 * 3600 },
  },
});

export async function enqueueWelcomeTrigger(payload: {
  workspaceId: string;
  conversationId: string;
}): Promise<void> {
  await welcomeQueue.add('trigger', {
    workspaceId: payload.workspaceId,
    conversationId: payload.conversationId,
    kind: 'trigger',
  });
}

export async function enqueueWelcomeParseReply(payload: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
}): Promise<void> {
  await welcomeQueue.add('parse_reply', {
    workspaceId: payload.workspaceId,
    conversationId: payload.conversationId,
    kind: 'parse_reply',
    messageId: payload.messageId,
  });
}
```

- [ ] **Step 2: Detectar primeira mensagem inbound + enfileirar trigger**

Em `apps/waworker/src/baileys/events.ts`, dentro de `persistInboundMessage`, **APÓS** a Message ser criada e antes de `publishEvent`, adicionar:

```typescript
// (perto do início do arquivo)
import { enqueueWelcomeTrigger, enqueueWelcomeParseReply } from '../welcome-trigger.js';

// dentro de persistInboundMessage, após `const newMessage = await prisma.message.create(...)`:

// Hook welcome flow: detectar primeira mensagem do contato (newConversation OR
// é a primeira message inbound nessa conversa) → trigger.
const isFirstInbound =
  (await prisma.message.count({
    where: {
      conversationId: conversation.id,
      direction: 'INBOUND',
    },
  })) === 1; // já incluímos a recém criada, então 1 = primeira

if (isFirstInbound) {
  await enqueueWelcomeTrigger({
    workspaceId: ctx.workspaceId,
    conversationId: conversation.id,
  });
}

// Se a conversa estiver awaiting (já recebeu welcome), rotear pra parser.
const convAwaiting = await prisma.conversation.findUnique({
  where: { id: conversation.id },
  select: { isAwaitingWelcomeChoice: true },
});
if (convAwaiting?.isAwaitingWelcomeChoice) {
  await enqueueWelcomeParseReply({
    workspaceId: ctx.workspaceId,
    conversationId: conversation.id,
    messageId: newMessage.id,
  });
}
```

**Nota**: as variáveis `conversation`, `newMessage`, e `ctx` devem existir no escopo de `persistInboundMessage`. Adaptar os nomes ao código real ao implementar.

- [ ] **Step 3: Detectar buttonReply / listResponseMessage no Baileys**

No mesmo `persistInboundMessage`, ao mapear o conteúdo da WAMessage pra os campos do nosso Message, detectar listResponseMessage e buttonsResponseMessage:

```typescript
// Onde se extrai o conteúdo da msg:
const msgContent = msg.message;

let content = '';
let messageType: MessageType = 'TEXT';
let interactiveMeta: { interactiveRowId?: string; interactiveDisplayText?: string } = {};

if (msgContent?.listResponseMessage) {
  // Cliente respondeu ao listMessage do welcome
  const r = msgContent.listResponseMessage;
  interactiveMeta.interactiveRowId = r.singleSelectReply?.selectedRowId ?? undefined;
  interactiveMeta.interactiveDisplayText = r.title ?? undefined;
  content = r.title ?? '(seleção do menu)';
  messageType = 'TEXT';
} else if (msgContent?.buttonsResponseMessage) {
  const r = msgContent.buttonsResponseMessage;
  interactiveMeta.interactiveRowId = r.selectedButtonId ?? undefined;
  interactiveMeta.interactiveDisplayText = r.selectedDisplayText ?? undefined;
  content = r.selectedDisplayText ?? '(clique de botão)';
  messageType = 'TEXT';
} else if (msgContent?.conversation) {
  content = msgContent.conversation;
  messageType = 'TEXT';
}
// ... resto do mapeamento existente (image, audio, etc.)

// Ao criar a Message, incluir metadata:
const newMessage = await prisma.message.create({
  data: {
    workspaceId: ctx.workspaceId,
    conversationId: conversation.id,
    direction: 'INBOUND',
    type: messageType,
    senderType: 'CUSTOMER',
    content,
    metadata: Object.keys(interactiveMeta).length > 0 ? (interactiveMeta as any) : undefined,
    // ...outros campos
  },
});
```

**Nota**: adaptar à estrutura real do `persistInboundMessage` no codebase atual. O importante é gravar `interactiveRowId` em metadata quando o cliente clica no listMessage.

- [ ] **Step 4: Typecheck waworker**

```bash
pnpm --filter @neura/waworker typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/waworker/src/welcome-trigger.ts apps/waworker/src/baileys/events.ts
git commit -m "feat(waworker): hook welcome trigger em primeira inbound + detect button/list response"
```

---

## Task 12: Outbound handler para `type === 'INTERACTIVE'`

**Files:**

- Modify: `apps/waworker/src/queue/outbound.ts`

- [ ] **Step 1: Adicionar branch INTERACTIVE no outboundWorker**

Em `apps/waworker/src/queue/outbound.ts`, dentro do handler do `outboundWorker`, antes do envio comum, adicionar:

```typescript
// Path interativo (listMessage do Baileys)
if (type === 'INTERACTIVE' && job.data.interactivePayload) {
  const payload = job.data.interactivePayload;
  const { title, body, footer, buttonText, options } = payload;

  // Baileys listMessage: máximo 10 rows
  const rows = options.slice(0, 10).map((o) => ({
    title: o.title,
    description: o.description ?? '',
    rowId: o.rowId,
  }));

  try {
    const sentMsg = await handle.sock.sendMessage(jid, {
      text: body,
      footer,
      title,
      buttonText,
      sections: [{ title: 'Opções', rows }],
      listType: 1, // SINGLE_SELECT
    } as any); // Baileys types incompletos pra listMessage

    // Update Message status
    await prisma.message.update({
      where: { id: messageId },
      data: {
        status: 'SENT',
        waMessageId: sentMsg?.key?.id ?? null,
        sentAt: new Date(),
      },
    });

    await publishEvent(workspaceId, 'messages', 'message.status_changed', {
      messageId,
      status: 'SENT',
    });

    return;
  } catch (err) {
    logger.error({ err, messageId }, 'Failed to send INTERACTIVE — falling back to text');
    // Fallback imediato: re-enviar como texto plano
    const textFallback = `${body}\n\n${options
      .map((o, i) => `${i + 1}. ${o.title}`)
      .join('\n')}\n\nResponda com o número da opção.`;

    await handle.sock.sendMessage(jid, { text: textFallback });
    await prisma.message.update({
      where: { id: messageId },
      data: { status: 'SENT', content: textFallback, sentAt: new Date() },
    });
    return;
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @neura/waworker typecheck
```

Expected: PASS (cast `as any` permitido em listMessage por limitação de types Baileys).

- [ ] **Step 3: Commit**

```bash
git add apps/waworker/src/queue/outbound.ts
git commit -m "feat(waworker): outbound handler pra type=INTERACTIVE (listMessage + fallback texto)"
```

---

## Task 13: Integration test end-to-end mockado

**Files:**

- Create: `apps/api/tests/integration/welcome-flow.test.ts`

- [ ] **Step 1: Escrever teste integração**

```typescript
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { prisma } from '@neura/database';
import { shouldTriggerWelcome, sendWelcome } from '../../src/services/welcome-flow.js';
import { parseReply } from '../../src/services/welcome-parser.js';
import { applyTagWithRouting } from '../../src/services/auto-routing.js';

let workspaceId: string;
let inboxId: string;
let contactId: string;
let conversationId: string;
let flowId: string;
let labelCompra: string;
let labelSuporte: string;
let funnelVendas: string;
let stageVendasLead: string;
let funnelSuporte: string;
let stageSuporteTriagem: string;

beforeAll(async () => {
  // Cleanup
  await prisma.cardLabel.deleteMany();
  await prisma.card.deleteMany();
  await prisma.welcomeOption.deleteMany();
  await prisma.welcomeFlow.deleteMany();
  await prisma.conversationLabel.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.stage.deleteMany();
  await prisma.funnel.deleteMany();
  await prisma.label.deleteMany();
  await prisma.inbox.deleteMany();
  await prisma.workspace.deleteMany();

  const ws = await prisma.workspace.create({
    data: { name: 'E2E Welcome Test', slug: 'e2e-welcome' },
  });
  workspaceId = ws.id;

  const inbox = await prisma.inbox.create({
    data: { workspaceId, name: 'WA E2E', type: 'WHATSAPP', status: 'CONNECTED' },
  });
  inboxId = inbox.id;

  const fv = await prisma.funnel.create({ data: { workspaceId, name: 'Vendas' } });
  funnelVendas = fv.id;
  const sv = await prisma.stage.create({
    data: { funnelId: funnelVendas, workspaceId, name: 'Lead', order: 0 },
  });
  stageVendasLead = sv.id;

  const fs = await prisma.funnel.create({ data: { workspaceId, name: 'Suporte' } });
  funnelSuporte = fs.id;
  const ss = await prisma.stage.create({
    data: { funnelId: funnelSuporte, workspaceId, name: 'Triagem', order: 0 },
  });
  stageSuporteTriagem = ss.id;

  const lc = await prisma.label.create({
    data: {
      workspaceId,
      name: 'Compra',
      color: '#10b981',
      routesToFunnelId: funnelVendas,
      routesToStageId: stageVendasLead,
    },
  });
  labelCompra = lc.id;

  const ls = await prisma.label.create({
    data: {
      workspaceId,
      name: 'Suporte',
      color: '#f59e0b',
      routesToFunnelId: funnelSuporte,
      routesToStageId: stageSuporteTriagem,
    },
  });
  labelSuporte = ls.id;

  const flow = await prisma.welcomeFlow.create({
    data: {
      workspaceId,
      inboxId,
      prompt: 'Olá! Como podemos ajudar?',
      enabled: true,
      maxAttempts: 2,
      options: {
        create: [
          {
            position: 1,
            label: 'Compra',
            matchKeywords: ['comprar', 'quero comprar'],
            targetLabelId: labelCompra,
            targetFunnelId: funnelVendas,
            targetStageId: stageVendasLead,
          },
          {
            position: 2,
            label: 'Suporte',
            matchKeywords: ['ajuda', 'suporte'],
            targetLabelId: labelSuporte,
            targetFunnelId: funnelSuporte,
            targetStageId: stageSuporteTriagem,
          },
        ],
      },
    },
  });
  flowId = flow.id;
});

beforeEach(async () => {
  await prisma.cardLabel.deleteMany();
  await prisma.card.deleteMany();
  await prisma.conversationLabel.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.contact.deleteMany({ where: { workspaceId } });

  const contact = await prisma.contact.create({
    data: { workspaceId, phoneNumber: '+5511987654321', name: 'Cliente E2E' },
  });
  contactId = contact.id;

  const conv = await prisma.conversation.create({
    data: { workspaceId, inboxId, contactId, status: 'OPEN' },
  });
  conversationId = conv.id;
});

describe('Welcome flow E2E', () => {
  it('fluxo completo: trigger → send → reply "1" → tag + card no funil Vendas', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);

    // 1. Trigger
    expect(await shouldTriggerWelcome({ workspaceId, conversationId, contactId })).toBe(true);

    // 2. Send
    await sendWelcome({ workspaceId, conversationId }, { enqueueOutbound: enqueue });
    expect(enqueue).toHaveBeenCalledOnce();

    const conv1 = await prisma.conversation.findUnique({ where: { id: conversationId } });
    expect(conv1?.isAwaitingWelcomeChoice).toBe(true);

    // 3. Cliente responde "1"
    const flow = await prisma.welcomeFlow.findUnique({
      where: { id: flowId },
      include: { options: true },
    });
    const match = await parseReply(
      { kind: 'text', text: '1' },
      flow!.options.map((o) => ({
        id: o.id,
        position: o.position,
        label: o.label,
        matchKeywords: o.matchKeywords,
      })),
    );
    expect(match).not.toBeNull();
    expect(match!.label).toBe('Compra');

    // 4. Apply routing
    const matchedOpt = flow!.options.find((o) => o.id === match!.id);
    await applyTagWithRouting({
      workspaceId,
      conversationId,
      labelId: matchedOpt!.targetLabelId,
      source: 'welcome_flow',
    });

    // 5. Verifica side effects
    const cards = await prisma.card.findMany({ where: { conversationId } });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.funnelId).toBe(funnelVendas);

    const labels = await prisma.conversationLabel.findMany({ where: { conversationId } });
    expect(labels).toHaveLength(1);
    expect(labels[0]?.labelId).toBe(labelCompra);
  });

  it('fluxo paralelo: cliente já tem card em Vendas + responde "suporte" → card paralelo em Suporte', async () => {
    // Setup: simula que conversa já tem card em Vendas
    await prisma.card.create({
      data: {
        workspaceId,
        conversationId,
        funnelId: funnelVendas,
        stageId: stageVendasLead,
        title: 'Card pré-existente',
      },
    });

    const flow = await prisma.welcomeFlow.findUnique({
      where: { id: flowId },
      include: { options: true },
    });
    const match = await parseReply(
      { kind: 'text', text: 'suporte' },
      flow!.options.map((o) => ({
        id: o.id,
        position: o.position,
        label: o.label,
        matchKeywords: o.matchKeywords,
      })),
    );
    expect(match?.label).toBe('Suporte');

    const matchedOpt = flow!.options.find((o) => o.id === match!.id);
    await applyTagWithRouting({
      workspaceId,
      conversationId,
      labelId: matchedOpt!.targetLabelId,
      source: 'welcome_flow',
    });

    const cards = await prisma.card.findMany({ where: { conversationId } });
    expect(cards).toHaveLength(2);
    const funnelIds = cards.map((c) => c.funnelId);
    expect(funnelIds).toContain(funnelVendas);
    expect(funnelIds).toContain(funnelSuporte);
  });
});
```

- [ ] **Step 2: Rodar testes integração**

```bash
pnpm --filter @neura/api test -- tests/integration/welcome-flow.test.ts
```

Expected: PASS (2 testes).

- [ ] **Step 3: Rodar suite completa de tests**

```bash
pnpm --filter @neura/api test
```

Expected: PASS (todos os testes anteriores + novos).

- [ ] **Step 4: Commit**

```bash
git add apps/api/tests/integration/welcome-flow.test.ts
git commit -m "test(api): integração e2e welcome flow (single + parallel routing)"
```

---

## Task 14: Build final + verificação de regressão

**Files:** nenhum (só validação)

- [ ] **Step 1: Build full stack**

```bash
pnpm build
```

Expected: PASS sem erros em api, web, waworker, shared, database.

- [ ] **Step 2: Lint**

```bash
pnpm lint
```

Expected: PASS sem warnings.

- [ ] **Step 3: Typecheck full**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Verificar que docker-compose ainda builda**

```bash
docker compose -f docker-compose.dev.yml config > /dev/null
```

Expected: validação de compose passa (sem erro de sintaxe).

- [ ] **Step 5: Smoke test local (opcional, se ambiente dev disponível)**

```bash
pnpm compose:up
pnpm dev
```

Esperar 30s, então:

```bash
curl http://localhost:7301/health
```

Expected: `{"status":"ok","checks":{"db":"ok","redis":"ok"}}`.

Verificar logs:

```bash
# Em outra janela, com `pnpm dev` rodando
grep -i "welcome" logs/api.log 2>/dev/null || echo "Sem mensagens welcome ainda — esperado"
```

- [ ] **Step 6: Commit final se necessário**

Se algum ajuste de lint/typecheck for necessário:

```bash
git add -A
git commit -m "chore(welcome-flow): ajustes finais lint/typecheck"
```

---

## Critérios de Aceite — Fase A

- [ ] Schema migrations aplicadas sem erro em DB local.
- [ ] Suite completa de tests passa (`pnpm test`).
- [ ] Build e typecheck passam (`pnpm build && pnpm typecheck`).
- [ ] Welcome flow pode ser criado manualmente via Prisma Studio + uma simulação de primeira mensagem inbound enfileira o job `welcome-process:trigger`.
- [ ] Reply "1" via texto após welcome marca conversa completed + cria card no funil destino.
- [ ] Reply "xyz" 2x marca conversa failed + aplica fallback label.
- [ ] OpenAI fuzzy match usa modelo configurado em `OPENAI_CHAT_MODEL` e cai silenciosamente se key inválida.

## Próximas fases (referência)

- **Fase B**: Routes API `welcome-flows.ts` + UI de configuração em `/settings/welcome-flows`.
- **Fase C**: Lead detail panel refactor + chat timeline enriquecido.
- **Fase D**: Wizard de onboarding + presets + polish.

---

Plan complete and saved to `docs/superpowers/plans/2026-05-26-welcome-flow-fase-a.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
