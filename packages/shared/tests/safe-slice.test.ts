import { describe, expect, it } from 'vitest';
import { safeSlice } from '../src/safe-slice';

const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe('safeSlice', () => {
  it('devolve o texto inteiro quando cabe', () => {
    expect(safeSlice('oi 📦', 80)).toBe('oi 📦');
  });

  it('corta normal quando o limite não cai num emoji', () => {
    expect(safeSlice('abcdef', 3)).toBe('abc');
  });

  it('não deixa metade de emoji quando o corte cai no meio do par', () => {
    // 'ab' + 📦 (2 unidades): cortar em 3 partiria o emoji.
    const out = safeSlice('ab📦cd', 3);
    expect(out).toBe('ab');
    expect(loneSurrogate.test(out)).toBe(false);
  });

  it('resposta real do bot de estoque (02/11) sai válida em qualquer limite', () => {
    const text =
      '📦 *ESTOQUE - Código 14-007-00363*\n📅 02/11/2026 - 03:00\n━━━━━━━━━━━━━━━━━━━━\n\n🏢 *CENTRAL*\n\nNome do produto: ARM';
    for (let n = 1; n <= text.length; n++) {
      const out = safeSlice(text, n);
      expect(out.length).toBeLessThanOrEqual(n);
      expect(loneSurrogate.test(out)).toBe(false);
      // JSON que o Prisma manda pro motor precisa ser reversível.
      expect(JSON.parse(JSON.stringify(out))).toBe(out);
    }
  });
});
