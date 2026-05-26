import { prisma } from '../db.js';
import { publishEvent } from '../redis-pub.js';
import { audit, AUDIT_ACTIONS } from './audit.js';
import { logger } from '../logger.js';

type RoutingSource = 'welcome_flow' | 'manual_tag' | 'rule';

interface ApplyTagParams {
  workspaceId: string;
  conversationId: string;
  labelId: string;
  source: RoutingSource;
  actorId?: string | null;
}

/**
 * Aplica label na conversa. Se a label tem routesToFunnelId, cria card no
 * funil+stage destino (idempotente: não cria duplicado se já existe card
 * ativo nesse funil — stages com outcome POSITIVE/NEGATIVE não contam).
 *
 * Source identifica quem disparou — usado em audit log + WS payload.
 */
export async function applyTagWithRouting(params: ApplyTagParams): Promise<void> {
  const { workspaceId, conversationId, labelId, source, actorId = null } = params;

  // 1. Validar que label pertence ao workspace
  const label = await prisma.label.findFirst({
    where: { id: labelId, workspaceId },
    select: { id: true, routesToFunnelId: true, routesToStageId: true, name: true },
  });
  if (!label) {
    logger.warn({ workspaceId, conversationId, labelId }, 'Label not found in workspace');
    return;
  }

  // 2. Aplicar ConversationLabel (idempotente via upsert)
  await prisma.conversationLabel.upsert({
    where: { conversationId_labelId: { conversationId, labelId } },
    create: { conversationId, labelId },
    update: {},
  });

  await publishEvent(workspaceId, 'conversations', 'conversation.label_applied', {
    conversationId,
    labelId,
    labelName: label.name,
    source,
  });

  // 3. Se label rotear, criar card (idempotente: skip se já existe card ativo)
  if (label.routesToFunnelId && label.routesToStageId) {
    const existing = await prisma.card.findFirst({
      where: {
        conversationId,
        funnelId: label.routesToFunnelId,
        // Apenas cards ativos contam (POSITIVE/NEGATIVE = fechado e não bloqueia novo card).
        // RISK e outcome=null continuam ativos. SQL notIn exclui nulls, daí o OR explícito.
        stage: {
          OR: [{ outcome: null }, { outcome: 'RISK' }],
        },
      },
      select: { id: true },
    });

    if (!existing) {
      const card = await prisma.card.create({
        data: {
          workspaceId,
          funnelId: label.routesToFunnelId,
          stageId: label.routesToStageId,
          conversationId,
          title: `Conversa #${conversationId.slice(-6)}`,
        },
      });

      // Espelhar label tambem no card
      await prisma.cardLabel.create({ data: { cardId: card.id, labelId } });

      await publishEvent(workspaceId, 'kanban', 'card.created', {
        cardId: card.id,
        funnelId: label.routesToFunnelId,
        stageId: label.routesToStageId,
        conversationId,
        autoRouted: true,
        source,
      });

      audit({
        workspaceId,
        actorId,
        action: AUDIT_ACTIONS.CARD_AUTO_ROUTED,
        resource: `card:${card.id}`,
        metadata: { source, labelId, conversationId, funnelId: label.routesToFunnelId },
      });
    }
  }
}
