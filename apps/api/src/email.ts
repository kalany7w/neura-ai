import { Resend } from 'resend';
import { env } from './env.js';
import { logger } from './logger.js';

export const resend = new Resend(env.RESEND_API_KEY);

interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail({ to, subject, html }: SendEmailParams) {
  const { data, error } = await resend.emails.send({
    from: `${env.RESEND_FROM_NAME} <${env.RESEND_FROM}>`,
    to,
    subject,
    html,
  });
  if (error) {
    logger.error({ err: error, to }, 'Failed to send email');
    throw new Error(`Resend error: ${error.message}`);
  }
  logger.info({ to, id: data?.id }, 'Email sent');
  return data;
}

export { emailTemplates, emailLayout, escapeHtml } from './email-templates.js';
