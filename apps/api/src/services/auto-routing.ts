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
  assignAgentId?: string | null;
}

/**
 * Aplica label na conversa. Se a label tem routesToFunnelId, cria card no
 * funil+stage destino (idempotente: não cria duplicado se já existe card
 * ativo nesse funil — stages com outcome POSITIVE/NEGATIVE não contam).
 *
 * Source identifica quem disparou — usado em audit log + WS payload.
 */
export async function applyTagWithRouting(params: ApplyTagParams): Promise<void> {
  const { workspaceId, conversationId, labelId, source, actorId = null, assignAgentId } = params;

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

  // Atribuir agente se especificado + validar membership
  if (assignAgentId) {
    const member = await prisma.membership.findFirst({
      where: { userId: assignAgentId, workspaceId },
      select: { id: true },
    });
    if (member) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { assignedAgentId: assignAgentId },
      });
      await publishEvent(workspaceId, 'conversations', 'conversation.assigned', {
        conversationId,
        assignedAgentId: assignAgentId,
        reason: source,
      });
    } else {
      logger.warn(
        { workspaceId, conversationId, assignAgentId },
        'applyTagWithRouting: assignAgentId not member of workspace, skipping assignment',
      );
    }
  }

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
      // Resolve title + position no padrão do default-funnel path (waworker events.ts):
      // title = contact.name ?? phoneNumber, position = max(position) + 1 no stage.
      const [conv, maxPos] = await Promise.all([
        prisma.conversation.findUnique({
          where: { id: conversationId },
          select: { contact: { select: { name: true, phoneNumber: true } } },
        }),
        prisma.card.aggregate({
          where: { stageId: label.routesToStageId },
          _max: { position: true },
        }),
      ]);
      const cardTitle =
        conv?.contact?.name ??
        conv?.contact?.phoneNumber ??
        `Conversa #${conversationId.slice(-6)}`;
      const cardPosition = (maxPos._max.position ?? -1) + 1;

      // Tenta criar card. Race: dois calls concurrent podem ambos passar o
      // findFirst e tentar create — partial unique index
      // cards_conversationId_funnelId_active_uniq bloqueia o 2º com P2002.
      // Tratamos como no-op idempotente (algum outro thread já criou).
      let card: { id: string } | null = null;
      try {
        card = await prisma.card.create({
          data: {
            workspaceId,
            funnelId: label.routesToFunnelId,
            stageId: label.routesToStageId,
            conversationId,
            title: cardTitle,
            position: cardPosition,
          },
          select: { id: true },
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'P2002') {
          logger.debug(
            { workspaceId, conversationId, funnelId: label.routesToFunnelId },
            'auto-routing: card already exists (unique constraint race), skip',
          );
          return;
        }
        throw err;
      }

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

      void audit({
        workspaceId,
        actorId,
        action: AUDIT_ACTIONS.CARD_AUTO_ROUTED,
        resource: `card:${card.id}`,
        metadata: { source, labelId, conversationId, funnelId: label.routesToFunnelId },
      });
    }
  }
}
