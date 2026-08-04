import { describe, it, expect } from 'vitest';
import { resolveMailProvider } from '../src/services/mailer.js';

describe('resolveMailProvider', () => {
  it('MAIL_PROVIDER explícito vence auto-detect', () => {
    expect(
      resolveMailProvider({ MAIL_PROVIDER: 'smtp', RESEND_API_KEY: 're_x', SMTP_HOST: 'mail.x' }),
    ).toBe('smtp');
    expect(
      resolveMailProvider({ MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x', SMTP_HOST: 'mail.x' }),
    ).toBe('resend');
  });

  it('auto-detect: só SMTP_HOST → smtp', () => {
    expect(resolveMailProvider({ SMTP_HOST: 'mail.example.com' })).toBe('smtp');
  });

  it('auto-detect: só RESEND_API_KEY → resend', () => {
    expect(resolveMailProvider({ RESEND_API_KEY: 're_abc' })).toBe('resend');
  });

  it('ambos sem MAIL_PROVIDER → resend (compat prod)', () => {
    expect(resolveMailProvider({ RESEND_API_KEY: 're_abc', SMTP_HOST: 'mail.x' })).toBe('resend');
  });

  it('nenhum configurado → erro claro', () => {
    expect(() => resolveMailProvider({})).toThrow(/No mail provider configured/);
  });
});
