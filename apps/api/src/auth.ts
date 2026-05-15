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
      const tpl = emailTemplates.resetPassword(url);
      await sendEmail({ to: user.email, subject: tpl.subject, html: tpl.html });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendVerificationEmail: async ({ user, url }) => {
      const tpl = emailTemplates.verifyEmail(url);
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
