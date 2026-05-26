# Welcome Flow Fase D — Onboarding Wizard + Presets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando admin cria uma inbox nova, oferecer wizard "Configure o fluxo de boas-vindas agora?" com 4 presets de negócio pré-armados (e-commerce, serviços, suporte técnico, agência). Adicionar validações de UI e polish em empty/loading states.

**Architecture:** Presets vivem como JSON estático em `packages/shared/src/welcome-presets.ts` (não em DB — são templates). Endpoint `POST /api/inboxes/:id/welcome-flow/apply-preset` instancia o preset criando o flow + options. UI: dialog que abre logo após criar inbox, com 3 opções: "Aplicar preset", "Começar do zero", "Pular". Editor existente ganha validações inline (min 1, max 10 options).

**Tech Stack:** Hono + Prisma + Zod (api), Next.js + react-query + shadcn dialog (web).

**Spec base:** `docs/superpowers/specs/2026-05-26-welcome-flow-autorouting-design.md` (Fase D section).
**Fase C:** completa em PR #4. Esta branch (`feat/welcome-flow-fase-d`) stacked sobre Fase C.

---

## File Structure

### Shared
- Create: `packages/shared/src/welcome-presets.ts` — 4 presets de negócio com opções/labels/funnels sugestões

### API
- Create: `apps/api/src/routes/welcome-presets.ts` — GET presets + POST apply-preset
- Modify: `apps/api/src/index.ts` — wire router

### Web
- Create: `apps/web/src/components/inbox/welcome-flow-wizard-dialog.tsx` — dialog pós-criar-inbox com 3 opções
- Modify: `apps/web/src/components/forms/create-inbox-form.tsx` — abrir wizard após criar
- Modify: `apps/web/src/app/(app)/settings/welcome-flows/[inboxId]/page.tsx` — validações inline (min 1 / max 10 options)

---

## Task 1: Presets data (shared)

**Files:**
- Create: `packages/shared/src/welcome-presets.ts`

- [ ] **Step 1: Criar arquivo de presets**

