import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../env';

const KEY = Buffer.from(env.ENCRYPTION_KEY, 'hex');
const ALGO = 'aes-256-gcm';

/**
 * Criptografa string com AES-256-GCM. Output format: iv:tag:ciphertext (hex).
 * Usado pra secrets sensíveis em DB (ex: auth state Baileys na Fase 2).
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decrypt(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted payload format');
  const [ivHex, tagHex, encHex] = parts as [string, string, string];
  const decipher = createDecipheriv(ALGO, KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}
