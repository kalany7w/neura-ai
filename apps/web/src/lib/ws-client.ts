'use client';

import { useRealtimeStore } from './realtime-store';

export interface RealtimeEvent<T = unknown> {
  event: string;
  payload: T;
  ts?: number;
}

type Listener = (event: RealtimeEvent) => void;

class RealtimeClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  private readonly backoff = [1_000, 2_000, 4_000, 8_000, 30_000];

  connect(): void {
    if (typeof window === 'undefined') return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.intentionalClose = false;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws`;
    useRealtimeStore.getState().setState('connecting');
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      useRealtimeStore.getState().setState('open');
      this.reconnectAttempts = 0;
      this.startPing();
    };

    this.ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as RealtimeEvent;
        useRealtimeStore.getState().bumpEvent();
        for (const l of this.listeners) l(data);
      } catch {
        // ignore non-JSON
      }
    };

    this.ws.onclose = () => {
      useRealtimeStore.getState().setState('closed');
      this.stopPing();
      if (!this.intentionalClose) this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose vai disparar logo depois
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(event: string, payload?: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ event, payload }));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.backoff[Math.min(this.reconnectAttempts, this.backoff.length - 1)] ?? 30_000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => this.send('ping'), 30_000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}

export const realtimeClient = new RealtimeClient();

// Hook helper exposto em hooks/use-realtime-listener.ts pra evitar require dinâmico