```typescript
/**
 * Welcome flow presets por tipo de negócio. Cada preset:
 * - id estável (usado no apply-preset endpoint)
 * - nome humano (exibido no wizard)
 * - prompt template (suporta {{contact.name}})
 * - lista de opções com label + matchKeywords + targetLabelName + targetFunnelName
 *
 * O endpoint apply-preset resolve labelName/funnelName procurando labels/funnels
 * existentes no workspace por nome (case-insensitive). Se não existir, cria com defaults.
 */

export interface WelcomePresetOption {
  position: number;
  label: string;
  description?: string;
  matchKeywords: string[];
  targetLabelName: string;
  targetFunnelName?: string;
  targetStageName?: string;
}

export interface WelcomePreset {
  id: string;
  name: string;
  description: string;
  prompt: string;
  fallbackLabelName?: string;
  fallbackFunnelName?: string;
  options: WelcomePresetOption[];
}

export const WELCOME_PRESETS: WelcomePreset[] = [
  {
    id: 'ecommerce',
    name: 'E-commerce',
    description: 'Loja online com vendas, suporte pós-venda e trocas',
    prompt: 'Olá {{contact.name}}! Como podemos te ajudar hoje?',
    fallbackLabelName: 'Geral',
    options: [
      {
        position: 1,
        label: 'Comprar',
        description: 'Quero fazer um pedido',
        matchKeywords: ['comprar', 'pedido', 'produto', 'preço', 'orçamento'],
        targetLabelName: 'Vendas',
        targetFunnelName: 'Vendas',
        targetStageName: 'Novo lead',
      },
      {
        position: 2,
        label: 'Status do pedido',
        description: 'Quero saber onde está meu pedido',
        matchKeywords: ['pedido', 'rastreio', 'entrega', 'chegou'],
        targetLabelName: 'Pós-venda',
      },
      {
        position: 3,
        label: 'Troca ou devolução',
        description: 'Tive problema com o produto',
        matchKeywords: ['troca', 'devolução', 'defeito', 'reembolso'],
        targetLabelName: 'Trocas',
      },
      {
        position: 4,
        label: 'Outro assunto',
        description: 'Atendimento geral',
        matchKeywords: [],
        targetLabelName: 'Geral',
      },
    ],
  },
  {
    id: 'services',
    name: 'Serviços',
    description: 'Prestação de serviços (consultoria, freelance, agência)',
    prompt: 'Oi {{contact.name}}, em que posso ajudar?',
    fallbackLabelName: 'Geral',
    options: [
      {
        position: 1,
        label: 'Orçamento',
        description: 'Quero solicitar uma proposta',
        matchKeywords: ['orçamento', 'proposta', 'cotação', 'valor', 'preço'],
        targetLabelName: 'Lead',
        targetFunnelName: 'Vendas',
        targetStageName: 'Novo lead',
      },
      {
        position: 2,
        label: 'Acompanhar projeto',
        description: 'Já sou cliente e quero atualização',
        matchKeywords: ['projeto', 'andamento', 'status', 'cliente'],
        targetLabelName: 'Projeto ativo',
      },
      {
        position: 3,
        label: 'Suporte',
        description: 'Tenho uma dúvida ou problema',
        matchKeywords: ['ajuda', 'suporte', 'problema', 'erro', 'dúvida'],
        targetLabelName: 'Suporte',
      },
    ],
  },
  {
    id: 'support',
    name: 'Suporte técnico',
    description: 'Helpdesk, SaaS, software com tickets',
    prompt: 'Olá {{contact.name}}! Precisa de ajuda? Selecione abaixo:',
    fallbackLabelName: 'Triagem',
    options: [
      {
        position: 1,
        label: 'Problema urgente',
        description: 'Sistema fora do ar ou bloqueado',
        matchKeywords: ['urgente', 'fora do ar', 'caiu', 'bug crítico', 'parou'],
        targetLabelName: 'Urgente',
      },
      {
        position: 2,
        label: 'Dúvida de uso',
        description: 'Como funciona uma feature',
        matchKeywords: ['como', 'dúvida', 'uso', 'funciona'],
        targetLabelName: 'Dúvida',
      },
      {
        position: 3,
        label: 'Solicitar feature',
        description: 'Sugestão de melhoria',
        matchKeywords: ['feature', 'sugestão', 'melhoria', 'gostaria'],
        targetLabelName: 'Feature request',
      },
      {
        position: 4,
        label: 'Cobrança',
        description: 'Pagamento, plano, fatura',
        matchKeywords: ['fatura', 'pagamento', 'plano', 'cobrança', 'cartão'],
        targetLabelName: 'Cobrança',
      },
    ],
  },
  {
    id: 'agency',
    name: 'Agência',
    description: 'Agência de marketing/design com múltiplos serviços',
    prompt: 'Olá {{contact.name}}, que tipo de serviço você procura?',
    fallbackLabelName: 'Triagem',
    options: [
      {
        position: 1,
        label: 'Marketing digital',
        description: 'Tráfego pago, SEO, social',
        matchKeywords: ['marketing', 'tráfego', 'ads', 'seo', 'social media'],
        targetLabelName: 'Marketing',
        targetFunnelName: 'Vendas',
        targetStageName: 'Novo lead',
      },
      {
        position: 2,
        label: 'Design',
        description: 'Identidade visual, web design',
        matchKeywords: ['design', 'logo', 'identidade', 'site', 'web'],
        targetLabelName: 'Design',
        targetFunnelName: 'Vendas',
        targetStageName: 'Novo lead',
      },
      {
        position: 3,
        label: 'Desenvolvimento',
        description: 'Sites, apps, sistemas',
        matchKeywords: ['site', 'app', 'sistema', 'dev', 'programação'],
        targetLabelName: 'Dev',
        targetFunnelName: 'Vendas',
        targetStageName: 'Novo lead',
      },
      {
        position: 4,
        label: 'Outro',
        description: 'Outro tipo de projeto',
        matchKeywords: [],
        targetLabelName: 'Geral',
      },
    ],
  },
];

export function findPresetById(id: string): WelcomePreset | null {
  return WELCOME_PRESETS.find((p) => p.id === id) ?? null;
}
```

