import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@neura/database';

let userA: { id: string; email: string };
let userB: { id: string; email: string };
let wsA: { id: string };
let wsB: { id: string };

beforeAll(async () => {
  // Limpa tudo (CI tem DB dedicado)
  await prisma.auditLog.deleteMany();
  await prisma.invite.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.session.deleteMany();
  await prisma.account.deleteMany();
  await prisma.verification.deleteMany();
  await prisma.user.deleteMany();

  userA = await prisma.user.create({ data: { email: 'a@test.com', name: 'User A' } });
  userB = await prisma.user.create({ data: { email: 'b@test.com', name: 'User B' } });
  wsA = await prisma.workspace.create({
    data: {
      name: 'Workspace A',
      slug: 'ws-a',
      members: { create: { userId: userA.id, role: 'ADMIN' } },
    },
  });
  wsB = await prisma.workspace.create({
    data: {
      name: 'Workspace B',
      slug: 'ws-b',
      members: { create: { userId: userB.id, role: 'ADMIN' } },
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('multi-tenant isolation', () => {
  it('user A is admin of workspace A only', async () => {
    const memberA = await prisma.membership.findUnique({
      where: { userId_workspaceId: { userId: userA.id, workspaceId: wsA.id } },
    });
    expect(memberA?.role).toBe('ADMIN');

    const memberAInB = await prisma.membership.findUnique({
      where: { userId_workspaceId: { userId: userA.id, workspaceId: wsB.id } },
    });
    expect(memberAInB).toBeNull();
  });

  it('user B cannot access workspace A through membership', async () => {
    const memberBInA = await prisma.membership.findUnique({
      where: { userId_workspaceId: { userId: userB.id, workspaceId: wsA.id } },
    });
    expect(memberBInA).toBeNull();
  });

  it('audit log is scoped by workspace', async () => {
    await prisma.auditLog.create({
      data: { workspaceId: wsA.id, actorId: userA.id, action: 'test.action_A' },
    });
    await prisma.auditLog.create({
      data: { workspaceId: wsB.id, actorId: userB.id, action: 'test.action_B' },
    });

    const logsA = await prisma.auditLog.findMany({ where: { workspaceId: wsA.id } });
    const logsB = await prisma.auditLog.findMany({ where: { workspaceId: wsB.id } });

    expect(logsA).toHaveLength(1);
    expect(logsA[0]!.action).toBe('test.action_A');
    expect(logsB).toHaveLength(1);
    expect(logsB[0]!.action).toBe('test.action_B');
  });

  it('slug is unique across workspaces', async () => {
    await expect(
      prisma.workspace.create({
        data: {
          name: 'Duplicate',
          slug: 'ws-a',
          members: { create: { userId: userA.id, role: 'ADMIN' } },
        },
      }),
    ).rejects.toThrow();
  });

  it('cascade delete workspace removes memberships', async () => {
    const tmpUser = await prisma.user.create({ data: { email: 'tmp@test.com', name: 'Tmp' } });
    const tmpWs = await prisma.workspace.create({
      data: {
        name: 'Temp',
        slug: 'tmp-ws',
        members: { create: { userId: tmpUser.id, role: 'ADMIN' } },
      },
    });
    await prisma.workspace.delete({ where: { id: tmpWs.id } });
    const orphanMembership = await prisma.membership.findFirst({
      where: { workspaceId: tmpWs.id },
    });
    expect(orphanMembership).toBeNull();
  });
});
