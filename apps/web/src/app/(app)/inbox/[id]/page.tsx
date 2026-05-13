'use client';

import { use, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Clock,
  FileText,
  MessageSquare,
  PauseCircle,
  PlayCircle,
  Send,
  StickyNote,
  Trash2,
  UserCheck,
  UserX,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useRealtimeListener } from '@/hooks/use-realtime-listener';
import { useSession } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ConversationSidePanel } from '@/components/inbox/conversation-side-panel';

interface Member {
  userId: string;
  role: string;
  user: { id: string; name: string | null; email: string };
}

type ConvStatus = 'OPEN' | 'PENDING' | 'RESOLVED' | 'SNOOZED';

const STATUS_OPTIONS: Array<{
  value: ConvStatus;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  className: string;
}> = [
  { value: 'OPEN', label: 'Aberta', Icon: PlayCircle, className: 'text-blue-600' },
  { value: 'PENDING', label: 'Pendente', Icon: Clock, className: 'text-amber-600' },
  { value: 'RESOLVED', label: 'Resolvida', Icon: CheckCircle2, className: 'text-emerald-600' },
  { value: 'SNOOZED', label: 'Adiada', Icon: PauseCircle, className: 'text-slate-600' },
];

const STATUS_BADGE_CLASS: Record<ConvStatus, string> = {
  OPEN: 'bg-blue-100 text-blue-700',
  PENDING: 'bg-amber-100 text-amber-800',
  RESOLVED: 'bg-emerald-100 text-emerald-700',
  SNOOZED: 'bg-slate-200 text-slate-700',
};

