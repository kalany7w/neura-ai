/**
 * WhatsApp/Telegram rejeitam corpo de texto acima de 4096 chars — antes disso
 * a API devolvia 400 e a mensagem sumia em silêncio. Partes de 3500 deixam
 * folga pro rótulo "(parte i/n)" e pra metadata do canal.
 */
export const MESSAGE_PART_MAX = 3500;

/** Teto de entrada da API (limite real de texto do WhatsApp). */
export const MESSAGE_TEXT_MAX = 65536;

/**
 * Quebra texto longo em partes de até MESSAGE_PART_MAX, preferindo quebra de
 * linha, depois espaço, senão corte duro. Com 2+ partes, cada uma ganha o
 * prefixo "(parte i/n)". Texto curto volta intacto em array de 1.
 */
export function splitMessageText(text: string, max = MESSAGE_PART_MAX): string[] {
  if (text.length <= max) return [text];

  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    // Procura quebra "natural" na janela; abaixo de metade da janela não vale
    // a pena (geraria partes minúsculas) — cai pro próximo fallback.
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest.length > 0) parts.push(rest);

  const nonEmpty = parts.filter((p) => p.length > 0);
  if (nonEmpty.length <= 1) return nonEmpty.length ? nonEmpty : [text.slice(0, max)];
  return nonEmpty.map((p, i) => `(parte ${i + 1}/${nonEmpty.length})\n${p}`);
}
