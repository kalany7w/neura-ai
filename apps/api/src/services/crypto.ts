import { createCrypto } from '@neura/shared/crypto';
import { env } from '../env.js';

export const { encrypt, decrypt } = createCrypto(env.ENCRYPTION_KEY);