function initialsFromName(s: string | null | undefined): string {
  if (!s) return '?';
  return s
    .split(/[\s.@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

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

interface NoteItem {
  id: string;
  authorId: string;
  body: string;
  createdAt: string;
}

interface TemplateItem {
  id: string;
  name: string;
  shortcut: string | null;
  body: string;
}

interface ConversationDetail {
  id: string;
  status: ConvStatus;
  assignedAgentId: string | null;
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

function applyTemplate(body: string, contact: ConversationDetail['contact']): string {
  return body
    .replaceAll('{{contact.name}}', contact.name ?? contact.phoneNumber)
    .replaceAll('{{contact.phoneNumber}}', contact.phoneNumber);
}

export default function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: session } = useSession();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [showTemplates, setShowTemplates] = useState(false);

  const { data, isLoading } = useQuery<{ conversation: ConversationDetail }>({
    queryKey: ['conversation', id],
    queryFn: () => api(`/api/conversations/${id}`),
  });

  const { data: notesData } = useQuery<{ notes: NoteItem[] }>({
    queryKey: ['conversation', id, 'notes'],
    queryFn: () => api(`/api/conversations/${id}/notes`),
  });

  const { data: templatesData } = useQuery<{ templates: TemplateItem[] }>({
    queryKey: ['templates'],
    queryFn: () => api('/api/templates'),
  });

  const { data: wsData } = useQuery<{ workspace: { members: Member[] } }>({
    queryKey: ['workspace-me'],
    queryFn: () => api('/api/workspaces/me'),
  });
  const members = wsData?.workspace.members ?? [];

  useEffect(() => {
    if (!data?.conversation) return;
    if (data.conversation.unreadCount > 0) {
      api(`/api/conversations/${id}/read`, { method: 'POST' }).catch(() => {});
    }
  }, [data?.conversation?.id, data?.conversation?.unreadCount, id]);

  // Auto-scroll quando novos itens chegam
  const timelineLen = (data?.conversation.messages.length ?? 0) + (notesData?.notes.length ?? 0);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [timelineLen]);

  useRealtimeListener((event) => {
    if (
      event.event === 'message.new' ||
      event.event === 'message.status' ||
      event.event === 'message.media_ready' ||
      event.event === 'conversation.status_changed' ||
      event.event === 'conversation.assigned'
    ) {
      qc.invalidateQueries({ queryKey: ['conversation', id] });
    }
    if (event.event === 'note.added' || event.event === 'note.removed') {
      qc.invalidateQueries({ queryKey: ['conversation', id, 'notes'] });
    }
  });

  async function updateConversation(payload: { status?: ConvStatus; assignedAgentId?: string | null }) {
    try {
      await api(`/api/conversations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      toast.success(
        payload.status
          ? `Status: ${STATUS_OPTIONS.find((s) => s.value === payload.status)?.label}`
          : payload.assignedAgentId === null
            ? 'Atribuição removida'
            : 'Atribuído',
      );
      await qc.invalidateQueries({ queryKey: ['conversation', id] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  // Atalhos de template: digitou /nome → expande
  function maybeExpandShortcut(value: string): string {
    if (!templatesData?.templates || !data?.conversation) return value;
    const match = value.trim().match(/^(\/[a-z0-9_-]{1,30})$/i);
    if (!match) return value;
    const tpl = templatesData.templates.find((t) => t.shortcut === match[1]);
    if (!tpl) return value;
    return applyTemplate(tpl.body, data.conversation.contact);
  }

  async function handleSend() {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      if (mode === 'note') {
        await api(`/api/conversations/${id}/notes`, {
          method: 'POST',
          body: JSON.stringify({ body: text }),
        });
        setText('');
        await qc.invalidateQueries({ queryKey: ['conversation', id, 'notes'] });
      } else {
        const expanded = maybeExpandShortcut(text);
        await api(`/api/conversations/${id}/messages`, {
          method: 'POST',
          body: JSON.stringify({ type: 'TEXT', text: expanded }),
        });
        setText('');
        await qc.invalidateQueries({ queryKey: ['conversation', id] });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    } finally {
      setSending(false);
    }
  }

  function pickTemplate(tpl: TemplateItem) {
    if (!data?.conversation) return;
    setText(applyTemplate(tpl.body, data.conversation.contact));
    setShowTemplates(false);
    setMode('reply');
    inputRef.current?.focus();
  }

  async function removeNote(noteId: string) {
    if (!confirm('Remover esta nota?')) return;
    try {
      await api(`/api/notes/${noteId}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['conversation', id, 'notes'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  // Timeline merged (mensagens + notas) ordenadas por createdAt
  const timeline = useMemo(() => {
    type TimelineItem =
      | ({ kind: 'msg' } & MessageItem)
      | ({ kind: 'note' } & NoteItem);
    const items: TimelineItem[] = [
      ...(data?.conversation.messages ?? []).map((m) => ({ kind: 'msg' as const, ...m })),
      ...(notesData?.notes ?? []).map((n) => ({ kind: 'note' as const, ...n })),
    ];
    items.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return items;
  }, [data, notesData]);

  if (isLoading) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  if (!data?.conversation) return <p className="text-sm text-destructive">Conversa não encontrada.</p>;

  const conv = data.conversation;
  const currentUserId = session?.user?.id;
  const assignee = members.find((m) => m.userId === conv.assignedAgentId);
  const currentStatusOpt = STATUS_OPTIONS.find((s) => s.value === conv.status) ?? STATUS_OPTIONS[0]!;
  const CurStatusIcon = currentStatusOpt.Icon;

  return (
    <div className="flex h-[calc(100vh-7rem)] gap-0">
      <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <div className="flex items-center gap-3 min-w-0">
          <Button asChild size="icon" variant="ghost">
            <Link href="/inbox">
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
          <div className="min-w-0">
            <h1 className="truncate font-semibold">{conv.contact.name ?? conv.contact.phoneNumber}</h1>
            <p className="truncate text-xs text-muted-foreground">
              {conv.contact.phoneNumber} · {conv.inbox.name}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Status switcher */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium hover:opacity-90 ${STATUS_BADGE_CLASS[conv.status]}`}
              >
                <CurStatusIcon className="h-3.5 w-3.5" />
                {currentStatusOpt.label}
                <ChevronDown className="h-3 w-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Mudar status</DropdownMenuLabel>
              {STATUS_OPTIONS.map((opt) => {
                const Icon = opt.Icon;
                return (
                  <DropdownMenuItem
                    key={opt.value}
                    onSelect={() => updateConversation({ status: opt.value })}
                    disabled={opt.value === conv.status}
                  >
                    <Icon className={`h-3.5 w-3.5 ${opt.className}`} />
                    {opt.label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Assignee switcher */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs hover:bg-accent"
              >
                {assignee ? (
                  <>
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-[9px] font-semibold uppercase text-white">
                      {initialsFromName(assignee.user.name ?? assignee.user.email)}
                    </span>
                    <span className="max-w-[140px] truncate font-medium">
                      {assignee.user.name ?? assignee.user.email}
                    </span>
                  </>
                ) : (
                  <>
                    <UserX className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">Sem agente</span>
                  </>
                )}
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
              <DropdownMenuLabel>Atribuir conversa</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => updateConversation({ assignedAgentId: null })}>
                <UserX className="h-3.5 w-3.5" />
                Remover atribuição
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {members.map((m) => (
                <DropdownMenuItem
                  key={m.userId}
                  onSelect={() => updateConversation({ assignedAgentId: m.userId })}
                  className={conv.assignedAgentId === m.userId ? 'bg-accent/60' : ''}
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-[9px] font-semibold uppercase text-white">
                    {initialsFromName(m.user.name ?? m.user.email)}
                  </span>
                  {m.user.name ?? m.user.email}
                  {conv.assignedAgentId === m.userId && (
                    <UserCheck className="ml-auto h-3.5 w-3.5" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto py-4 space-y-3">
        {timeline.map((item) =>
          item.kind === 'note' ? (
            <div key={`note-${item.id}`} className="flex justify-center">
              <div className="group relative max-w-[80%] rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-700">
                <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider opacity-70">
                  <StickyNote className="h-3 w-3" />
                  Nota interna
                </div>
                <p className="whitespace-pre-wrap break-words">{item.body}</p>
                <p className="mt-1 text-[10px] opacity-60">
                  {new Date(item.createdAt).toLocaleString('pt-BR')}
                </p>
                {item.authorId === currentUserId && (
                  <button
                    type="button"
                    onClick={() => removeNote(item.id)}
                    className="absolute -top-2 -right-2 hidden rounded-full bg-destructive p-1 text-destructive-foreground group-hover:block"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div
              key={item.id}
              className={`flex ${item.direction === 'OUTBOUND' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[70%] rounded-lg px-3 py-2 text-sm ${
                  item.direction === 'OUTBOUND'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-foreground'
                }`}
              >
                {item.type === 'IMAGE' && item.mediaUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.mediaUrl} alt="" className="mb-1 max-h-64 rounded-md" />
                )}
                {item.type === 'AUDIO' && item.mediaUrl && (
                  <audio controls src={item.mediaUrl} className="mb-1 w-full" />
                )}
                {item.type === 'VIDEO' && item.mediaUrl && (
                  <video controls src={item.mediaUrl} className="mb-1 max-h-64 rounded-md" />
                )}
                {item.type === 'DOCUMENT' && item.mediaUrl && (
                  <a
                    href={item.mediaUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mb-1 block underline"
                  >
                    Documento ({item.mediaMimeType})
                  </a>
                )}
                {item.content && <p className="whitespace-pre-wrap break-words">{item.content}</p>}
                <p className="mt-1 text-[10px] opacity-70">
                  {new Date(item.createdAt).toLocaleTimeString('pt-BR', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}{' '}
                  {item.direction === 'OUTBOUND' && STATUS_ICON[item.status]}
                </p>
              </div>
            </div>
          ),
        )}
      </div>

      <div className="border-t pt-3 space-y-2">
        {conv.inbox.status !== 'CONNECTED' && mode === 'reply' && (
          <p className="text-xs text-amber-600">
            Inbox não conectada — conecte em /inboxes antes de responder.
          </p>
        )}

        {showTemplates && templatesData?.templates && (
          <div className="rounded-md border bg-popover p-2 max-h-48 overflow-y-auto">
            {templatesData.templates.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                Sem templates. Crie em Configurações → Templates.
              </p>
            ) : (
              templatesData.templates.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => pickTemplate(tpl)}
                  className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <span className="font-medium">{tpl.name}</span>
                  {tpl.shortcut && (
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {tpl.shortcut}
                    </span>
                  )}
                  <p className="text-xs text-muted-foreground line-clamp-2">{tpl.body}</p>
                </button>
              ))
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <div className="flex rounded-md border bg-muted p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setMode('reply')}
              className={`flex items-center gap-1 rounded px-2.5 py-1 ${
                mode === 'reply' ? 'bg-background shadow-sm' : 'text-muted-foreground'
              }`}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              Responder
            </button>
            <button
              type="button"
              onClick={() => setMode('note')}
              className={`flex items-center gap-1 rounded px-2.5 py-1 ${
                mode === 'note' ? 'bg-amber-100 text-amber-900 shadow-sm dark:bg-amber-900 dark:text-amber-100' : 'text-muted-foreground'
              }`}
            >
              <StickyNote className="h-3.5 w-3.5" />
              Nota interna
            </button>
          </div>

          {mode === 'reply' && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setShowTemplates((v) => !v)}
              title="Templates de resposta"
            >
              <FileText className="h-4 w-4" />
            </Button>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="flex items-center gap-2"
        >
          <Input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              mode === 'note'
                ? 'Nota interna (só agentes veem)…'
                : 'Mensagem… (digite /atalho pra expandir template)'
            }
            disabled={sending || (mode === 'reply' && conv.inbox.status !== 'CONNECTED')}
            className={mode === 'note' ? 'border-amber-400 bg-amber-50/50 dark:bg-amber-950/30' : ''}
          />
          <Button
            type="submit"
            disabled={
              sending ||
              !text.trim() ||
              (mode === 'reply' && conv.inbox.status !== 'CONNECTED')
            }
            size="icon"
          >
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </div>
      </div>

      {/* Side panel: info do contato + conversas anteriores + cards */}
      <div className="hidden lg:block">
        <ConversationSidePanel
          contactId={conv.contact.id}
          currentConversationId={conv.id}
        />
      </div>
    </div>
  );
}
