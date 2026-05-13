import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';

/**
 * Factory de funções de criptografia AES-256-GCM.
 * Cada app cria com sua própria chave hex (32 bytes / 64 chars hex).
 * Output format: iv:tag:ciphertext (hex).
 */
export function createCrypto(hexKey: string): {
  encrypt: (plaintext: string) => string;
  decrypt: (payload: string) => string;
} {
  if (hexKey.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  }
  const KEY = Buffer.from(hexKey, 'hex');

  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv(ALGO, KEY, iv);
      const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
    },

    decrypt(payload: string): string {
      const parts = payload.split(':');
      if (parts.length !== 3) throw new Error('Invalid encrypted payload format');
      const [ivHex, tagHex, encHex] = parts as [string, string, string];
      const decipher = createDecipheriv(ALGO, KEY, Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      const dec = Buffer.concat([
        decipher.update(Buffer.from(encHex, 'hex')),
        decipher.final(),
      ]);
      return dec.toString('utf8');
    },
  };
}
