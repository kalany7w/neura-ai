/**
 * Detecta resposta de CSAT survey em mensagens INBOUND.
 *
 * Triggered pelo publishEvent ao receber `message.new` (de qualquer canal).
 * Se a conversa tem `csatSurveyId` + `csatAwaitingResponseUntil > now` e o
 * conteúdo casa com um score parseable (1-5 / 0-10 / emoji thumbs), cria
 * CsatResponse + envia thank-you.
 *
 * Idempotente: CsatResponse.conversationId é unique — segunda tentativa falha
 * silenciosamente. Janela de aceitação é 7 dias (config no csat-send).
 */

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { dispatchOutbound } from '../queue.js';
import { publishEvent } from '../redis-pub.js';
import { renderTemplate } from '@neura/shared/template-render';

interface ParsedScore {
  score: number;
  scoreType: 'CSAT' | 'NPS' | 'THUMBS';
  comment: string | null;
}

const POSITIVE_EMOJI = new Set(['👍', '👏', '❤️', '❤', '😍', '🥳', '😊', '😀', '🙂', '✅', '⭐']);
const NEGATIVE_EMOJI = new Set(['👎', '😢', '😡', '🤬', '😠', '😞', '😕', '❌']);

/**
 * Parsea texto do cliente em score. Suporta:
 * - "5" → CSAT 5
 * - "9" → NPS 9 (se survey é NPS)
 * - "5 - foi ótimo!" → CSAT 5 com comment
 * - "👍" → THUMBS 1
 * - "👎 não gostei" → THUMBS 0 com comment
 * - "nota 4" → CSAT 4
 * - "10/10" → NPS 10
 */
export function parseScoreFromText(
  text: string,
  expectedType: 'CSAT' | 'NPS' | 'THUMBS',
): ParsedScore | null {
  const t = text.trim();
  if (!t) return null;

  // Emoji thumbs primeiro (rápido + sem ambiguidade com números)
  const firstChars = Array.from(t).slice(0, 3).join('');
  for (const ch of Array.from(t).slice(0, 5)) {
    if (POSITIVE_EMOJI.has(ch)) {
      const comment = t.replace(ch, '').trim();
      return { score: 1, scoreType: 'THUMBS', comment: comment || null };
    }
    if (NEGATIVE_EMOJI.has(ch)) {
      const comment = t.replace(ch, '').trim();
      return { score: 0, scoreType: 'THUMBS', comment: comment || null };
    }
  }
  void firstChars;

  // Padrões numéricos: "5", "9/10", "nota 4", "10!", etc.
  const numMatch = t.match(
    /(?:^|\s|nota\s+|score\s+|^)(\d{1,2})(?:\s*[\/]\s*\d{1,2})?(?:\s|$|[!.,;])/i,
  );
  if (!numMatch) {
    // Sem número e sem emoji → não é score
    return null;
  }
  const raw = parseInt(numMatch[1] ?? '', 10);
  if (Number.isNaN(raw)) return null;

  // Limites por tipo de survey
  if (expectedType === 'CSAT') {
    if (raw < 1 || raw > 5) return null;
    const rest = t.replace(numMatch[0], '').trim();
    return { score: raw, scoreType: 'CSAT', comment: rest || null };
  }
  if (expectedType === 'NPS') {
    if (raw < 0 || raw > 10) return null;
    const rest = t.replace(numMatch[0], '').trim();
    return { score: raw, scoreType: 'NPS', comment: rest || null };
  }
  if (expectedType === 'THUMBS') {
    // Pra THUMBS, 0/1 também aceita
    if (raw !== 0 && raw !== 1) return null;
    const rest = t.replace(numMatch[0], '').trim();
    return { score: raw, scoreType: 'THUMBS', comment: rest || null };
  }
  return null;
}

/**
 * Tentativa de detecção. Retorna `true` se criou response, false caso contrário.
 * Não rethrow — fire-and-forget.
 */
