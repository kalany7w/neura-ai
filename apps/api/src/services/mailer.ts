/**
 * Mailer unificado — abstrai o provedor de envio (SMTP genérico ou Resend).
 *
 * Seleção do provider:
 * - MAIL_PROVIDER=smtp|resend força explicitamente
 * - senão auto-detect: SMTP_HOST setado → smtp; RESEND_API_KEY setado → resend
 * - ambos setados sem MAIL_PROVIDER → resend (compat com ENV de prod existente)
 *
 * Usado por email.ts (transacionais) e email-client.ts (canal EMAIL de inbox).
 * SMTP retorna o Message-ID real do MTA — threading melhor que o surrogate
 * do Resend (<id>@resend.dev).
 */

import nodemailer, { type Transporter } from 'nodemailer';
import { Resend } from 'resend';
import { env } from '../env.js';
import { logger } from '../logger.js';

export type MailProvider = 'resend' | 'smtp';

export interface SendMailParams {
  /** From completo `Nome <email@dominio>`. Se omitido, usa o from padrão da ENV. */
  from?: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  /** Headers extras (In-Reply-To, References) pra threading. */
  headers?: Record<string, string>;
}

export interface SendMailResult {
  /** Id interno do provider (Resend UUID / SMTP messageId). */
  id: string;
  /** Message-ID pra threading (real no SMTP, surrogate @resend.dev no Resend). */
  messageId?: string;
}

export function resolveMailProvider(e: {
  MAIL_PROVIDER?: MailProvider;
  SMTP_HOST?: string;
  RESEND_API_KEY?: string;
}): MailProvider {
  if (e.MAIL_PROVIDER) return e.MAIL_PROVIDER;
  if (e.RESEND_API_KEY) return 'resend';
  if (e.SMTP_HOST) return 'smtp';
  // env.ts valida que pelo menos um existe; aqui é unreachable em runtime real.
  throw new Error('No mail provider configured (set SMTP_HOST or RESEND_API_KEY)');
}

export const mailProvider: MailProvider = resolveMailProvider(env);

/** From padrão dos transacionais: MAIL_* tem precedência sobre alias RESEND_*. */
export const defaultFromAddress = (env.MAIL_FROM ?? env.RESEND_FROM)!;
export const defaultFromName = env.MAIL_FROM_NAME ?? env.RESEND_FROM_NAME ?? 'Neura AI';
export const defaultFrom = `${defaultFromName} <${defaultFromAddress}>`;

let resendClient: Resend | null = null;
let smtpTransport: Transporter | null = null;

function getResend(): Resend {
  if (!resendClient) resendClient = new Resend(env.RESEND_API_KEY);
  return resendClient;
}

function getSmtp(): Transporter {
  if (!smtpTransport) {
    smtpTransport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  return smtpTransport;
}

export async function sendMail(params: SendMailParams): Promise<SendMailResult> {
  if (!params.html && !params.text) {
    throw new Error('mailer: text or html required');
  }
  const from = params.from ?? defaultFrom;
  const headers =
    params.headers && Object.keys(params.headers).length > 0 ? params.headers : undefined;

  if (mailProvider === 'smtp') {
    const info = await getSmtp().sendMail({
      from,
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html,
      headers,
    });
    logger.info({ to: params.to, id: info.messageId, provider: 'smtp' }, 'email sent');
    return { id: info.messageId ?? '', messageId: info.messageId };
  }

  // Resend SDK aceita either `html` OR `text` — prioriza html se ambos vierem.
  const payload = params.html
    ? { from, to: params.to, subject: params.subject, html: params.html, headers }
    : { from, to: params.to, subject: params.subject, text: params.text!, headers };
  const { data, error } = await getResend().emails.send(payload);
  if (error) {
    logger.error({ err: error, to: params.to, subject: params.subject }, 'resend send failed');
    throw new Error(`Resend error: ${error.message}`);
  }
  logger.info({ to: params.to, id: data?.id, provider: 'resend' }, 'email sent');
  return {
    id: data?.id ?? '',
    // Resend não devolve o Message-ID do MTA — usa o id como surrogate até
    // integrarmos webhook events de delivery.
    messageId: data?.id ? `<${data.id}@resend.dev>` : undefined,
  };
}
