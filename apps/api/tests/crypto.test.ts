import { describe, it, expect } from 'vitest';

describe('crypto AES-256-GCM', () => {
  it('encrypts and decrypts round-trip', async () => {
    const { encrypt, decrypt } = await import('../src/services/crypto');
    const plaintext = 'super-secret-baileys-auth-state-{"foo":"bar","n":42}';
    const enc = encrypt(plaintext);
    expect(enc).not.toContain('super-secret');
    expect(enc.split(':')).toHaveLength(3);
    expect(decrypt(enc)).toBe(plaintext);
  });

  it('produces different ciphertext for same plaintext (random IV)', async () => {
    const { encrypt } = await import('../src/services/crypto');
    const a = encrypt('same-input');
    const b = encrypt('same-input');
    expect(a).not.toBe(b);
  });

  it('throws on tampered ciphertext', async () => {
    const { encrypt, decrypt } = await import('../src/services/crypto');
    const enc = encrypt('hello');
    const parts = enc.split(':');
    parts[2] = parts[2]!.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
    const tampered = parts.join(':');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('throws on invalid format', async () => {
    const { decrypt } = await import('../src/services/crypto');
    expect(() => decrypt('not-valid-format')).toThrow('Invalid encrypted payload format');
  });
});