- [ ] **Step 2: Build shared**

```bash
export PATH="$HOME/.node22-portable/node-v22.13.1-win-x64:$PATH"
pnpm --filter @neura/shared build
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/welcome-presets.ts
git commit -m "feat(shared): adiciona 4 welcome presets (e-commerce/services/support/agency)"
```

---

## Task 2: API endpoints presets

**Files:**
- Create: `apps/api/src/routes/welcome-presets.ts`
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Criar route**

Create `apps/api/src/routes/welcome-presets.ts`:

```typescript
import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';
import { requirePermission } from '../middlewares/permissions.js';
import { audit } from '../services/audit.js';
import { publishEvent } from '../redis-pub.js';
import { WELCOME_PRESETS, findPresetById } from '@neura/shared/welcome-presets';

export const welcomePresetsRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

/**
 * GET /api/welcome-presets
 * Lista de presets disponíveis (estático, vem do shared).
 */
welcomePresetsRouter.get('/welcome-presets', requireAuth, requireWorkspace, async (c) => {
  return c.json({ presets: WELCOME_PRESETS });
});

/**
 * POST /api/inboxes/:inboxId/welcome-flow/apply-preset
 * Body: { presetId: string }
 * Cria flow + options no inbox usando o preset. Se já existir flow, retorna 409.
 *
 * Resolução de labels/funnels/stages:
 * - Procura por nome case-insensitive no workspace
 * - Se não existir, CRIA (label com cor default, funnel se não houver, stage)
 */
welcomePresetsRouter.post(
  '/inboxes/:inboxId/welcome-flow/apply-preset',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.connect'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const { inboxId } = c.req.param();
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ presetId: z.string() }).safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);

    const preset = findPresetById(parsed.data.presetId);
    if (!preset) return c.json({ error: 'preset_not_found' }, 404);

    const inbox = await prisma.inbox.findFirst({
      where: { id: inboxId, workspaceId },
      select: { id: true },
    });
    if (!inbox) return c.json({ error: 'inbox_not_found' }, 404);

    const existing = await prisma.welcomeFlow.findUnique({
      where: { inboxId },
      select: { id: true },
    });
    if (existing) return c.json({ error: 'flow_already_exists' }, 409);

    // Resolve / criar labels
    const labelNamesNeeded = new Set<string>();
    for (const opt of preset.options) labelNamesNeeded.add(opt.targetLabelName);
    if (preset.fallbackLabelName) labelNamesNeeded.add(preset.fallbackLabelName);

    const existingLabels = await prisma.label.findMany({
      where: {
        workspaceId,
        name: { in: [...labelNamesNeeded], mode: 'insensitive' },
      },
    });
    const labelByName = new Map(existingLabels.map((l) => [l.name.toLowerCase(), l]));

    for (const name of labelNamesNeeded) {
      if (!labelByName.has(name.toLowerCase())) {
        const created = await prisma.label.create({
          data: { workspaceId, name, color: '#94a3b8', scope: 'BOTH' },
        });
        labelByName.set(name.toLowerCase(), created);
      }
    }

    // Resolve / criar funnels + stages
    const funnelNamesNeeded = new Set<string>();
    for (const opt of preset.options) {
      if (opt.targetFunnelName) funnelNamesNeeded.add(opt.targetFunnelName);
    }
    if (preset.fallbackFunnelName) funnelNamesNeeded.add(preset.fallbackFunnelName);

    const existingFunnels = await prisma.funnel.findMany({
      where: { workspaceId, name: { in: [...funnelNamesNeeded], mode: 'insensitive' } },
      include: { stages: true },
    });
    const funnelByName = new Map(existingFunnels.map((f) => [f.name.toLowerCase(), f]));

    for (const name of funnelNamesNeeded) {
      if (!funnelByName.has(name.toLowerCase())) {
        const created = await prisma.funnel.create({
          data: {
            workspaceId,
            name,
            stages: {
              create: [
                { name: 'Novo lead', order: 0 },
                { name: 'Qualificado', order: 1 },
                { name: 'Proposta', order: 2 },
                { name: 'Fechado', order: 3, outcome: 'POSITIVE' },
                { name: 'Perdido', order: 4, outcome: 'NEGATIVE' },
              ],
            },
          },
          include: { stages: true },
        });
        funnelByName.set(name.toLowerCase(), created);
      }
    }

    // Cria o flow + options
    const flow = await prisma.welcomeFlow.create({
      data: {
        workspaceId,
        inboxId,
        prompt: preset.prompt,
        enabled: true,
        maxAttempts: 2,
        fallbackTimeoutMinutes: 2,
        fallbackLabelId: preset.fallbackLabelName
          ? labelByName.get(preset.fallbackLabelName.toLowerCase())?.id ?? null
          : null,
        options: {
          create: preset.options.map((opt) => {
            const label = labelByName.get(opt.targetLabelName.toLowerCase());
            if (!label) throw new Error(`Label not resolved: ${opt.targetLabelName}`);
            let funnelId: string | undefined;
            let stageId: string | undefined;
            if (opt.targetFunnelName) {
              const funnel = funnelByName.get(opt.targetFunnelName.toLowerCase());
              if (funnel) {
                funnelId = funnel.id;
                const stage = opt.targetStageName
                  ? funnel.stages.find(
                      (s) => s.name.toLowerCase() === opt.targetStageName!.toLowerCase(),
                    )
                  : funnel.stages.find((s) => s.order === 0);
                stageId = stage?.id;
              }
            }
            return {
              position: opt.position,
              label: opt.label,
              description: opt.description ?? null,
              matchKeywords: opt.matchKeywords,
              targetLabelId: label.id,
              targetFunnelId: funnelId ?? null,
              targetStageId: stageId ?? null,
            };
          }),
        },
      },
      include: { options: true },
    });

    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'welcome_flow.preset_applied',
      resource: `WelcomeFlow:${flow.id}`,
      metadata: { presetId: preset.id, inboxId },
    });

    await publishEvent(workspaceId, 'settings', 'welcome_flow.created', {
      inboxId,
      flowId: flow.id,
      fromPreset: preset.id,
    });

    return c.json({ flow }, 201);
  },
);
```

