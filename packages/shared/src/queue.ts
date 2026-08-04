/**
 * Job definitions compartilhadas entre api (producer) e waworker (consumer).
 */

export const QUEUE_OUTBOUND = 'outbound';
// Queue de envio específica pra inboxes Telegram (HTTP Bot API, sem Baileys).
// Processada pelo api side worker em telegram-outbound.ts.
export const QUEUE_OUTBOUND_TELEGRAM = 'outbound-telegram';
// Queue de envio específica pra inboxes Email (Resend send via HTTPS).
// Processada pelo api side worker em email-outbound.ts.
export const QUEUE_OUTBOUND_EMAIL = 'outbound-email';
export const QUEUE_TRANSCRIBE = 'transcribe';
export const QUEUE_AI = 'ai';
// Queue de embedding de artigos da KB (RAG). Processado pelo kb-embed worker.
export const QUEUE_KB_EMBED = 'kb-embed';
// Queue de envio de surveys CSAT/NPS pós-RESOLVED. Delayed jobs (delay = survey.delayMinutes).
export const QUEUE_CSAT_SEND = 'csat-send';
// Queue de processamento do welcome flow. Producer: waworker (trigger) + api (retry).
// Consumer: welcome-worker no api side.
export const QUEUE_WELCOME_PROCESS = 'welcome-process';

export interface TranscribeJob {
  /** Workspace pra publishEvent + audit */
  workspaceId: string;
  /** Message.id (AUDIO) a transcrever */
  messageId: string;
}

/**
 * Jobs IA Copilot — processados pelo worker `ai` na API.
 * Discriminados por `kind`:
 * - 'classify': re-classifica conversa (intent/urgency/sentiment)
 * - 'forecast': recalcula probabilidade de fechamento dum card
 * - 'kb-suggest': busca top-1 artigo da KB pra conversa via embedding
 */
export interface AiJob {
  workspaceId: string;
  kind: 'classify' | 'forecast' | 'kb-suggest';
  /** Para 'classify' e 'kb-suggest': conversationId. Para 'forecast': cardId. */
  targetId: string;
}

/**
 * Job de embedding de artigo da KB. Disparado quando o artigo é criado ou
 * tem body/title atualizados. JobId determinístico `kb-embed:<articleId>`
 * funciona como dedup — múltiplos writes em sequência colapsam num único job
 * pegando a versão mais recente do banco no momento da execução.
 */
export interface KbEmbedJob {
  workspaceId: string;
  articleId: string;
}

/**
 * Job de envio de survey CSAT/NPS. Disparado fire-and-forget quando uma
 * conversa vira RESOLVED. JobId determinístico `csat:<conversationId>`
 * (1 survey por conversa). Cancelado se conversa reabrir antes do delay vencer.
 */
export interface CsatSendJob {
  workspaceId: string;
  conversationId: string;
  surveyId: string;
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
  type: 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'INTERACTIVE';
  /** Texto (TEXT ou caption de mídia) */
  text?: string;
  /** Para type === 'INTERACTIVE': estrutura do listMessage do Baileys */
  interactivePayload?: {
    title: string; // header do listMessage
    body: string; // texto principal (o prompt)
    footer?: string; // footer opcional
    buttonText: string; // label do botão que abre a lista (ex: "Ver opções")
    options: Array<{
      rowId: string; // = WelcomeOption.id
      title: string; // = WelcomeOption.label
      description?: string; // = WelcomeOption.description
    }>;
  };
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
  /** User.id que disparou o edit/revoke — usado pra gravar autor no histórico de edições */
  editedBy?: string;
}

/**
 * Job de processamento do welcome flow. Discriminado por `kind`:
 * - 'trigger': primeira mensagem inbound detectada — checar se deve enviar welcome.
 * - 'parse_reply': cliente respondeu enquanto conversa estava awaiting — parsear opção.
 * - 'retry_text': timeout passou sem reply — reenviar prompt em texto plano.
 * - 'fallback_human': N attempts sem match — aplicar fallback label, liberar pra humano.
 */
export interface WelcomeProcessJob {
  workspaceId: string;
  conversationId: string;
  kind: 'trigger' | 'parse_reply' | 'retry_text' | 'fallback_human';
  /** Para 'parse_reply': Message.id do reply do cliente. */
  messageId?: string;
}
