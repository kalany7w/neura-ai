import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';
import { presignUpload } from '../services/storage.js';

export const uploadsRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

const signSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(120),
  size: z
    .number()
    .int()
    .positive()
    .max(100 * 1024 * 1024)
    .optional(), // 100 MB cap
});

// POST /api/uploads/sign — gera presigned URL pra upload direto no MinIO
uploadsRouter.post('/sign', requireAuth, requireWorkspace, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = signSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
  }
  const workspaceId = c.get('workspaceId') as string;
  const presigned = await presignUpload({
    workspaceId,
    filename: parsed.data.filename,
    contentType: parsed.data.contentType,
    size: parsed.data.size,
  });
  return c.json(presigned);
});
