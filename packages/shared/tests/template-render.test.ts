import { describe, it, expect } from 'vitest';
import { renderTemplate, TEMPLATE_VARIABLES } from '../src/template-render';

describe('renderTemplate', () => {
  describe('basic substitution', () => {
    it('substitui contact.name', () => {
      expect(renderTemplate('Olá {{contact.name}}!', { contact: { name: 'Maria' } })).toBe(
        'Olá Maria!',
      );
    });

    it('substitui contact.phoneNumber', () => {
      expect(
        renderTemplate('Telefone: {{contact.phoneNumber}}', {
          contact: { phoneNumber: '+5511999' },
        }),
      ).toBe('Telefone: +5511999');
    });

    it('tolera espaços dentro do placeholder', () => {
      expect(renderTemplate('Olá {{  contact.name  }}!', { contact: { name: 'Ana' } })).toBe(
        'Olá Ana!',
      );
    });

    it('substitui múltiplos placeholders', () => {
      const out = renderTemplate('{{contact.name}} ({{contact.phoneNumber}})', {
        contact: { name: 'Maria', phoneNumber: '+5511' },
      });
      expect(out).toBe('Maria (+5511)');
    });
  });

  describe('fallback / default', () => {
    it('usa fallback aspas simples quando valor é null', () => {
      expect(
        renderTemplate("Olá {{contact.name | default 'amigo'}}!", { contact: { name: null } }),
      ).toBe('Olá amigo!');
    });

    it('usa fallback aspas duplas quando valor é undefined', () => {
      expect(renderTemplate('Olá {{contact.name | default "cliente"}}!', {})).toBe(
        'Olá cliente!',
      );
    });

    it('usa fallback raw (sem aspas) quando valor é vazio', () => {
      expect(
        renderTemplate('Olá {{contact.name | default fulano}}!', { contact: { name: '' } }),
      ).toBe('Olá fulano!');
    });

    it('usa valor real quando existe — ignora fallback', () => {
      expect(
        renderTemplate("Olá {{contact.name | default 'amigo'}}!", { contact: { name: 'João' } }),
      ).toBe('Olá João!');
    });

    it('considera string só com espaço como vazio (usa fallback)', () => {
      expect(
        renderTemplate("Olá {{contact.name | default 'amigo'}}!", {
          contact: { name: '   ' },
        }),
      ).toBe('Olá amigo!');
    });
  });

  describe('contact.firstName', () => {
    it('extrai primeiro token de nome composto', () => {
      expect(
        renderTemplate('Oi {{contact.firstName}}!', { contact: { name: 'Maria Silva Santos' } }),
      ).toBe('Oi Maria!');
    });

    it('lida com whitespace extra', () => {
      expect(
        renderTemplate('Oi {{contact.firstName}}!', { contact: { name: '   João   da Silva' } }),
      ).toBe('Oi João!');
    });

    it('fallback quando name vazio', () => {
      expect(
        renderTemplate("Oi {{contact.firstName | default 'amigo'}}!", { contact: { name: null } }),
      ).toBe('Oi amigo!');
    });

    it('fallback quando contact ausente', () => {
      expect(renderTemplate("Oi {{contact.firstName | default 'amigo'}}!", {})).toBe(
        'Oi amigo!',
      );
    });
  });

  describe('unknown / edge', () => {
    it('placeholder desconhecido vira vazio', () => {
      expect(renderTemplate('Hello {{foo.bar}}!', {})).toBe('Hello !');
    });

    it('placeholder desconhecido respeita fallback', () => {
      expect(renderTemplate("Hello {{foo.bar | default 'world'}}!", {})).toBe('Hello world!');
    });

    it('sem placeholders retorna texto literal', () => {
      expect(renderTemplate('Texto sem placeholder', { contact: { name: 'X' } })).toBe(
        'Texto sem placeholder',
      );
    });

    it('placeholder com objeto não-string vira vazio', () => {
      expect(
        renderTemplate('Hello {{contact}}!', {
          contact: { name: 'X' },
        }),
      ).toBe('Hello !');
    });

    it('agent.name funciona', () => {
      expect(renderTemplate('— {{agent.name}}', { agent: { name: 'Ana' } })).toBe('— Ana');
    });

    it('inbox.name funciona', () => {
      expect(renderTemplate('Canal: {{inbox.name}}', { inbox: { name: 'Suporte' } })).toBe(
        'Canal: Suporte',
      );
    });
  });

  describe('TEMPLATE_VARIABLES catalogue', () => {
    it('expõe os 5 placeholders principais', () => {
      const names = TEMPLATE_VARIABLES.map((v) => v.name);
      expect(names).toContain('contact.name');
      expect(names).toContain('contact.firstName');
      expect(names).toContain('contact.phoneNumber');
      expect(names).toContain('inbox.name');
      expect(names).toContain('agent.name');
    });

    it('cada variável tem descrição', () => {
      for (const v of TEMPLATE_VARIABLES) {
        expect(v.description.length).toBeGreaterThan(0);
      }
    });
  });
});
