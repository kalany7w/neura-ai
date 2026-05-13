'use client';

import { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Send } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useRealtimeListener } from '@/hooks/use-realtime-listener';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface MessageItem {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  type: 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'LOCATION' | 'CONTACT' | 'STICKER' | 'SYSTEM';
  content: string | null;
  mediaUrl: string | null;
  mediaMimeType: string | null;
  status: 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  createdAt: string;
}

interface ConversationDetail {
  id: string;
  status: 'OPEN' | 'PENDING' | 'RESOLVED' | 'SNOOZED';
  unreadCount: number;
  contact: { id: string; name: string | null; phoneNumber: string; avatarUrl: string | null };
  inbox: { id: string; name: string; status: string };
  messages: MessageItem[];
}

const STATUS_ICON: Record<MessageItem['status'], string> = {
  PENDING: '⏳',
  SENT: '✓',
  DELIVERED: '✓✓',
  READ: '✓✓',
  FAILED: '⚠',
};

export default function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const { data, isLoading } = useQuery<{ conversation: ConversationDetail }>({
    queryKey: ['conversation', id],
    queryFn: () => api(`/api/conversations/${id}`),
  });

  // Marca como lida ao abrir
  useEffect(() => {
    if (!data?.conversation) return;
    if (data.conversation.unreadCount > 0) {
      api(`/api/conversations/${id}/read`, { method: 'POST' }).catch(() => {});
    }
  }, [data?.conversation?.id, data?.conversation?.unreadCount, id]);

  // Auto-scroll quando msgs novas chegam
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [data?.conversation?.messages.length]);

  // Real-time: refetch quando mensagem nova chega
  useRealtimeListener((event) => {
    if (
      (event.event === 'message.new' || event.event === 'message.status' || event.event === 'message.media_ready') &&
      typeof event.payload === 'object' &&
      event.payload !== null
    ) {
      qc.invalidateQueries({ queryKey: ['conversation', id] });
    }
  });

  async function handleSend() {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await api(`/api/conversations/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ type: 'TEXT', text }),
      });
      setText('');
      await qc.invalidateQueries({ queryKey: ['conversation', id] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao enviar');
    } finally {
      setSending(false);
    }
  }

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Carregando…</p>;
  }
  if (!data?.conversation) {
    return <p className="text-sm text-destructive">Conversa não encontrada.</p>;
  }

  const conv = data.conversation;

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col">
      <div className="flex items-center justify-between gap-2 border-b pb-3">
        <div className="flex items-center gap-3">
          <Button asChild size="icon" variant="ghost">
            <Link href="/inbox">
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
          <div>
            <h1 className="font-semibold">{conv.contact.name ?? conv.contact.phoneNumber}</h1>
            <p className="text-xs text-muted-foreground">
              {conv.contact.phoneNumber} · {conv.inbox.name}
            </p>
          </div>
        </div>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{conv.status}</span>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto py-4 space-y-3">
        {conv.messages.map((m) => (
          <div
            key={m.id}
            className={`flex ${m.direction === 'OUTBOUND' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[70%] rounded-lg px-3 py-2 text-sm ${
                m.direction === 'OUTBOUND'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-foreground'
              }`}
            >
              {m.type === 'IMAGE' && m.mediaUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={m.mediaUrl} alt="" className="mb-1 max-h-64 rounded-md" />
              )}
              {m.type === 'AUDIO' && m.mediaUrl && (
                <audio controls src={m.mediaUrl} className="mb-1 w-full" />
              )}
              {m.type === 'VIDEO' && m.mediaUrl && (
                <video controls src={m.mediaUrl} className="mb-1 max-h-64 rounded-md" />
              )}
              {m.type === 'DOCUMENT' && m.mediaUrl && (
                <a
                  href={m.mediaUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mb-1 block underline"
                >
                  Documento ({m.mediaMimeType})
                </a>
              )}
              {m.content && <p className="whitespace-pre-wrap break-words">{m.content}</p>}
              <p className="mt-1 text-[10px] opacity-70">
                {new Date(m.createdAt).toLocaleTimeString('pt-BR', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}{' '}
                {m.direction === 'OUTBOUND' && STATUS_ICON[m.status]}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="border-t pt-3">
        {conv.inbox.status !== 'CONNECTED' && (
          <p className="mb-2 text-xs text-amber-600">
            Inbox não conectada — conecte em /inboxes antes de responder.
          </p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="flex items-center gap-2"
        >
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Mensagem…"
            disabled={sending || conv.inbox.status !== 'CONNECTED'}
          />
          <Button
            type="submit"
            disabled={sending || !text.trim() || conv.inbox.status !== 'CONNECTED'}
            size="icon"
          >
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}