export async function detectCsatResponse(
  workspaceId: string,
  conversationId: string,
  inboundContent: string,
): Promise<boolean> {
  try {
    const conv = await prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: {
        id: true,
        contactId: true,
        assignedAgentId: true,
        csatSurveyId: true,
        csatSentAt: true,
        csatAwaitingResponseUntil: true,
        inbox: { select: { type: true } },
      },
    });
    if (!conv) return false;
    if (!conv.csatSurveyId || !conv.csatSentAt || !conv.csatAwaitingResponseUntil) {
      return false;
    }
    if (conv.csatAwaitingResponseUntil < new Date()) {
      return false;
    }

    // Verifica se já tem response (idempotência via unique constraint, mas check upfront)
    const existing = await prisma.csatResponse.findFirst({
      where: { conversationId: conv.id },
      select: { id: true },
    });
    if (existing) return false;

    const survey = await prisma.csatSurvey.findUnique({
      where: { id: conv.csatSurveyId },
      select: { id: true, scoreType: true, thankYouMessage: true },
    });
    if (!survey) return false;

    const parsed = parseScoreFromText(inboundContent, survey.scoreType);
    if (!parsed) return false;

    // Cria response
    try {
      await prisma.csatResponse.create({
        data: {
          workspaceId,
          surveyId: survey.id,
          conversationId: conv.id,
          contactId: conv.contactId,
          agentId: conv.assignedAgentId,
          score: parsed.score,
          scoreType: parsed.scoreType,
          comment: parsed.comment,
          sentAt: conv.csatSentAt,
        },
      });
    } catch (err: unknown) {
      // P2002: duplicate (race condition) — outro inbound chegou simultâneo. Skip silencioso.
      if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
        return false;
      }
      throw err;
    }

    // Limpa janela pra não reagir aos próximos inbounds
    await prisma.conversation.update({
      where: { id: conv.id },
      data: { csatAwaitingResponseUntil: null },
    });

    await prisma.csatSurvey
      .update({
        where: { id: survey.id },
        data: { responseCount: { increment: 1 } },
      })
      .catch(() => {});

    await publishEvent(workspaceId, 'conversations', 'conversation.csat_responded', {
      conversationId: conv.id,
      score: parsed.score,
      scoreType: parsed.scoreType,
    });

    // Thank-you reply (opcional)
    if (survey.thankYouMessage && conv.inbox.type) {
      void sendThankYou(workspaceId, conv.id, survey.thankYouMessage).catch((err) => {
        logger.warn({ err, conversationId: conv.id }, 'thank-you send failed');
      });
    }

    logger.info(
      { conversationId: conv.id, score: parsed.score, scoreType: parsed.scoreType },
      'CSAT response captured',
    );
    return true;
  } catch (err) {
    logger.warn({ err, conversationId }, 'detectCsatResponse failed');
    return false;
  }
}

async function sendThankYou(
  workspaceId: string,
  conversationId: string,
  template: string,
): Promise<void> {
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: {
      inboxId: true,
      contact: { select: { name: true, phoneNumber: true } },
      inbox: { select: { type: true, status: true, name: true } },
    },
  });
  if (!conv || conv.inbox.status !== 'CONNECTED') return;

  const renderedBody = renderTemplate(template, {
    contact: {
      name: conv.contact.name,
      phoneNumber: conv.contact.phoneNumber,
    },
    inbox: { name: conv.inbox.name },
  });

  const msg = await prisma.message.create({
    data: {
      conversationId,
      direction: 'OUTBOUND',
      type: 'TEXT',
      content: renderedBody,
      status: 'PENDING',
    },
  });
  await dispatchOutbound({
    inboxId: conv.inboxId,
    workspaceId,
    conversationId,
    messageId: msg.id,
    to: conv.contact.phoneNumber ?? '',
    type: 'TEXT',
    text: renderedBody,
  });
}
