/**
 * SLA compute helpers — chamados nos sites de write da Conversation.
 *
 * computeFirstResponse: registra timestamp + segundos da primeira resposta de
 * agente (qualquer OUTBOUND). Idempotente — só preenche se firstResponseAt
 * ainda é null. Reset slaBreachNotifiedAt simultaneamente (agente respondeu,
 * sai do estado de breach).
 *
 * computeResolution: registra timestamp + segundos até resolução. Idempotente —
 * só preenche se resolvedAt ainda é null E status mudou pra RESOLVED.
 *
 * Ambos retornam o data patch que o caller deve fazer merge no
 * prisma.conversation.update.
 */

import { prisma } from '../db.js';

export async function patchFirstResponse(
  conversationId: string,
  outboundAt: Date,
): Promise<Record<string, unknown>> {
  // Lê o estado atual antes do update (não confiamos em parâmetro porque sites
  // diferentes têm projeções diferentes de Conversation).
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { firstResponseAt: true, createdAt: true, slaBreachNotifiedAt: true },
  });
  if (!conv) return {};
  if (conv.firstResponseAt) return {}; // já registrada
  const seconds = Math.max(
    0,
    Math.round((outboundAt.getTime() - conv.createdAt.getTime()) / 1000),
  );
  return {
    firstResponseAt: outboundAt,
    firstResponseSeconds: seconds,
    slaBreachNotifiedAt: null,
  };
}

export async function patchResolution(
  conversationId: string,
  newStatus: 'OPEN' | 'PENDING' | 'RESOLVED' | 'SNOOZED',
  at: Date = new Date(),
): Promise<Record<string, unknown>> {
  if (newStatus !== 'RESOLVED') {
    // Se reabriu (RESOLVED → OPEN/PENDING), limpa resolvedAt pra permitir nova medição
    return { resolvedAt: null, resolutionSeconds: null };
  }
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { resolvedAt: true, createdAt: true },
  });
  if (!conv) return {};
  if (conv.resolvedAt) return {}; // já resolvida — não sobrescreve
  const seconds = Math.max(
    0,
    Math.round((at.getTime() - conv.createdAt.getTime()) / 1000),
  );
  return { resolvedAt: at, resolutionSeconds: seconds };
}
