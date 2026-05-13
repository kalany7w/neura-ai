'use client';

import { create } from 'zustand';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed';

interface RealtimeStore {
  state: ConnectionState;
  setState: (s: ConnectionState) => void;
  /** Last event received per channel — usado pra debug e refetch delta */
  lastEventAt: number | null;
  bumpEvent: () => void;
}

export const useRealtimeStore = create<RealtimeStore>((set) => ({
  state: 'idle',
  setState: (state) => set({ state }),
  lastEventAt: null,
  bumpEvent: () => set({ lastEventAt: Date.now() }),
}));
