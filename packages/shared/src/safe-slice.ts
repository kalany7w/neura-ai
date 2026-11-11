/**
 * Corta um texto em no máximo `max` unidades UTF-16 sem partir um emoji ao meio.
 *
 * `text.slice(0, n)` pode cortar entre as duas metades de um par substituto (todo emoji fora
 * do plano básico, como 📦 ou 🏢). A metade solta vira uma string inválida e o Postgres, via
 * Prisma, recusa o UPDATE com "unexpected end of hex escape" — a resposta inteira falhava com
 * 500 e o usuário do WhatsApp ficava sem nada (11/11/2026).
 */
export function safeSlice(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}
