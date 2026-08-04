import { describe, it, expect } from 'vitest';
import {
  splitMessageText,
  MESSAGE_PART_MAX,
} from '../src/services/split-message.js';

describe('splitMessageText', () => {
  it('texto curto volta intacto em array de 1', () => {
    expect(splitMessageText('oi')).toEqual(['oi']);
    const exato = 'x'.repeat(MESSAGE_PART_MAX);
    expect(splitMessageText(exato)).toEqual([exato]);
  });

  it('listagem de 4518 chars vira 2 partes numeradas (caso do bug)', () => {
    const linhas = Array.from({ length: 120 }, (_, i) => `item ${i + 1} — produto ${i + 1}`.padEnd(36, '.'));
    const text = linhas.join('\n').slice(0, 4518);
    const parts = splitMessageText(text);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.startsWith('(parte 1/2)\n')).toBe(true);
    expect(parts[1]!.startsWith('(parte 2/2)\n')).toBe(true);
  });

  it('respeita quebra de linha — nenhuma linha é cortada no meio', () => {
    const linhas = Array.from({ length: 300 }, (_, i) => `linha-${i}-${'y'.repeat(30)}`);
    const text = linhas.join('\n');
    const parts = splitMessageText(text);
    const reconstruido = parts
      .map((p) => p.replace(/^\(parte \d+\/\d+\)\n/, ''))
      .join('\n')
      .split('\n');
    for (const linha of reconstruido) {
      expect(linhas).toContain(linha);
    }
  });

  it('cada parte cabe no limite do canal (4096) mesmo com prefixo', () => {
    const text = 'z'.repeat(60_000);
    const parts = splitMessageText(text);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(4096);
    }
  });

  it('sem quebra de linha nem espaço → corte duro sem perder conteúdo', () => {
    const text = 'a'.repeat(8000);
    const parts = splitMessageText(text);
    const total = parts
      .map((p) => p.replace(/^\(parte \d+\/\d+\)\n/, ''))
      .join('');
    expect(total).toBe(text);
  });

  it('partes vêm em ordem e a numeração bate com o total', () => {
    const text = Array.from({ length: 400 }, (_, i) => `linha ${i}`).join('\n').repeat(4);
    const parts = splitMessageText(text);
    parts.forEach((p, i) => {
      expect(p.startsWith(`(parte ${i + 1}/${parts.length})\n`)).toBe(true);
    });
  });
});
