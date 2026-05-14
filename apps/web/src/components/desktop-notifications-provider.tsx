'use client';

import { useEffect, useRef } from 'react';
import { useRealtimeListener } from '@/hooks/use-realtime-listener';

/**
 * Liga Notification API do browser + ping de áudio às mensagens entrantes.
 * Silencioso por padrão até que o user permita.
 */
export function DesktopNotificationsProvider() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
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

  function ping() {
    const now = Date.now();
    // Debounce 1.5s pra não tocar 10 sons seguidos numa rajada
    if (now - lastPingRef.current < 1500) return;
    lastPingRef.current = now;
    const a = audioRef.current;
    if (a) {
      a.currentTime = 0;
      a.play().catch(() => {
        /* autoplay bloqueado é ok — só falha silenciosa */
      });
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

  return (
    <>
      {/* Áudio inline ~300ms ping. Fonte data URL simples (beep curto) */}
      <audio
        ref={audioRef}
        preload="auto"
        src="data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA="
      />
    </>
  );
}
