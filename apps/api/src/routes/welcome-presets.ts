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

    // ORDEM: funnels primeiro, labels depois. As labels precisam saber funnelId+stageId
    // pra setar routesToFunnelId/StageId no momento da criação (escopo de visibilidade
    // multi-empresa: label de XAG não aparece em cards de Caltech).

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

    // Helper pra resolver funnel+stage de uma opção (ou fallback)
    function resolveFunnelStage(
      funnelName: string | undefined | null,
      stageName: string | undefined | null,
    ): { funnelId: string | null; stageId: string | null } {
      if (!funnelName) return { funnelId: null, stageId: null };
      const funnel = funnelByName.get(funnelName.toLowerCase());
      if (!funnel) return { funnelId: null, stageId: null };
      const stage = stageName
        ? funnel.stages.find((s) => s.name.toLowerCase() === stageName.toLowerCase())
        : funnel.stages.find((s) => s.order === 0);
      return { funnelId: funnel.id, stageId: stage?.id ?? null };
    }

    // Resolve / criar labels (já com routesToFunnelId/StageId do funnel destino)
    const labelNamesNeeded = new Map<string, { funnelId: string | null; stageId: string | null }>();
    for (const opt of preset.options) {
      const route = resolveFunnelStage(opt.targetFunnelName, opt.targetStageName);
      labelNamesNeeded.set(opt.targetLabelName.toLowerCase(), {
        ...route,
        // Preserva o nome original (case) — usa Map<lowercase, route>; nome real vem do preset.
      });
    }
    if (preset.fallbackLabelName) {
      const key = preset.fallbackLabelName.toLowerCase();
      if (!labelNamesNeeded.has(key)) {
        // Fallback geralmente não tem funnel atrelado — fica como label global.
        labelNamesNeeded.set(key, {
          ...resolveFunnelStage(preset.fallbackFunnelName, null),
        });
      }
    }

    const existingLabels = await prisma.label.findMany({
      where: {
        workspaceId,
        name: { in: [...labelNamesNeeded.keys()], mode: 'insensitive' },
      },
    });
    const labelByName = new Map(existingLabels.map((l) => [l.name.toLowerCase(), l]));

    // Mapa de nome lowercase → nome original do preset (preserva case na criação)
    const originalNames = new Map<string, string>();
    for (const opt of preset.options) {
      originalNames.set(opt.targetLabelName.toLowerCase(), opt.targetLabelName);
    }
    if (preset.fallbackLabelName) {
      originalNames.set(preset.fallbackLabelName.toLowerCase(), preset.fallbackLabelName);
    }

    for (const [key, route] of labelNamesNeeded) {
      const existing = labelByName.get(key);
      if (existing) {
        // Se label já existe sem routesToFunnelId e o preset tem um — heal: anexa o funil.
        // Não sobrescreve se já estiver vinculado a outro funil (admin pode ter editado).
        if (existing.routesToFunnelId == null && route.funnelId) {
          const healed = await prisma.label.update({
            where: { id: existing.id },
            data: { routesToFunnelId: route.funnelId, routesToStageId: route.stageId },
          });
          labelByName.set(key, healed);
        }
        continue;
      }
      const created = await prisma.label.create({
        data: {
          workspaceId,
          name: originalNames.get(key) ?? key,
          color: '#94a3b8',
          scope: 'BOTH',
          routesToFunnelId: route.funnelId,
          routesToStageId: route.stageId,
        },
      });
      labelByName.set(key, created);
    }

    // Resolve targetUserName por nome — busca via Membership + User.name
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
        fallbackUserId: preset.fallbackUserName
          ? userByName.get(preset.fallbackUserName.toLowerCase()) ?? null
          : null,
        options: {
          create: preset.options.map((opt) => {
            const label = labelByName.get(opt.targetLabelName.toLowerCase());
            if (!label) throw new Error(`Label not resolved: ${opt.targetLabelName}`);
            const route = resolveFunnelStage(opt.targetFunnelName, opt.targetStageName);
            return {
              position: opt.position,
              label: opt.label,
              description: opt.description ?? null,
              matchKeywords: opt.matchKeywords,
              targetLabelId: label.id,
              targetFunnelId: route.funnelId,
              targetStageId: route.stageId,
              targetUserId: opt.targetUserName
                ? userByName.get(opt.targetUserName.toLowerCase()) ?? null
                : null,
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
