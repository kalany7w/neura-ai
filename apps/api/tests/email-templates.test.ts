import { describe, it, expect } from 'vitest';

const templateCases = [
  {
    name: 'verifyEmail',
    url: 'https://app.neura-ai.net/verify?token=abc',
    call: (m: any, url: string) => m.emailTemplates.verifyEmail(url),
  },
  {
    name: 'resetPassword',
    url: 'https://app.neura-ai.net/reset?token=abc',
    call: (m: any, url: string) => m.emailTemplates.resetPassword(url),
  },
  {
    name: 'invite',
    url: 'https://app.neura-ai.net/invite/2f9c1a',
    call: (m: any, url: string) => m.emailTemplates.invite('Caltech Agro', 'Nicolas Kalany', url),
  },
];

describe('email-templates structure', () => {
  it.each(templateCases)('$name renders a bulletproof table-based email', async ({ url, call }) => {
    const mod = await import('../src/email-templates');
    const tpl = call(mod, url);

    expect(tpl.html.startsWith('<!DOCTYPE html')).toBe(true);
    expect(tpl.html).toContain('<table');

    const occurrences = tpl.html.split(url).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);

    expect(tpl.html).toContain('neura-ai.net');
    expect(tpl.html).toContain('#ff4d12');

    expect(tpl.html).not.toContain('<link');
    expect(tpl.html).not.toContain('</style>');
    expect(tpl.html).not.toContain('class="');

    expect(typeof tpl.subject).toBe('string');
    expect(tpl.subject.length).toBeGreaterThan(0);
  });

  it('escapeHtml converts special characters (ampersand first)', async () => {
    const { escapeHtml } = await import('../src/email-templates');
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
    expect(escapeHtml('<img src=x onerror="alert(1)">&\'')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;',
    );
  });

  it('verifyEmail subject preserves current semantics', async () => {
    const { emailTemplates } = await import('../src/email-templates');
    const tpl = emailTemplates.verifyEmail('https://app.neura-ai.net/verify?token=abc');
    expect(tpl.subject).toContain('Confirme seu email');
  });

  it('resetPassword subject preserves current semantics', async () => {
    const { emailTemplates } = await import('../src/email-templates');
    const tpl = emailTemplates.resetPassword('https://app.neura-ai.net/reset?token=abc');
    expect(tpl.subject).toContain('Redefinir senha');
  });

  it('invite subject contains the raw (unescaped) workspace name', async () => {
    const { emailTemplates } = await import('../src/email-templates');
    const tpl = emailTemplates.invite('Ana & Cia', 'Ana', 'https://app/x');
    expect(tpl.subject).toContain('Ana & Cia');
  });

  it('invite escapes workspaceName and inviterName in html, keeps url intact', async () => {
    const { emailTemplates } = await import('../src/email-templates');
    const tpl = emailTemplates.invite(
      '<img src=x onerror=alert(1)>',
      'Ana & Cia "Ltda"',
      'https://app/x',
    );
    expect(tpl.html).not.toContain('<img src=x');
    expect(tpl.html).toContain('&lt;img');
    expect(tpl.html).toContain('&amp;');
    expect(tpl.html).toContain('&quot;');
    expect(tpl.html).toContain('https://app/x');
  });
});
