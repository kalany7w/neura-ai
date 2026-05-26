import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { prisma } from '@neura/database';

async function setupFixtures() {
  // Cleanup em ordem de dependência
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
    data: { email: 'admin-wf@test.com', name: 'Admin WF' },
  });
  const ws = await prisma.workspace.create({
    data: {
      name: 'Test WF Route',
      slug: 'test-wf-route',
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

  it('bloqueia 2 flows na mesma inbox (unique inboxId)', async () => {
    await prisma.welcomeFlow.create({
      data: { workspaceId: fixtures.ws.id, inboxId: fixtures.inbox.id, prompt: 'A' },
    });
    await expect(
      prisma.welcomeFlow.create({
        data: { workspaceId: fixtures.ws.id, inboxId: fixtures.inbox.id, prompt: 'B' },
      }),
    ).rejects.toThrow();
  });

  it('adiciona option e respeita unique (flowId, position)', async () => {
    const flow = await prisma.welcomeFlow.create({
      data: { workspaceId: fixtures.ws.id, inboxId: fixtures.inbox.id, prompt: 'A' },
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
