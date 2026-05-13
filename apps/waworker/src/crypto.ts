import { createCrypto } from '@neura/shared/crypto';
import { env } from './env';

export const { encrypt, decrypt } = createCrypto(env.ENCRYPTION_KEY);
