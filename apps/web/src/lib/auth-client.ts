import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  // Mesma origem do Next (proxy reverso pro api via rewrites)
  baseURL: typeof window !== 'undefined' ? window.location.origin : '',
});

export const { signIn, signUp, signOut, useSession, getSession } = authClient;
