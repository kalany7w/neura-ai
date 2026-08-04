/**
 * Email client pra inboxes do tipo EMAIL — envia via mailer unificado
 * (SMTP genérico ou Resend, decidido por ENV — ver services/mailer.ts).
 *
 * Threading: passa header `In-Reply-To` quando há `inReplyTo` (Message-ID do
 * email original) — cliente vê thread no Gmail/Outlook.
 *
 * Stripping HTML: pra inbound, lib `striptags`-like simples (sem dep) gera
 * fallback text de bodies HTML quando o provedor não mandou textBody.
 */

import { sendMail } from './mailer.js';

export interface SendEmailParams {
  /** From completo no formato `Nome <email@dominio>`. Usa o fromAddress configurado no inbox. */
  from: string;
  to: string;
  subject: string;
  /** Body em texto puro. Resend converte pra HTML simples se html não vier. */
  text?: string;
  /** Body em HTML (preferencial). */
  html?: string;
  /** Header In-Reply-To pra threading (Message-ID do email original). */
  inReplyTo?: string;
  /** Header References (pode listar múltiplos IDs separados por espaço). */
  references?: string;
}

export interface EmailSendResult {
  id: string;
  /** Message-ID pra threading (real no SMTP, surrogate <id>@resend.dev no Resend). */
  messageId?: string;
}

export async function sendInboxEmail(params: SendEmailParams): Promise<EmailSendResult> {
  if (!params.html && !params.text) {
    throw new Error('email: text or html required');
  }
  const headers: Record<string, string> = {};
  if (params.inReplyTo) headers['In-Reply-To'] = ensureAngleBrackets(params.inReplyTo);
  if (params.references) headers['References'] = params.references;

  return sendMail({
    from: params.from,
    to: params.to,
    subject: params.subject,
    text: params.text,
    html: params.html,
    headers,
  });
}

/**
 * Normaliza Message-ID adicionando `<>` se vier sem (alguns provedores enviam cru).
 */
export function ensureAngleBrackets(messageId: string): string {
  const trimmed = messageId.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed;
  return `<${trimmed}>`;
}

/**
 * Strip HTML pra fallback de textBody quando provider só mandou htmlBody.
 * Não é parser completo — só remove tags + decode entities comuns + colapsa whitespace.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/\n /g, '\n')
    .trim();
}

/**
 * Parse endereço email no formato `Nome <email@x>` ou `email@x` cru.
 * Retorna { name, address } — address sempre lowercased.
 */
export function parseEmailAddress(raw: string): { name: string | null; address: string } {
  const trimmed = raw.trim();
  const match = trimmed.match(/^(?:"?([^"<]+?)"?\s+)?<?([^<>\s]+@[^<>\s]+)>?$/);
  if (!match) return { name: null, address: trimmed.toLowerCase() };
  const [, name, address] = match;
  if (!address) return { name: null, address: trimmed.toLowerCase() };
  return { name: name?.trim() || null, address: address.toLowerCase() };
}
