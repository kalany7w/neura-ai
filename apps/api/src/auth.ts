import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { prisma } from './db.js';
import { env } from './env.js';
import { sendEmail, emailTemplates } from './email.js';

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: env.NODE_ENV === 'production',
    autoSignIn: true,
    sendResetPassword: async ({ user, url }) => {
      // Mesmo padrão: redireciona pro web app após reset.
      const appBase = env.APP_URL ?? env.TRUSTED_ORIGINS[0] ?? env.BETTER_AUTH_URL;
      const target = `${appBase.replace(/\/$/, '')}/reset-password`;
      const fixedUrl = url.replace(/([?&])callbackURL=[^&]*/, `$1callbackURL=${encodeURIComponent(target)}`);
      const tpl = emailTemplates.resetPassword(fixedUrl);
      await sendEmail({ to: user.email, subject: tpl.subject, html: tpl.html });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendVerificationEmail: async ({ user, url }) => {
      // Better Auth gera URL com callbackURL default = baseURL (api), que cai em 404.
      // Reescreve pra mandar o user pro web app após verify.
      const appBase = env.APP_URL ?? env.TRUSTED_ORIGINS[0] ?? env.BETTER_AUTH_URL;
      const target = `${appBase.replace(/\/$/, '')}/login?verified=true`;
      const fixedUrl = url.replace(/([?&])callbackURL=[^&]*/, `$1callbackURL=${encodeURIComponent(target)}`);
      const tpl = emailTemplates.verifyEmail(fixedUrl);
      await sendEmail({ to: user.email, subject: tpl.subject, html: tpl.html });
    },
  },
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: env.TRUSTED_ORIGINS,
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 dias
    updateAge: 60 * 60 * 24, // refresh a cada 1 dia
  },
});

export type Auth = typeof auth;
