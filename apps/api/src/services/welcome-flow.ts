import type { SendMessageJob } from '@neura/shared/queue';
import { prisma } from '../db.js';
import { dispatchOutbound } from '../queue.js';
import { publishEvent } from '../redis-pub.js';
import { logger } from '../logger.js';
import { audit, AUDIT_ACTIONS } from './audit.js';
import { applyTagWithRouting } from './auto-routing.js';

type EnqueueOutboundFn = (job: SendMessageJob) => Promise<void>;

interface SendWelcomeDeps {
  enqueueOutbound?: EnqueueOutboundFn;
}

/**
 * Capitaliza a 1ª letra de cada palavra do nome. O pushName do WhatsApp costuma vir
 * minúsculo ("marcos") ou tudo maiúsculo ("MARCOS") — normaliza pra "Marcos",
 * "maylen jimenez" → "Maylen Jimenez". Usado só na saudação do welcome.
 */
function capitalizeName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

interface ShouldTriggerParams {
  workspaceId: string;
  conversationId: string;
  contactId: string;
}

/**
 * Decide se vale a pena disparar o welcome flow pra essa primeira mensagem.
 * Retorna false se: contato já respondeu antes, conversa já está aguardando
 * resposta, ou inbox não tem flow habilitado com opções.
 */
export async function shouldTriggerWelcome(params: ShouldTriggerParams): Promise<boolean> {
  const { workspaceId, conversationId, contactId } = params;

  const [contact, conversation] = await Promise.all([
    prisma.contact.findFirst({
      where: { id: contactId, workspaceId },
      select: { welcomeRespondedAt: true },
    }),
    prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: {
        inboxId: true,
        isAwaitingWelcomeChoice: true,
      },
    }),
  ]);

  if (!contact || !conversation) return false;
  if (contact.welcomeRespondedAt) return false;
  if (conversation.isAwaitingWelcomeChoice) return false;

  const flow = await prisma.welcomeFlow.findUnique({
    where: { inboxId: conversation.inboxId },
    select: { enabled: true, options: { select: { id: true }, take: 1 } },
  });

  if (!flow || !flow.enabled) return false;
  if (flow.options.length === 0) return false;

  return true;
}

interface SendWelcomeParams {
  workspaceId: string;
  conversationId: string;
}

/**
 * Envia o welcome: persiste Message do bot (AI_AGENT, OUTBOUND, TEXT pra
 * histórico), marca a conversa como awaiting + welcomeSentAt, enfileira
 * outbound INTERACTIVE (listMessage no Baileys). `deps.enqueueOutbound`
 * existe pra testes — em runtime usa `dispatchOutbound`.
 */
export async function sendWelcome(
  params: SendWelcomeParams,
  deps: SendWelcomeDeps = {},
): Promise<void> {
  const { workspaceId, conversationId } = params;
  const enqueue = deps.enqueueOutbound ?? dispatchOutbound;

  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: {
      inboxId: true,
      contact: { select: { id: true, phoneNumber: true, name: true } },
      inbox: { select: { name: true } },
    },
  });
  if (!conv || !conv.contact?.phoneNumber) {
    logger.warn({ conversationId }, 'sendWelcome: conversa ou contato inválido');
    return;
  }

  const flow = await prisma.welcomeFlow.findUnique({
    where: { inboxId: conv.inboxId },
    include: { options: { orderBy: { position: 'asc' } } },
  });
  if (!flow || !flow.enabled || flow.options.length === 0) {
    logger.warn({ conversationId }, 'sendWelcome: flow não habilitado ou sem opções');
    return;
  }

  // Substituir placeholders no prompt
  const prompt = flow.prompt.replace(
    /\{\{contact\.name\}\}/g,
    conv.contact.name ? capitalizeName(conv.contact.name) : 'cliente',
  );

  // Opções numeradas embutidas no corpo. WhatsApp via Baileys NÃO renderiza listMessage/
  // botões de forma confiável (Meta restringe mensagens interativas a libs oficiais) — o
  // cliente via só o prompt, sem as opções. Mandamos como TEXTO numerado; o parser entende
  // o número (além de keyword/IA). welcomeFallbackSent=true evita o retry reenviar o mesmo.
  const optionsText = flow.options.map((o) => `${o.position}. ${o.label}`).join('\n');
  const fullText = `${prompt}\n\n${optionsText}`;

  // Persistir Message do bot (AI_AGENT, OUTBOUND) — content já com as opções visíveis.
  const msg = await prisma.message.create({
    data: {
      conversationId,
      direction: 'OUTBOUND',
      type: 'TEXT',
      senderType: 'AI_AGENT',
      content: fullText,
      status: 'PENDING',
    },
  });

  // Marcar conversa awaiting. NOTE: welcomeAttempts é "tentativas do CLIENTE" (replies),
  // não tentativas de envio. parse_reply incrementa esse contador, send não.
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      isAwaitingWelcomeChoice: true,
      welcomeSentAt: new Date(),
      welcomeFallbackSent: true,
    },
  });

  // Enfileirar job TEXT (opções já no corpo)
  const job: SendMessageJob = {
    inboxId: conv.inboxId,
    workspaceId,
    conversationId,
    messageId: msg.id,
    to: conv.contact.phoneNumber,
    type: 'TEXT',
    text: fullText,
  };

  await enqueue(job);

  void audit({
    workspaceId,
    actorId: null,
    action: AUDIT_ACTIONS.WELCOME_TRIGGERED,
    resource: `conversation:${conversationId}`,
    metadata: { flowId: flow.id, optionsCount: flow.options.length },
  });

  await publishEvent(workspaceId, 'conversations', 'welcome.triggered', {
    conversationId,
    messageId: msg.id,
  });

  // Coloca a conversa em New Lead (funil/label fallback) já no envio do welcome — assim
  // clientes que ainda NÃO responderam (e os que escolherem a opção tipo "lead") ficam
  // visíveis no kanban. Quando responderem uma opção, a card é MOVIDA pra coluna certa
  // (welcome-worker chama applyTagWithRouting com moveIfExists). Idempotente: se já
  // existe card no funil, não duplica.
  if (flow.fallbackLabelId) {
    await applyTagWithRouting({
      workspaceId,
      conversationId,
      labelId: flow.fallbackLabelId,
      source: 'welcome_flow',
      assignAgentId: flow.fallbackUserId,
      // Usa o funil/stage explícito do fallback do flow (New Lead) — garante o landing
      // no kanban mesmo se a label fallback não tiver routesToFunnel/Stage em Etiquetas.
      funnelId: flow.fallbackFunnelId,
      stageId: flow.fallbackStageId,
    });
  }
}

