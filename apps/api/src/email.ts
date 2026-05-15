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

export const emailTemplates = {
  verifyEmail: (url: string) => ({
    subject: 'Confirme seu email — Neura AI',
    html: `
      <h2>Confirme seu email</h2>
      <p>Clique no link abaixo para confirmar seu cadastro no Neura AI:</p>
      <p><a href="${url}">${url}</a></p>
      <p>Se você não solicitou este cadastro, ignore este email.</p>
    `,
  }),
  resetPassword: (url: string) => ({
    subject: 'Redefinir senha — Neura AI',
    html: `
      <h2>Redefinir senha</h2>
      <p>Clique no link abaixo para criar uma nova senha:</p>
      <p><a href="${url}">${url}</a></p>
      <p>Se você não solicitou, ignore este email.</p>
    `,
  }),
  invite: (workspaceName: string, inviterName: string, url: string) => ({
    subject: `Você foi convidado para ${workspaceName} — Neura AI`,
    html: `
      <h2>Convite para ${workspaceName}</h2>
      <p>${inviterName} te convidou para fazer parte do workspace <strong>${workspaceName}</strong> no Neura AI.</p>
      <p><a href="${url}">Aceitar convite</a></p>
      <p>O convite expira em 7 dias.</p>
    `,
  }),
};
