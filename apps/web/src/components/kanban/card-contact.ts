import { ApiError } from '@/lib/api';

// Mesmo formato que a API aceita: só dígitos, com + e código do país (E.164).
export function normalizeCardPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  const phone = `+${digits}`;
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}

export const CARD_PHONE_HINT = 'Use + e código do país, ex.: +595 981 123456';

// Payload do contato do card; `null` = telefone vazio, `'invalid'` = digitado errado.
export function buildCardContact(
  name: string,
  phone: string,
): { phoneNumber: string; name?: string } | null | 'invalid' {
  if (!phone.trim()) return null;
  const phoneNumber = normalizeCardPhone(phone);
  if (!phoneNumber) return 'invalid';
  const trimmed = name.trim();
  return trimmed ? { phoneNumber, name: trimmed } : { phoneNumber };
}

export function cardContactErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === 'no_whatsapp_inbox') {
      return 'Nenhum WhatsApp cadastrado neste ambiente. Conecte um número em Inboxes.';
    }
    if (err.code === 'invalid_input') return `Dados inválidos. ${CARD_PHONE_HINT}`;
  }
  return err instanceof Error ? err.message : fallback;
}