interface MarkCompletedParams {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  optionId: string;
}

/**
 * Cliente respondeu uma opção válida. Limpa flag awaiting da conversa e
 * carimba o contato (pra que welcomes futuros — outras conversas — não
 * disparem). Audita + publica evento.
 */
export async function markCompleted(params: MarkCompletedParams): Promise<void> {
  const { workspaceId, conversationId, contactId, optionId } = params;

  await Promise.all([
    prisma.conversation.update({
      where: { id: conversationId },
      data: { isAwaitingWelcomeChoice: false },
    }),
    prisma.contact.update({
      where: { id: contactId },
      data: { welcomeRespondedAt: new Date() },
    }),
  ]);

  void audit({
    workspaceId,
    actorId: null,
    action: AUDIT_ACTIONS.WELCOME_COMPLETED,
    resource: `conversation:${conversationId}`,
    metadata: { optionId },
  });

  await publishEvent(workspaceId, 'conversations', 'welcome.completed', {
    conversationId,
    optionId,
  });
}

interface SendHandoffParams {
  workspaceId: string;
  conversationId: string;
  optionId: string;
}

/**
 * 2º mensagem do agente IA: confirma pro cliente que ele será encaminhado.
 *
 * Prioridade do texto:
 * 1. option.confirmationText (custom do admin) — suporta {{agent.name}}
 *    e {{contact.name}}. Permite adaptar ao tipo de negócio (drones agrícolas,
 *    e-commerce, etc) sem usar o option.label cru ("del área de Conocer más"
 *    soava robótico).
 * 2. Fallback natural genérico — sem mencionar o label cru.
 */
