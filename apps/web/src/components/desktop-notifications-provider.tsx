'use client';

import { useEffect, useRef } from 'react';
import { useRealtimeListener } from '@/hooks/use-realtime-listener';

/**
 * Liga Notification API do browser + ping de áudio às mensagens entrantes.
 * Silencioso por padrão até que o user permita.
 */
export function DesktopNotificationsProvider() {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const lastPingRef = useRef(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Pede permission silenciosamente uma vez por sessão
    if ('Notification' in window && Notification.permission === 'default') {
      // Esperar 3s pra não ser intrusivo no boot
      const t = setTimeout(() => {
        Notification.requestPermission().catch(() => {});
      }, 3000);
      return () => clearTimeout(t);
    }
  }, []);

  function shouldNotify(): boolean {
    if (typeof document === 'undefined') return false;
    return document.hidden || !document.hasFocus();
  }

  /**
   * Beep sintetizado no WebAudio.
   *
   * Antes era um <audio src="data:audio/wav;base64,..."> que nunca tocou por dois
   * motivos somados: a CSP não libera `data:` em media-src (o browser bloqueava o
   * carregamento) e o WAV embutido tinha data chunk de 0 bytes — era silêncio.
   * Gerando o tom aqui não há recurso de mídia para a CSP barrar nem arquivo para
   * servir.
   */
  function ping() {
    const now = Date.now();
    // Debounce 1.5s pra não tocar 10 sons seguidos numa rajada
    if (now - lastPingRef.current < 1500) return;
    lastPingRef.current = now;

    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      audioCtxRef.current ??= new Ctx();
      const ctx = audioCtxRef.current;
      // Sem gesto do usuário na aba o contexto nasce suspenso; retomar é no-op
      // quando já está rodando.
      void ctx.resume().catch(() => {});

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      // Envelope curto: sobe rápido e decai, pra soar como um "ding" e não um bip seco.
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.26);
    } catch {
      /* áudio indisponível não pode derrubar a notificação visual */
    }
  }

  useRealtimeListener((event) => {
    if (!shouldNotify()) return;
    // 1) Notification persistente (kind === 'notification.new' vem do canal user:)
    if (event.event === 'notification.new') {
      const p = event.payload as { title?: string; body?: string; link?: string } | null;
      if (!p) return;
      try {
        if (Notification.permission === 'granted') {
          const n = new Notification(p.title ?? 'Neura AI', {
            body: p.body ?? '',
            icon: '/favicon.ico',
            tag: 'neura-notif',
          });
          n.onclick = () => {
            window.focus();
            if (p.link) window.location.href = p.link;
            n.close();
          };
        }
      } catch {
        /* notification API pode falhar em iframe restrito */
      }
      ping();
      return;
    }

    // 2) Mensagem nova INBOUND — só ping, sem desktop notif (notificações geram desktop)
    if (event.event === 'message.new') {
      const p = event.payload as { message?: { direction?: string } } | null;
      if (p?.message?.direction === 'INBOUND') ping();
    }
  });

  return null;
}
