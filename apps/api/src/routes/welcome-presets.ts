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
