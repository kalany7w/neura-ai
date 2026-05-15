/**
 * CRUD de CSAT/NPS surveys. Survey = template + config de disparo.
 *
 * Disparo: scheduler de `cancelCsatSend / enqueueCsatSend` invocados em
 * conversation status → RESOLVED. Não há trigger manual via endpoint (futuro
 * trabalho se cliente pedir).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { Prisma } from '@neura/database';
import { prisma } from '../db';
import { requireAuth, type AuthVars } from '../middlewares/auth';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace';
import { requirePermission } from '../middlewares/permissions';
import { audit } from '../services/audit';

export const csatSurveysRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

const baseSchema = {
  name: z.string().min(1).max(80),
  scoreType: z.enum(['CSAT', 'NPS', 'THUMBS']),
  channelScope: z.enum(['ALL', 'WHATSAPP', 'TELEGRAM', 'EMAIL']).default('ALL'),
  delayMinutes: z.number().int().min(0).max(7 * 24 * 60).default(5),
  messageBody: z.string().min(1).max(2000),
  thankYouMessage: z.string().max(2000).nullable().optional(),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
};

const createSchema = z.object(baseSchema);
const patchSchema = z.object({
  name: baseSchema.name.optional(),
  scoreType: baseSchema.scoreType.optional(),
  channelScope: baseSchema.channelScope.optional(),
  delayMinutes: baseSchema.delayMinutes.optional(),
  messageBody: baseSchema.messageBody.optional(),
  thankYouMessage: baseSchema.thankYouMessage,
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

csatSurveysRouter.get('/', requireAuth, requireWorkspace, requirePermission('csat.read'), async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const surveys = await prisma.csatSurvey.findMany({
    where: { workspaceId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
  return c.json({ surveys });
});

csatSurveysRouter.post(
  '/',
  requireAuth,
  requireWorkspace,
  requirePermission('csat.manage'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const userId = c.get('userId');

    try {
      // Se isDefault=true, desmarca outros
      if (parsed.data.isDefault) {
        await prisma.csatSurvey.updateMany({
          where: { workspaceId, isDefault: true },
          data: { isDefault: false },
        });
      }
      const survey = await prisma.csatSurvey.create({
        data: {
          workspaceId,
          name: parsed.data.name,
          scoreType: parsed.data.scoreType,
          channelScope: parsed.data.channelScope,
          delayMinutes: parsed.data.delayMinutes,
          messageBody: parsed.data.messageBody,
          thankYouMessage: parsed.data.thankYouMessage ?? null,
          enabled: parsed.data.enabled,
          isDefault: parsed.data.isDefault,
        },
      });
      void audit({
        workspaceId,
        actorId: userId,
        action: 'csat.survey_created',
        resource: `CsatSurvey:${survey.id}`,
        metadata: { name: survey.name, scoreType: survey.scoreType },
      });
      return c.json({ survey }, 201);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
        return c.json({ error: 'name_taken' }, 409);
      }
      throw err;
    }
  },
);

csatSurveysRouter.patch(
  '/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('csat.manage'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.csatSurvey.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);

    if (parsed.data.isDefault === true) {
      await prisma.csatSurvey.updateMany({
        where: { workspaceId, isDefault: true, NOT: { id } },
        data: { isDefault: false },
      });
    }
    const data: Prisma.CsatSurveyUpdateInput = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.scoreType !== undefined) data.scoreType = parsed.data.scoreType;
    if (parsed.data.channelScope !== undefined) data.channelScope = parsed.data.channelScope;
    if (parsed.data.delayMinutes !== undefined) data.delayMinutes = parsed.data.delayMinutes;
    if (parsed.data.messageBody !== undefined) data.messageBody = parsed.data.messageBody;
    if (parsed.data.thankYouMessage !== undefined) data.thankYouMessage = parsed.data.thankYouMessage;
    if (parsed.data.enabled !== undefined) data.enabled = parsed.data.enabled;
    if (parsed.data.isDefault !== undefined) data.isDefault = parsed.data.isDefault;
    try {
      const survey = await prisma.csatSurvey.update({ where: { id }, data });
      return c.json({ survey });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
        return c.json({ error: 'name_taken' }, 409);
      }
      throw err;
    }
  },
);

csatSurveysRouter.delete(
  '/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('csat.manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.csatSurvey.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    await prisma.csatSurvey.delete({ where: { id } });
    void audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'csat.survey_deleted',
      resource: `CsatSurvey:${id}`,
      metadata: { name: existing.name },
    });
    return c.json({ ok: true });
  },
);
