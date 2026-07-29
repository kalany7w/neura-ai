/**
 * Gera os 3 HTMLs de e-mail transacional em disco pra revisao visual manual.
 *
 * Uso: tsx scripts/preview-emails.ts [diretorio-de-saida]
 *
 * Importa apenas `../src/email-templates.js` (modulo puro, sem env/resend),
 * entao roda sem nenhuma variavel de ambiente configurada.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emailTemplates } from '../src/email-templates.js';

const outDir = process.argv[2] ?? path.join(os.tmpdir(), 'neura-email-preview');
fs.mkdirSync(outDir, { recursive: true });

const longUrl =
  'https://api.neura-ai.net/api/auth/verify-email?token=eyJhbGciOiJIUzI1NiJ9.aVeryLongTokenValueHere.signature&callbackURL=https%3A%2F%2Fapp.neura-ai.net%2Flogin%3Fverified%3Dtrue';

const files: Array<{ name: string; html: string }> = [
  { name: 'verify-email.html', html: emailTemplates.verifyEmail(longUrl).html },
  { name: 'reset-password.html', html: emailTemplates.resetPassword(longUrl).html },
  {
    name: 'invite.html',
    html: emailTemplates.invite('Caltech Agro', 'Nicolas Kalany', 'https://app.neura-ai.net/invite/2f9c1a...').html,
  },
];

for (const file of files) {
  const filePath = path.join(outDir, file.name);
  fs.writeFileSync(filePath, file.html, 'utf8');
  console.log(path.resolve(filePath));
}
