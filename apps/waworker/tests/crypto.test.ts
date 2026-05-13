import { describe, it, expect } from 'vitest';
import { createCrypto } from '@neura/shared/crypto';

describe('waworker crypto factory', () => {
  it('roundtrip encrypt/decrypt with given key', () => {
    const { encrypt, decrypt } = createCrypto('0'.repeat(64));
    const plain = JSON.stringify({ creds: 'mock', keys: { test: 'value' } });
    const enc = encrypt(plain);
    expect(enc).not.toContain('mock');
    expect(decrypt(enc)).toBe(plain);
  });

  it('rejects short key', () => {
    expect(() => createCrypto('abc')).toThrow();
  });

  it('produces different ciphertext for same plaintext (random IV)', () => {
    const { encrypt } = createCrypto('a'.repeat(64));
    expect(encrypt('foo')).not.toBe(encrypt('foo'));
  });
});
