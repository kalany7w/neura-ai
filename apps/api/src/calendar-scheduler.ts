import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { prisma } from './db.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { publishEvent } from './redis-pub.js';
import { createNotification } from './services/notifications.js';

const QUEUE_CALENDAR = 'calendar-reminders';
const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const calendarQueue = new Queue(QUEUE_CALENDAR, {
  connection: bullConnection,
  defaultJobOptions: { removeOnComplete: true, removeOnFail: { age: 24 * 60 * 60 } },
});

/**
 * Dispara reminders pra eventos cujo eventDate já chegou (<= now), status SCHEDULED,
 * sem reminder enviado. Notifica o assignedUser (ou todos os members se sem responsável).
 */
async function fireReminders(_job: Job): Promise<void> {
  const now = new Date();
  const due = await prisma.calendarEvent.findMany({
    where: {
      eventDate: { lte: now },
      status: 'SCHEDULED',
      reminderSentAt: null,
    },
    include: {
      assignedUser: { select: { id: true } },
      contact: { select: { name: true } },
    },
    take: 100,
  });

  for (const ev of due) {
    // Marca reminder enviado primeiro (idempotência)
    await prisma.calendarEvent.update({
      where: { id: ev.id },
      data: { reminderSentAt: now },
    });

    const title = `Evento hoje: ${ev.title}`;
    const body = ev.contact?.name ? `Cliente: ${ev.contact.name}` : undefined;
    const link = ev.conversationId ? `/inbox/${ev.conversationId}` : '/calendar';

    if (ev.assignedUserId) {
      await createNotification({
        workspaceId: ev.workspaceId,
        userId: ev.assignedUserId,
        kind: 'calendar.reminder',
        title,
        body,
        link,
        metadata: { eventId: ev.id, type: ev.type },
      });
    } else {
      const members = await prisma.membership.findMany({
        where: { workspaceId: ev.workspaceId },
        select: { userId: true },
      });
      for (const m of members) {
        await createNotification({
          workspaceId: ev.workspaceId,
          userId: m.userId,
          kind: 'calendar.reminder',
          title,
          body,
          link,
          metadata: { eventId: ev.id, type: ev.type },
        });
      }
    }

    await publishEvent(ev.workspaceId, 'calendar', 'calendar_event.reminder', { eventId: ev.id });
  }

  if (due.length > 0) {
    logger.info({ count: due.length }, 'calendar-scheduler: reminders disparados');
  }
}

export const calendarWorker = new Worker(QUEUE_CALENDAR, fireReminders, {
  connection: bullConnection,
});

calendarWorker.on('failed', (job, err) =>
  logger.error({ err, jobId: job?.id }, 'Calendar reminder job failed'),
);

export async function startCalendarScheduler(): Promise<void> {
  await calendarQueue.add(
    'tick',
    {},
    { repeat: { every: 5 * 60 * 1000 }, jobId: 'calendar-reminder-tick' },
  );
  logger.info('Calendar scheduler iniciado (poll 5min)');
}
