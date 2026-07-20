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
  // Se já existe card ativo nesse funil, MOVE pro stage destino (em vez de skip).
  // Usado pelo welcome flow: conversa entra em New Lead no envio e é movida pra
  // coluna da opção quando o cliente responde.
  moveIfExists?: boolean;
  // Override explícito do funil/stage destino. Tem precedência sobre as rotas da label.
  // O welcome flow passa o fallback do flow (New Lead) — assim não depende de a label
  // "Lead" ter routesToFunnel/Stage configurados em Etiquetas.
  funnelId?: string | null;
  stageId?: string | null;
}

/**
 * Aplica label na conversa. Se a label tem routesToFunnelId, cria card no
 * funil+stage destino (idempotente: não cria duplicado se já existe card
 * ativo nesse funil — stages com outcome POSITIVE/NEGATIVE não contam).
 *
 * Source identifica quem disparou — usado em audit log + WS payload.
 */
export async function applyTagWithRouting(params: ApplyTagParams): Promise<void> {
  const {
    workspaceId,
    conversationId,
    labelId,
    source,
    actorId = null,
    assignAgentId,
    moveIfExists = false,
    funnelId,
    stageId,
  } = params;

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

  // 3. Funil/stage destino: override explícito (welcome flow passa o fallback do flow)
  //    tem precedência sobre as rotas da label. Move um card ativo já existente nesse
  //    funil pro stage destino (quando moveIfExists), ou cria um novo. Sem moveIfExists
  //    é idempotente (skip).
  const routeFunnelId = funnelId ?? label.routesToFunnelId;
  const routeStageId = stageId ?? label.routesToStageId;
  if (routeFunnelId && routeStageId) {
    const existing = await prisma.card.findFirst({
      where: {
        conversationId,
        funnelId: routeFunnelId,
        // Apenas cards ativos contam (POSITIVE/NEGATIVE = fechado e não bloqueia novo card).
        // RISK e outcome=null continuam ativos. SQL notIn exclui nulls, daí o OR explícito.
        stage: {
          OR: [{ outcome: null }, { outcome: 'RISK' }],
        },
      },
      select: { id: true, stageId: true },
    });

    if (existing) {
      // Card já existe nesse funil. Move pro stage destino se pedido e ainda não estiver lá.
      if (moveIfExists && existing.stageId !== routeStageId) {
        const maxPos = await prisma.card.aggregate({
          where: { stageId: routeStageId },
          _max: { position: true },
        });
        await prisma.card.update({
          where: { id: existing.id },
          data: {
            stageId: routeStageId,
            position: (maxPos._max.position ?? -1) + 1,
          },
        });
        // Espelha a nova label no card (skipDuplicates: pode já ter)
        await prisma.cardLabel.createMany({
          data: [{ cardId: existing.id, labelId }],
          skipDuplicates: true,
        });
        await publishEvent(workspaceId, 'cards', 'card.moved', {
          cardId: existing.id,
          funnelId: routeFunnelId,
          stageId: routeStageId,
          conversationId,
          autoRouted: true,
          source,
        });
        void audit({
          workspaceId,
          actorId,
          action: AUDIT_ACTIONS.CARD_AUTO_ROUTED,
          resource: `card:${existing.id}`,
          metadata: { source, labelId, conversationId, funnelId: routeFunnelId, moved: true },
        });
      }
      return;
    }

    // Não existe card ativo nesse funil — cria.
    // Resolve title + position no padrão do default-funnel path (waworker events.ts):
    // title = contact.name ?? phoneNumber, position = max(position) + 1 no stage.
    const [conv, maxPos] = await Promise.all([
      prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { contact: { select: { name: true, phoneNumber: true } } },
      }),
      prisma.card.aggregate({
        where: { stageId: routeStageId },
        _max: { position: true },
      }),
    ]);
    const cardTitle =
      conv?.contact?.name ?? conv?.contact?.phoneNumber ?? `Conversa #${conversationId.slice(-6)}`;
    const cardPosition = (maxPos._max.position ?? -1) + 1;

    // Tenta criar card. Race: dois calls concurrent podem ambos passar o findFirst e
    // tentar create. Trata P2002 (unique violation) como no-op idempotente.
    let card: { id: string } | null = null;
    try {
      card = await prisma.card.create({
        data: {
          workspaceId,
          funnelId: routeFunnelId,
          stageId: routeStageId,
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
          { workspaceId, conversationId, funnelId: routeFunnelId },
          'auto-routing: card already exists (unique constraint race), skip',
        );
        return;
      }
      throw err;
    }

    // Espelhar label tambem no card
    await prisma.cardLabel.create({ data: { cardId: card.id, labelId } });

    await publishEvent(workspaceId, 'cards', 'card.created', {
      cardId: card.id,
      funnelId: routeFunnelId,
      stageId: routeStageId,
      conversationId,
      autoRouted: true,
      source,
    });

    void audit({
      workspaceId,
      actorId,
      action: AUDIT_ACTIONS.CARD_AUTO_ROUTED,
      resource: `card:${card.id}`,
      metadata: { source, labelId, conversationId, funnelId: routeFunnelId },
    });
  }
}
