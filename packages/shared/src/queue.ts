/**
 * Job definitions compartilhadas entre api (producer) e waworker (consumer).
 */

export const QUEUE_OUTBOUND = 'outbound';
export const QUEUE_TRANSCRIBE = 'transcribe';

export interface TranscribeJob {
  /** Workspace pra publishEvent + audit */
  workspaceId: string;
  /** Message.id (AUDIO) a transcrever */
  messageId: string;
}

export interface SendMessageJob {
  /** Inbox que vai enviar (define a sessão Baileys a usar) */
  inboxId: string;
  /** Workspace pra pub/sub de eventos */
  workspaceId: string;
  /** Conversa a que essa mensagem pertence */
  conversationId: string;
  /** ID da mensagem local (Message.id) — pra UPDATE status depois */
  messageId: string;
  /** Destinatário em E.164 com '+' (ex: +5511999999999) ou JID Baileys */
  to: string;
  /** Tipo da mensagem */
  type: 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT';
  /** Texto (TEXT ou caption de mídia) */
  text?: string;
  /** Mídia: URL acessível pelo worker (MinIO presigned na Fase 3) */
  mediaUrl?: string;
  mimeType?: string;
  fileName?: string;
  /** Reply: waMessageId da mensagem original (Baileys key.id) */
  quotedWaMessageId?: string;
  /** Reply: participant JID (grupos) — opcional */
  quotedParticipant?: string;
  /**
   * Variantes do job:
   * - 'message' (default): envio padrão (text ou mídia)
   * - 'reaction': adiciona/remove reação (targetWaMessageId obrigatório; emoji vazio = remover)
   * - 'edit': edita conteúdo de msg enviada (targetWaMessageId + text obrigatórios; WhatsApp limita ~15min)
   * - 'revoke': apaga msg pra todos (targetWaMessageId obrigatório; WhatsApp limita ~7min)
   */
  kind?: 'message' | 'reaction' | 'edit' | 'revoke';
  targetWaMessageId?: string;
  reactionEmoji?: string;
}