export async function sendHandoffMessage(
  params: SendHandoffParams,
  deps: SendWelcomeDeps = {},
): Promise<void> {
  const { workspaceId, conversationId, optionId } = params;
  const enqueue = deps.enqueueOutbound ?? dispatchOutbound;

  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: {
      inboxId: true,
      contact: { select: { phoneNumber: true, name: true } },
    },
  });
  if (!conv?.contact?.phoneNumber) return;

  const option = await prisma.welcomeOption.findUnique({
    where: { id: optionId },
    select: {
      label: true,
      confirmationText: true,
      targetUser: { select: { name: true } },
    },
  });
  if (!option) return;

  const agentName = option.targetUser?.name?.trim() ?? '';
  const contactName = conv.contact.name ? capitalizeName(conv.contact.name) : '';

  let text: string;
  const custom = option.confirmationText?.trim();
  if (custom) {
    // Custom text — substitui placeholders. Se {{agent.name}} sem agente atribuído,
    // troca por "nuestro equipo" pra não soar quebrado.
    text = custom
      .replace(/\{\{agent\.name\}\}/g, agentName || 'nuestro equipo')
      .replace(/\{\{contact\.name\}\}/g, contactName || 'cliente');
  } else {
    // Fallback natural — não menciona option.label cru, deixa o admin customizar
    // depois via confirmationText se quiser algo específico do negócio.
    text = agentName
      ? `¡Perfecto! Te derivamos con ${agentName} para que te atienda personalmente. En breve se pondrá en contacto contigo por aquí.`
      : `¡Perfecto! Recibimos tu solicitud. Un miembro del equipo se pondrá en contacto contigo en breve.`;
  }

  const msg = await prisma.message.create({
    data: {
      conversationId,
      direction: 'OUTBOUND',
      type: 'TEXT',
      senderType: 'AI_AGENT',
      content: text,
      status: 'PENDING',
    },
  });

  await enqueue({
    inboxId: conv.inboxId,
    workspaceId,
    conversationId,
    messageId: msg.id,
    to: conv.contact.phoneNumber,
    type: 'TEXT',
    text,
  });
}

interface MarkFailedParams {
  workspaceId: string;
  conversationId: string;
}

/**
 * Esgotou as tentativas sem casar opção. Limpa awaiting, aplica fallbackLabel
 * (se configurado, com roteamento via auto-routing) e libera a conversa
 * pro humano. Audita + publica evento.
 */
export async function markFailed(params: MarkFailedParams): Promise<void> {
  const { workspaceId, conversationId } = params;

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { isAwaitingWelcomeChoice: false },
  });

  // Aplica fallback label se configurado
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { inboxId: true },
  });
  if (!conv) return;

  const flow = await prisma.welcomeFlow.findUnique({
    where: { inboxId: conv.inboxId },
    select: { fallbackLabelId: true, fallbackUserId: true },
  });

  if (flow?.fallbackLabelId) {
    await applyTagWithRouting({
      workspaceId,
      conversationId,
      labelId: flow.fallbackLabelId,
      source: 'welcome_flow',
      assignAgentId: flow.fallbackUserId,
    });
  }

  void audit({
    workspaceId,
    actorId: null,
    action: AUDIT_ACTIONS.WELCOME_FAILED,
    resource: `conversation:${conversationId}`,
    metadata: { fallbackLabelId: flow?.fallbackLabelId ?? null },
  });

  await publishEvent(workspaceId, 'conversations', 'welcome.failed', {
    conversationId,
    fallbackLabelApplied: flow?.fallbackLabelId ?? null,
  });
}

interface RetryAsTextParams {
  workspaceId: string;
  conversationId: string;
}

/**
 * Timeout estourou sem reply: reenvia o prompt em texto plano numerado
 * (1. Compra / 2. Suporte / …) pra clientes em devices que não renderizam
 * listMessage. Idempotente: só dispara 1x por conversa (welcomeFallbackSent).
 */
export async function retryAsText(
  params: RetryAsTextParams,
  deps: SendWelcomeDeps = {},
): Promise<void> {
  const { workspaceId, conversationId } = params;
  const enqueue = deps.enqueueOutbound ?? dispatchOutbound;

  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: {
      inboxId: true,
      welcomeFallbackSent: true,
      contact: { select: { id: true, phoneNumber: true, name: true } },
    },
  });
  if (!conv?.contact?.phoneNumber || conv.welcomeFallbackSent) return;

  const flow = await prisma.welcomeFlow.findUnique({
    where: { inboxId: conv.inboxId },
    include: { options: { orderBy: { position: 'asc' } } },
  });
  if (!flow) return;

  const lines = [
    flow.prompt.replace(
      /\{\{contact\.name\}\}/g,
      conv.contact.name ? capitalizeName(conv.contact.name) : 'cliente',
    ),
    '',
    ...flow.options.map((o) => `${o.position}. ${o.label}`),
    '',
    'Responda com o número da opção desejada.',
  ];
  const textPlain = lines.join('\n');

  const msg = await prisma.message.create({
    data: {
      conversationId,
      direction: 'OUTBOUND',
      type: 'TEXT',
      senderType: 'AI_AGENT',
      content: textPlain,
      status: 'PENDING',
    },
  });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { welcomeFallbackSent: true },
  });

  await enqueue({
    inboxId: conv.inboxId,
    workspaceId,
    conversationId,
    messageId: msg.id,
    to: conv.contact.phoneNumber,
    type: 'TEXT',
    text: textPlain,
  });

  void audit({
    workspaceId,
    actorId: null,
    action: AUDIT_ACTIONS.WELCOME_FALLBACK_SENT,
    resource: `conversation:${conversationId}`,
  });
}
