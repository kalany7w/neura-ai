import { logger } from './logger.js';
import { sendMail } from './services/mailer.js';

interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
}

/** E-mail transacional (signup confirm, convite, reset) — from padrão da ENV. */
export async function sendEmail({ to, subject, html }: SendEmailParams) {
  try {
    return await sendMail({ to, subject, html });
  } catch (err) {
    logger.error({ err, to }, 'Failed to send email');
    throw err;
  }
}

export { emailTemplates, emailLayout, escapeHtml } from './email-templates.js';
