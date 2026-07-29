/**
 * Templates de e-mail transacional do Neura AI.
 *
 * Modulo PURO — sem import de `./env.js`, `./logger.js` nem `resend`.
 * Isso permite testar e gerar previews (scripts/preview-emails.ts) sem
 * precisar de variaveis de ambiente nem credenciais.
 */

const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Nome comercial do produto (decisão Kalan 2026-07-29). O subject usa só "Neura AI" pra não estourar a linha da inbox. */
const PRODUCT_NAME = 'Sistema de atendimento Neura AI';

/** Escapa `&` `<` `>` `"` `'` para uso seguro em HTML. Ampersand SEMPRE primeiro. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface EmailLayoutOptions {
  title: string;
  /** Aceita HTML inline ja escapado pelo chamador. */
  intro: string;
  ctaLabel: string;
  ctaUrl: string;
  footerNote: string;
  preheader?: string;
}

/**
 * Layout de e-mail table-based, 100% estilos inline, sem <style>, sem class=,
 * sem webfont e sem imagem remota — pra sobreviver aos clientes de e-mail
 * mais hostis (Gmail/Outlook) e nao cair em spam por parecer phishing.
 */
export function emailLayout(opts: EmailLayoutOptions): string {
  const { title, intro, ctaLabel, ctaUrl, footerNote, preheader } = opts;
  const safeUrl = escapeHtml(ctaUrl);
  const preheaderText = escapeHtml(preheader ?? intro.replace(/<[^>]*>/g, ''));

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f3f0;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${preheaderText}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f3f0" style="background-color:#f3f3f0;">
<tr>
<td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#ffffff;border:1px solid #c7c8cd;border-radius:12px;">
<tr>
<td style="padding:32px;font-family:${FONT_STACK};">
<div style="font-size:22px;font-weight:800;letter-spacing:-0.02em;color:#141519;">Neura<span style="color:#ff4d12">AI</span></div>
<h1 style="font-size:22px;font-weight:700;color:#141519;margin:24px 0 12px;font-family:${FONT_STACK};">${escapeHtml(title)}</h1>
<p style="font-size:15px;line-height:1.6;color:#2c2e36;margin:0 0 24px;font-family:${FONT_STACK};">${intro}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr>
<td bgcolor="#ff4d12" style="border-radius:8px;">
<a href="${safeUrl}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;font-family:${FONT_STACK};">${escapeHtml(ctaLabel)}</a>
</td>
</tr>
</table>
<p style="font-size:12px;color:#6f7079;margin:24px 0 0;font-family:${FONT_STACK};">Se o botão não funcionar, copie e cole este link no navegador:</p>
<p style="font-size:12px;color:#6f7079;word-break:break-all;margin:6px 0 0;font-family:${FONT_STACK};"><a href="${safeUrl}" style="color:#6f7079">${safeUrl}</a></p>
<hr style="border:0;border-top:1px solid #c7c8cd;margin:28px 0 16px">
<p style="font-size:12px;color:#6f7079;line-height:1.5;margin:0;font-family:${FONT_STACK};">${escapeHtml(footerNote)}</p>
<p style="font-size:12px;color:#6f7079;margin:8px 0 0;font-family:${FONT_STACK};">Neura<span style="color:#ff4d12">AI</span> · neura-ai.net</p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
}

export const emailTemplates = {
  verifyEmail: (url: string) => ({
    subject: 'Confirme seu email — Neura AI',
    html: emailLayout({
      title: 'Confirme seu email',
      intro: `Falta só um passo para ativar sua conta no ${PRODUCT_NAME}. Clique no botão abaixo para confirmar seu email.`,
      ctaLabel: 'Confirmar email',
      ctaUrl: url,
      footerNote: `Se você não criou uma conta no ${PRODUCT_NAME}, ignore este email.`,
    }),
  }),
  resetPassword: (url: string) => ({
    subject: 'Redefinir senha — Neura AI',
    html: emailLayout({
      title: 'Redefinir senha',
      intro: `Recebemos um pedido para redefinir sua senha no ${PRODUCT_NAME}. Clique no botão abaixo para criar uma nova senha.`,
      ctaLabel: 'Criar nova senha',
      ctaUrl: url,
      footerNote: 'Se você não solicitou a redefinição, ignore este email — sua senha atual continua valendo.',
    }),
  }),
  invite: (workspaceName: string, inviterName: string, url: string) => ({
    subject: `Você foi convidado para ${workspaceName} — Neura AI`,
    html: emailLayout({
      title: 'Convite para o Neura AI',
      intro: `${escapeHtml(inviterName)} te convidou para fazer parte do workspace <strong>${escapeHtml(workspaceName)}</strong> no ${PRODUCT_NAME}.`,
      ctaLabel: 'Aceitar convite',
      ctaUrl: url,
      footerNote: 'O convite expira em 7 dias. Se você não esperava este convite, ignore este email.',
    }),
  }),
};