- [ ] **Step 2: Wire em index.ts**

```typescript
import { welcomePresetsRouter } from './routes/welcome-presets.js';
// ...
app.route('/api', welcomePresetsRouter);
```

- [ ] **Step 3: Build shared (re-export se necessário)**

`@neura/shared/welcome-presets` precisa ser importável. Verificar `packages/shared/package.json` exports field — pode precisar adicionar:

```json
"./welcome-presets": "./dist/welcome-presets.js"
```

(Look at the existing exports field — if it uses wildcards `"./*"`, no change needed.)

```bash
pnpm --filter @neura/shared build
pnpm --filter @neura/api typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/welcome-presets.ts apps/api/src/index.ts packages/shared/package.json 2>/dev/null || true
git add apps/api/src/routes/welcome-presets.ts apps/api/src/index.ts
git commit -m "feat(api): routes welcome-presets (GET list + POST apply-preset)"
```

---

## Task 3: Wizard dialog component

**Files:**
- Create: `apps/web/src/components/inbox/welcome-flow-wizard-dialog.tsx`

- [ ] **Step 1: Criar dialog**

```typescript
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Sparkles, Wand2, ArrowRight, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface Preset {
  id: string;
  name: string;
  description: string;
  prompt: string;
  options: Array<{ position: number; label: string }>;
}

interface Props {
  inboxId: string;
  inboxName: string;
  open: boolean;
  onClose: () => void;
}

export function WelcomeFlowWizardDialog({ inboxId, inboxName, open, onClose }: Props) {
  const router = useRouter();
  const qc = useQueryClient();
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);

  const { data } = useQuery<{ presets: Preset[] }>({
    queryKey: ['welcome-presets'],
    queryFn: () => api('/api/welcome-presets'),
    enabled: open,
  });

  const applyMut = useMutation({
    mutationFn: (presetId: string) =>
      api(`/api/inboxes/${inboxId}/welcome-flow/apply-preset`, {
        method: 'POST',
        body: JSON.stringify({ presetId }),
      }),
    onSuccess: () => {
      toast.success('Fluxo aplicado!');
      qc.invalidateQueries({ queryKey: ['welcome-flows-list'] });
      qc.invalidateQueries({ queryKey: ['welcome-flow', inboxId] });
      onClose();
      router.push(`/settings/welcome-flows/${inboxId}`);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'flow_already_exists') {
        toast.error('Esta inbox já tem um fluxo configurado');
        onClose();
        return;
      }
      toast.error(err instanceof Error ? err.message : 'Erro ao aplicar preset');
    },
  });

  function startFromScratch() {
    onClose();
    router.push(`/settings/welcome-flows/${inboxId}`);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-5 w-5 text-violet-600" />
            Configurar fluxo de boas-vindas
          </DialogTitle>
          <DialogDescription>
            Inbox <strong>{inboxName}</strong> está pronta. Quer configurar uma mensagem
            automática inicial com opções pra classificar conversas?
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm font-medium">Escolha um preset:</p>
          <div className="grid grid-cols-2 gap-3">
            {data?.presets.map((p) => {
              const isSelected = selectedPreset === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedPreset(p.id)}
                  className={`text-left rounded-lg border p-3 transition-colors ${
                    isSelected
                      ? 'border-violet-500 bg-violet-50'
                      : 'border-border bg-card hover:border-foreground'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <p className="font-medium text-sm">{p.name}</p>
                    {isSelected && <Sparkles className="h-3.5 w-3.5 text-violet-600" />}
                  </div>
                  <p className="text-xs text-muted-foreground mb-2">{p.description}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {p.options.length} opções
                  </p>
                </button>
              );
            })}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            <X className="mr-1 h-4 w-4" />
            Pular
          </Button>
          <Button type="button" variant="outline" onClick={startFromScratch}>
            Começar do zero
            <ArrowRight className="ml-1 h-4 w-4" />
          </Button>
          <Button
            type="button"
            disabled={!selectedPreset || applyMut.isPending}
            onClick={() => selectedPreset && applyMut.mutate(selectedPreset)}
          >
            {applyMut.isPending ? 'Aplicando…' : 'Aplicar preset'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
./apps/web/node_modules/.bin/tsc -p apps/web --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/inbox/welcome-flow-wizard-dialog.tsx
git commit -m "feat(web): wizard dialog 'configure welcome flow' com escolha de preset"
```

---

## Task 4: Mount wizard pós create-inbox

**Files:**
- Modify: `apps/web/src/components/forms/create-inbox-form.tsx`

- [ ] **Step 1: Adicionar estado + render dialog**

Read the existing `create-inbox-form.tsx` to find the create handler. After successful create (where the response includes the new inbox), trigger the wizard:

```typescript
import { useState } from 'react';
import { WelcomeFlowWizardDialog } from '@/components/inbox/welcome-flow-wizard-dialog';

// No componente, junto com outros useState:
const [wizardInbox, setWizardInbox] = useState<{ id: string; name: string } | null>(null);

// No success handler do create (após receber `response.inbox` ou similar):
setWizardInbox({ id: response.inbox.id, name: response.inbox.name });

// No JSX, junto com outros dialogs renderizados:
{wizardInbox && (
  <WelcomeFlowWizardDialog
    inboxId={wizardInbox.id}
    inboxName={wizardInbox.name}
    open={!!wizardInbox}
    onClose={() => setWizardInbox(null)}
  />
)}
```

**Adapt to actual code**: read the file to find:
1. Where create succeeds (might be `.then(r => ...)` or `await api(...)` block)
2. The shape of the response (look for `r.inbox` or similar)
3. Where to put the dialog render (probably at the bottom of the form's return)

- [ ] **Step 2: Typecheck**

```bash
./apps/web/node_modules/.bin/tsc -p apps/web --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/forms/create-inbox-form.tsx
git commit -m "feat(web): abrir wizard de welcome flow após criar inbox nova"
```

---

## Task 5: Editor — validações inline (min 1, max 10 options)

**Files:**
- Modify: `apps/web/src/components/settings/welcome-flow-options-editor.tsx`
- Modify: `apps/web/src/app/(app)/settings/welcome-flows/[inboxId]/page.tsx`

- [ ] **Step 1: Avisar quando enabled=true sem options**

No editor da inbox page, antes do botão Salvar, adicionar warning:

```typescript
{watch('enabled') && hasFlow && data.flow.options.length === 0 && (
  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
    <strong>Atenção:</strong> O fluxo está marcado como ativo mas não tem opções configuradas.
    Adicione pelo menos uma opção abaixo antes de salvar, ou desative o toggle.
  </div>
)}
```

- [ ] **Step 2: Aviso visual no options editor quando 10 atingido**

In `welcome-flow-options-editor.tsx`, when items.length === 10, replace the empty state hint area with:

```typescript
{items.length === 10 && (
  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
    Limite máximo de 10 opções atingido (restrição do WhatsApp listMessage).
  </p>
)}
```

- [ ] **Step 3: Typecheck + commit**

```bash
./apps/web/node_modules/.bin/tsc -p apps/web --noEmit
git add apps/web/src/components/settings/welcome-flow-options-editor.tsx apps/web/src/app/\(app\)/settings/welcome-flows/\[inboxId\]/page.tsx
git commit -m "feat(web): validações inline no editor (warn enabled-sem-opções + max-10)"
```

---

## Task 6: Empty states polish

**Files:**
- Modify: `apps/web/src/app/(app)/settings/welcome-flows/page.tsx`

- [ ] **Step 1: Melhorar empty state da list page**

Find the existing empty state (when `data?.inboxes.length === 0`). Replace with:

```typescript
{data?.inboxes && data.inboxes.length === 0 && (
  <div className="rounded-lg border-2 border-dashed bg-card p-12 text-center">
    <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-4">
      <MessageSquarePlus className="h-6 w-6 text-muted-foreground" />
    </div>
    <h3 className="text-lg font-semibold mb-1">Nenhuma inbox configurada</h3>
    <p className="text-sm text-muted-foreground mb-4">
      Crie uma inbox primeiro pra configurar o fluxo de boas-vindas.
    </p>
    <Link href="/inboxes">
      <Button>
        <Plus className="mr-2 h-4 w-4" />
        Criar inbox
      </Button>
    </Link>
  </div>
)}
```

Add `Plus` and `Link` imports if missing.

- [ ] **Step 2: Typecheck + commit**

```bash
./apps/web/node_modules/.bin/tsc -p apps/web --noEmit
git add apps/web/src/app/\(app\)/settings/welcome-flows/page.tsx
git commit -m "feat(web): empty state com CTA pra criar inbox quando nenhuma existe"
```

---

## Task 7: Build final + smoke

**Files:** nenhum (validação)

- [ ] **Step 1: Build full**

```bash
export PATH="$HOME/.node22-portable/node-v22.13.1-win-x64:$PATH"
pnpm build
```

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

- [ ] **Step 4: Commit se necessário**

```bash
git add -A
git commit -m "chore(welcome-flow-fase-d): ajustes finais lint/typecheck" 2>/dev/null || true
```

---

## Critérios de Aceite — Fase D

- [ ] `pnpm build` PASS em todos os packages
- [ ] `pnpm typecheck` PASS
- [ ] Criar inbox nova → dialog wizard abre automaticamente
- [ ] 4 presets visíveis: E-commerce / Serviços / Suporte / Agência
- [ ] Selecionar preset + aplicar → flow criado com options corretas + redirect pro editor
- [ ] "Começar do zero" → fecha dialog + redirect pro editor vazio
- [ ] "Pular" → fecha dialog sem ação
- [ ] Aplicar preset 2x no mesmo inbox → 409 flow_already_exists toast
- [ ] Editor com enabled=true sem options → warning visível
- [ ] Editor com 10 options → "Adicionar" desabilitado + warning de limite
- [ ] Empty state da list page com CTA "Criar inbox"

## Próximas fases

- Welcome flow completo (Fases A-D + followups) — ship!
- Próximos features fora do welcome-flow: backlog separado.
