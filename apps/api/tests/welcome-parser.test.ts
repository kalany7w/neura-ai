import { describe, it, expect, vi } from 'vitest';
import { parseReply, type WelcomeOptionLite } from '../src/services/welcome-parser.js';

const opts: WelcomeOptionLite[] = [
  { id: 'opt1', position: 1, label: 'Compra', matchKeywords: ['comprar', 'quero comprar'] },
  { id: 'opt2', position: 2, label: 'Suporte', matchKeywords: ['ajuda', 'suporte'] },
  { id: 'opt3', position: 3, label: 'Outros', matchKeywords: [] },
];

describe('parseReply — match exato por buttonReply', () => {
  it('matchea pelo rowId', async () => {
    const result = await parseReply(
      { kind: 'button_reply', rowId: 'opt2', selectedDisplayText: 'Suporte' },
      opts,
    );
    expect(result?.id).toBe('opt2');
  });
});

describe('parseReply — match por número', () => {
  it('matchea "1"', async () => {
    const r = await parseReply({ kind: 'text', text: '1' }, opts);
    expect(r?.id).toBe('opt1');
  });

  it('matchea "2."', async () => {
    const r = await parseReply({ kind: 'text', text: '2.' }, opts);
    expect(r?.id).toBe('opt2');
  });

  it('não matchea "5" (fora de range)', async () => {
    const r = await parseReply({ kind: 'text', text: '5' }, opts);
    expect(r).toBeNull();
  });
});

describe('parseReply — match exato por label', () => {
  it('matchea "Compra"', async () => {
    const r = await parseReply({ kind: 'text', text: 'Compra' }, opts);
    expect(r?.id).toBe('opt1');
  });

  it('matchea case-insensitive', async () => {
    const r = await parseReply({ kind: 'text', text: 'suporte' }, opts);
    expect(r?.id).toBe('opt2');
  });
});

describe('parseReply — match por keyword', () => {
  it('matchea "quero comprar um produto" via keyword', async () => {
    const r = await parseReply({ kind: 'text', text: 'quero comprar um produto' }, opts);
    expect(r?.id).toBe('opt1');
  });

  it('matchea "preciso de ajuda" via keyword "ajuda"', async () => {
    const r = await parseReply({ kind: 'text', text: 'preciso de ajuda' }, opts);
    expect(r?.id).toBe('opt2');
  });
});

describe('parseReply — fallback OpenAI', () => {
  it('chama OpenAI quando nada matchea localmente e retorna match', async () => {
    const fuzzyMock = vi.fn().mockResolvedValue('opt1');

    const r = await parseReply({ kind: 'text', text: 'tô interessado em adquirir' }, opts, {
      fuzzyMatchFn: fuzzyMock,
    });

    expect(fuzzyMock).toHaveBeenCalledOnce();
    expect(r?.id).toBe('opt1');
  });

  it('retorna null se OpenAI também não matchea', async () => {
    const fuzzyMock = vi.fn().mockResolvedValue(null);
    const r = await parseReply({ kind: 'text', text: 'xyz aleatório' }, opts, {
      fuzzyMatchFn: fuzzyMock,
    });
    expect(r).toBeNull();
  });
});
