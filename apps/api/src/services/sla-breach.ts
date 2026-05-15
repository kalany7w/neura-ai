/**
 * SLA breach detection — chamado pelo automation-scheduler a cada tick.
 *
 * Detecta conversas que passaram do threshold FRT sem resposta de agente.
 * Cria Notification kind='sla.breach' pro agente atribuído (ou todos os
 * ADMIN/SUPERVISOR se sem agente).
 *
 * Idempotência: Conversation.slaBreachNotifiedAt seta ao notificar e zera
 * quando agente responde (patchFirstResponse limpa).
 */

import { prisma } from '../db';
import { logger } from '../logger';
import { publishEvent } from '../redis-pub';
import { resolveSlaPolicy } from './sla-policies';

const MAX_BATCH = 100;

interface BreachCandidate {
  id: string;
  workspaceId: string;
  inboxId: string;
  assignedAgentId: string | null;
  createdAt: Date;
  lastInboundAt: Date | null;
  contact: { name: string | null; phoneNumber: string };
}

export async function tickSlaBreachDetection(): Promise<void> {
  const now = new Date();
  // Procura conversas ativas sem firstResponseAt + lastInboundAt antigo
  // Filtro grosso: lastInboundAt < (now - 5min) — depois compara contra policy.
  const grossCutoff = new Date(now.getTime() - 5 * 60 * 1000);

  const candidates = await prisma.conversation.findMany({
    where: {
      archivedAt: null,
      status: { in: ['OPEN', 'PENDING'] },
      firstResponseAt: null,
      lastInboundAt: { not: null, lte: grossCutoff },
      slaBreachNotifiedAt: null, // não notifica de novo
    },
    select: {
      id: true,
      workspaceId: true,
      inboxId: true,
      assignedAgentId: true,
      createdAt: true,
      lastInboundAt: true,
      contact: { select: { name: true, phoneNumber: true } },
    },
    take: MAX_BATCH,
  });

  if (candidates.length === 0) return;

  // Agrupa por workspace pra resolver policies em batch
  for (const conv of candidates as BreachCandidate[]) {
    try {
      // Lê labels da conversa pra resolver policy por label se houver
      const labelLinks = await prisma.conversationLabel.findMany({
        where: { conversationId: conv.id },
        select: { labelId: true },
      });
      const labelIds = labelLinks.map((l) => l.labelId);

      const policy = await resolveSlaPolicy({
        workspaceId: conv.workspaceId,
        inboxId: conv.inboxId,
        labelIds,
      });
      if (!policy) continue;

      const referenceAt = conv.lastInboundAt ?? conv.createdAt;
      const ageMin = (now.getTime() - referenceAt.getTime()) / 60_000;
      if (ageMin < policy.firstResponseThresholdMin) continue;

      // Define destinatários: agente atribuído OR ADMIN+SUPERVISOR do workspace
      let recipientIds: string[] = [];
      if (conv.assignedAgentId) {
        recipientIds = [conv.assignedAgentId];
      } else {
        const supervisors = await prisma.membership.findMany({
          where: {
            workspaceId: conv.workspaceId,
            role: { in: ['ADMIN', 'SUPERVISOR'] },
          },
          select: { userId: true },
        });
        recipientIds = supervisors.map((s) => s.userId);
      }

      if (recipientIds.length === 0) continue;

      const contactLabel = conv.contact.name ?? conv.contact.phoneNumber;
      const overMin = Math.round(ageMin);
      const title = `⚠️ SLA estourou`;
      const body = `Cliente ${contactLabel} aguarda resposta há ${overMin}min (alvo: ${policy.firstResponseThresholdMin}min)`;
      const link = `/inbox/${conv.id}`;

      await prisma.notification.createMany({
        data: recipientIds.map((userId) => ({
          workspaceId: conv.workspaceId,
          userId,
          kind: 'sla.breach',
          title,
          body,
          link,
          metadata: {
            conversationId: conv.id,
            policyId: policy.id,
            ageMin: overMin,
            thresholdMin: policy.firstResponseThresholdMin,
          },
        })),
      });

      await prisma.conversation.update({
        where: { id: conv.id },
        data: { slaBreachNotifiedAt: now },
      });

      await publishEvent(conv.workspaceId, 'conversations', 'conversation.sla_breached', {
        conversationId: conv.id,
        policyId: policy.id,
        ageMin: overMin,
        thresholdMin: policy.firstResponseThresholdMin,
      });

      logger.info(
        {
          conversationId: conv.id,
          ageMin: overMin,
          thresholdMin: policy.firstResponseThresholdMin,
          recipients: recipientIds.length,
        },
        'SLA breach detected + notified',
      );
    } catch (err) {
      logger.warn({ err, conversationId: conv.id }, 'sla breach detect failed for conv');
    }
  }
}
