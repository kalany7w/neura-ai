import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { prisma } from '@neura/database';
import { requireWorkspace, type WorkspaceVars } from '../../src/middlewares/workspace.js';

/**
 * Isolamento multi-tenant no PONTO DE ENFORCEMENT real: o middleware
 * `requireWorkspace`. É a comporta que resolve o workspace ativo e valida que o
 * usuário é membro — se um user pedir um workspace do qual NÃO é membro (via
 * header X-Workspace-Id, sessão, ou apikey), tem que dar 403. Aqui montamos uma
 * mini-app Hono simulando a saída do requireAuth (userId/sessionId no contexto) e
 * rodamos o middleware DE VERDADE contra o Postgres do CI.
 */

let userA: { id: string };
let userB: { id: string };
let userNoWs: { id: string };
let wsA: { id: string };
let wsB: { id: string };

// App de teste: injeta a "sessão" (o que o requireAuth faria) e roda o requireWorkspace real.
function makeApp(fake: { userId: string; sessionId: string; apiKeyWorkspaceId?: string }) {
  const app = new Hono<{ Variables: WorkspaceVars }>();
  app.use('*', async (c, next) => {
    c.set('userId', fake.userId);
    c.set('sessionId', fake.sessionId);
    if (fake.apiKeyWorkspaceId) c.set('apiKeyWorkspaceId', fake.apiKeyWorkspaceId);
    await next();
  });
  app.use('*', requireWorkspace);
  app.get('/whoami', (c) => c.json({ workspaceId: c.get('workspaceId'), role: c.get('role') }));
  return app;
}

beforeAll(async () => {
  // welcomeFlow primeiro (cascata pra welcome_options, que tem Restrict pra
  // label) — sobra de outro arquivo de teste bloqueia o workspace.deleteMany
  // por FK (mesmo padrão do auto-routing.test.ts).
  await prisma.welcomeFlow.deleteMany();
  await prisma.session.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.account.deleteMany();
  await prisma.user.deleteMany();

  userA = await prisma.user.create({ data: { email: 'iso-a@test.com', name: 'Iso A' } });
  userB = await prisma.user.create({ data: { email: 'iso-b@test.com', name: 'Iso B' } });
  userNoWs = await prisma.user.create({ data: { email: 'iso-none@test.com', name: 'Iso None' } });
  wsA = await prisma.workspace.create({
    data: {
      name: 'Iso A',
      slug: 'iso-a',
      members: { create: { userId: userA.id, role: 'ADMIN' } },
    },
  });
  wsB = await prisma.workspace.create({
    data: {
      name: 'Iso B',
      slug: 'iso-b',
      members: { create: { userId: userB.id, role: 'AGENT' } },
    },
  });
});

afterAll(async () => {
  await prisma.session.deleteMany();
  await prisma.$disconnect();
});

describe('requireWorkspace — isolamento multi-tenant', () => {
  it('membro + header do próprio workspace → 200 com role correta', async () => {
    const res = await makeApp({ userId: userA.id, sessionId: 'sess-a-1' }).request('/whoami', {
      headers: { 'X-Workspace-Id': wsA.id },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaceId: wsA.id, role: 'ADMIN' });
  });

  it('NÃO-membro pedindo outro workspace via header → 403 forbidden_workspace', async () => {
    // userA tenta operar como workspace B (do qual não é membro).
    const res = await makeApp({ userId: userA.id, sessionId: 'sess-a-2' }).request('/whoami', {
      headers: { 'X-Workspace-Id': wsB.id },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden_workspace' });
  });

  it('activeWorkspaceId da sessão apontando pra workspace de que NÃO é membro → 403 (anti stale/forjado)', async () => {
    const sess = await prisma.session.create({
      data: {
        id: 'sess-a-stale',
        userId: userA.id,
        token: 'tok-a-stale',
        expiresAt: new Date(Date.now() + 86_400_000),
        activeWorkspaceId: wsB.id, // ficou apontando pra B (troca de membership, adulteração…)
      },
    });
    const res = await makeApp({ userId: userA.id, sessionId: sess.id }).request('/whoami');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden_workspace' });
  });

  it('activeWorkspaceId válido na sessão (sem header) → 200', async () => {
    const sess = await prisma.session.create({
      data: {
        id: 'sess-a-ok',
        userId: userA.id,
        token: 'tok-a-ok',
        expiresAt: new Date(Date.now() + 86_400_000),
        activeWorkspaceId: wsA.id,
      },
    });
    const res = await makeApp({ userId: userA.id, sessionId: sess.id }).request('/whoami');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaceId: wsA.id, role: 'ADMIN' });
  });

  it('sem header e sem sessão persistida → cai na 1ª membership do próprio user (não vaza pra outro)', async () => {
    // sessionId inexistente → session.findUnique null → fallback à 1ª membership (a de A).
    const res = await makeApp({ userId: userA.id, sessionId: 'sess-ghost' }).request('/whoami');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaceId: string; role: string };
    expect(body.workspaceId).toBe(wsA.id); // NUNCA wsB
    expect(body.role).toBe('ADMIN');
  });

  it('user sem nenhuma membership → 400 no_workspace_selected', async () => {
    const res = await makeApp({ userId: userNoWs.id, sessionId: 'sess-none' }).request('/whoami');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'no_workspace_selected' });
  });

  it('apikey: membership do dono ainda é validada (userA + workspace A) → 200', async () => {
    const res = await makeApp({
      userId: userA.id,
      sessionId: 'apikey:k1',
      apiKeyWorkspaceId: wsA.id,
    }).request('/whoami');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaceId: wsA.id, role: 'ADMIN' });
  });

  it('apikey cujo workspace não bate com a membership do dono → 403 (defense-in-depth)', async () => {
    const res = await makeApp({
      userId: userA.id,
      sessionId: 'apikey:k2',
      apiKeyWorkspaceId: wsB.id, // A não é membro de B
    }).request('/whoami');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden_workspace' });
  });
});
