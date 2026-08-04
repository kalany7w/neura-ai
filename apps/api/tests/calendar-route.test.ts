import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { prisma } from '@neura/database';

let workspaceId: string;
let userId: string;
let contactId: string;

beforeAll(async () => {
  await prisma.calendarEvent.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany({ where: { email: { endsWith: '-cal@test.com' } } });

  const user = await prisma.user.create({ data: { email: 'cal@test.com', name: 'Cal User' } });
  userId = user.id;
  const ws = await prisma.workspace.create({
    data: { name: 'Cal WS', slug: 'cal-ws', members: { create: { userId, role: 'ADMIN' } } },
  });
  workspaceId = ws.id;
  const contact = await prisma.contact.create({
    data: { workspaceId, phoneNumber: '+595981999888', name: 'Felix' },
  });
  contactId = contact.id;
});

beforeEach(async () => {
  await prisma.calendarEvent.deleteMany();
});

describe('CalendarEvent — DB layer', () => {
  it('cria evento com vínculo a contato', async () => {
    const ev = await prisma.calendarEvent.create({
      data: {
        workspaceId,
        title: 'Aplicação de produto — Felix',
        eventDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
        type: 'APPLICATION',
        contactId,
        assignedUserId: userId,
        createdBy: userId,
      },
    });
    expect(ev.id).toBeTruthy();
    expect(ev.status).toBe('SCHEDULED');
    expect(ev.reminderSentAt).toBeNull();
  });

  it('query por range retorna eventos dentro do período', async () => {
    const today = new Date();
    const in10days = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const in40days = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);

    await prisma.calendarEvent.create({
      data: { workspaceId, title: 'Dentro', eventDate: in10days, createdBy: userId },
    });
    await prisma.calendarEvent.create({
      data: { workspaceId, title: 'Fora', eventDate: in40days, createdBy: userId },
    });

    const from = today;
    const to = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const events = await prisma.calendarEvent.findMany({
      where: { workspaceId, eventDate: { gte: from, lte: to } },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe('Dentro');
  });

  it('contact deletado → calendarEvent.contactId vira null (SetNull)', async () => {
    const contact2 = await prisma.contact.create({
      data: { workspaceId, phoneNumber: '+595981777666', name: 'Temp' },
    });
    const ev = await prisma.calendarEvent.create({
      data: {
        workspaceId,
        title: 'Test',
        eventDate: new Date(),
        contactId: contact2.id,
        createdBy: userId,
      },
    });
    await prisma.contact.delete({ where: { id: contact2.id } });
    const refetch = await prisma.calendarEvent.findUnique({ where: { id: ev.id } });
    expect(refetch?.contactId).toBeNull();
  });

  it('reminderSentAt funciona como flag de idempotência', async () => {
    const ev = await prisma.calendarEvent.create({
      data: {
        workspaceId,
        title: 'Reminder test',
        eventDate: new Date(Date.now() - 1000),
        status: 'SCHEDULED',
        createdBy: userId,
      },
    });
    const due = await prisma.calendarEvent.findMany({
      where: { eventDate: { lte: new Date() }, status: 'SCHEDULED', reminderSentAt: null },
    });
    expect(due.map((e) => e.id)).toContain(ev.id);

    await prisma.calendarEvent.update({
      where: { id: ev.id },
      data: { reminderSentAt: new Date() },
    });
    const dueAfter = await prisma.calendarEvent.findMany({
      where: { eventDate: { lte: new Date() }, status: 'SCHEDULED', reminderSentAt: null },
    });
    expect(dueAfter.map((e) => e.id)).not.toContain(ev.id);
  });
});
