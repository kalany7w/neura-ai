'use client';

import { use, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Ban,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  CornerDownRight,
  FileText,
  Forward,
  Mail,
  MapPin,
  Mic,
  MoreHorizontal,
  Paperclip,
  Pencil,
  MessageSquare,
  PauseCircle,
  PlayCircle,
  Reply,
  Send,
  Square,
  StickyNote,
  Trash2,
  UserCheck,
  UserX,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useConfirm } from '@/components/confirm-provider';
import { useRealtimeListener } from '@/hooks/use-realtime-listener';
import { realtimeClient } from '@/lib/ws-client';
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
import { ScheduleMessageDialog } from '@/components/inbox/schedule-message-dialog';
import { ForwardMessageDialog } from '@/components/inbox/forward-message-dialog';

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

interface ReactionItem {
  id: string;
  emoji: string;
  fromMe: boolean;
}

interface MessageItem {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  type: 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'LOCATION' | 'CONTACT' | 'STICKER' | 'SYSTEM';
  content: string | null;
  mediaUrl: string | null;
  mediaMimeType: string | null;
  thumbnailUrl: string | null;
  status: 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  transcription: string | null;
  transcriptionStatus: 'PENDING' | 'COMPLETED' | 'FAILED' | null;
  editedAt: string | null;
  deletedAt: string | null;
  forwardedFromId: string | null;
  locationLat: number | null;
  locationLon: number | null;
  locationName: string | null;
  locationAddress: string | null;
  sentAt: string | null;
  createdAt: string;
  reactions: ReactionItem[];
}

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

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
  archivedAt: string | null;
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
  const confirm = useConfirm();
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: session } = useSession();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [showTemplates, setShowTemplates] = useState(false);
  const [replyTo, setReplyTo] = useState<MessageItem | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [recording, setRecording] = useState(false);
  const [recordingMs, setRecordingMs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [dragging, setDragging] = useState(false);

  // Typing indicator — contato digitando
  const [partnerTyping, setPartnerTyping] = useState(false);
  const partnerTypingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Typing indicator — agente digitando (envia presença pro cliente)
  const lastTypingSentState = useRef<'composing' | 'paused' | null>(null);
  const lastTypingSentAt = useRef(0);
  const pausedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Toggle de visualização de transcrição (msgId → exibir?)
  const [showTranscription, setShowTranscription] = useState<Record<string, boolean>>({});
  // Edição inline: msgId em edição + texto
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [editingBusy, setEditingBusy] = useState(false);
  // Forward
  const [forwardingMessageId, setForwardingMessageId] = useState<string | null>(null);

  async function uploadAndSend(
    file: File | Blob,
    filename: string,
    contentType: string,
    type: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT',
  ) {
    try {
      const presigned = await api<{ uploadUrl: string; publicUrl: string }>(
        '/api/uploads/sign',
        {
          method: 'POST',
          body: JSON.stringify({ filename, contentType, size: file.size }),
        },
      );
      const putRes = await fetch(presigned.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: file,
      });
      if (!putRes.ok) throw new Error(`Upload falhou: HTTP ${putRes.status}`);
      await api(`/api/conversations/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          type,
          mediaUrl: presigned.publicUrl,
          mimeType: contentType,
          fileName: filename,
          replyToMessageId: replyTo?.id,
        }),
      });
      setReplyTo(null);
      await qc.invalidateQueries({ queryKey: ['conversation', id] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao enviar mídia');
    }
  }

  function detectType(mime: string): 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' {
    if (mime.startsWith('image/')) return 'IMAGE';
    if (mime.startsWith('video/')) return 'VIDEO';
    if (mime.startsWith('audio/')) return 'AUDIO';
    return 'DOCUMENT';
  }

  async function handleFiles(files: FileList | File[]) {
    const arr = Array.from(files).slice(0, 5); // limit 5 por vez
    for (const f of arr) {
      const t = detectType(f.type || 'application/octet-stream');
      await uploadAndSend(f, f.name, f.type || 'application/octet-stream', t);
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeCandidates = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'];
      const supported = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
      const rec = new MediaRecorder(stream, supported ? { mimeType: supported } : undefined);
      recordChunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) recordChunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recordChunksRef.current, { type: supported || 'audio/webm' });
        const ext = supported.includes('ogg') ? '.ogg' : '.webm';
        const filename = `audio-${Date.now()}${ext}`;
        const contentType = supported || 'audio/webm';
        await uploadAndSend(blob, filename, contentType, 'AUDIO');
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
      setRecordingMs(0);
      recordTimerRef.current = setInterval(() => setRecordingMs((v) => v + 100), 100);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Microfone bloqueado');
    }
  }

  function stopRecording(send: boolean) {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      if (!send) {
        // cancela: limpa chunks antes do onstop disparar upload
        recordChunksRef.current = [];
      }
      rec.stop();
    }
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    setRecording(false);
    setRecordingMs(0);
  }

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
      event.event === 'message.transcribed' ||
      event.event === 'reaction.local' ||
      event.event === 'reaction.sent' ||
      event.event === 'conversation.status_changed' ||
      event.event === 'conversation.assigned'
    ) {
      qc.invalidateQueries({ queryKey: ['conversation', id] });
    }
    if (event.event === 'note.added' || event.event === 'note.removed') {
      qc.invalidateQueries({ queryKey: ['conversation', id, 'notes'] });
    }
    if (event.event === 'message.edited' || event.event === 'message.deleted') {
      qc.invalidateQueries({ queryKey: ['conversation', id] });
    }
    if (event.event === 'conversation.typing') {
      const p = event.payload as { conversationId?: string; isTyping?: boolean } | null;
      if (!p || p.conversationId !== id) return;
      if (p.isTyping) {
        setPartnerTyping(true);
        if (partnerTypingTimer.current) clearTimeout(partnerTypingTimer.current);
        // Auto-clear depois 6s sem update (paused às vezes não vem)
        partnerTypingTimer.current = setTimeout(() => setPartnerTyping(false), 6_000);
      } else {
        setPartnerTyping(false);
        if (partnerTypingTimer.current) clearTimeout(partnerTypingTimer.current);
      }
    }
  });

  // Cleanup typing timer no unmount
  useEffect(() => {
    return () => {
      if (partnerTypingTimer.current) clearTimeout(partnerTypingTimer.current);
      if (pausedTimer.current) clearTimeout(pausedTimer.current);
    };
  }, []);

  function sendTyping(state: 'composing' | 'paused') {
    if (!data?.conversation || data.conversation.inbox.status !== 'CONNECTED') return;
    const now = Date.now();
    // Throttle composing pra max 1x/4s; paused sempre passa
    if (state === 'composing' && lastTypingSentState.current === 'composing' && now - lastTypingSentAt.current < 4_000) {
      return;
    }
    realtimeClient.send('typing', { conversationId: id, state });
    lastTypingSentState.current = state;
    lastTypingSentAt.current = now;
  }

  function onComposerChange(value: string) {
    setText(value);
    if (mode !== 'reply') return;
    sendTyping('composing');
    if (pausedTimer.current) clearTimeout(pausedTimer.current);
    pausedTimer.current = setTimeout(() => sendTyping('paused'), 2_500);
  }

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

  async function markUnread() {
    try {
      await api(`/api/conversations/${id}/unread`, { method: 'POST' });
      toast.success('Marcada como não lida');
      await qc.invalidateQueries({ queryKey: ['conversation', id] });
      await qc.invalidateQueries({ queryKey: ['conversations'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function archive() {
    try {
      await api(`/api/conversations/${id}/archive`, { method: 'POST' });
      toast.success('Conversa arquivada');
      await qc.invalidateQueries({ queryKey: ['conversation', id] });
      await qc.invalidateQueries({ queryKey: ['conversations'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function unarchive() {
    try {
      await api(`/api/conversations/${id}/unarchive`, { method: 'POST' });
      toast.success('Conversa desarquivada');
      await qc.invalidateQueries({ queryKey: ['conversation', id] });
      await qc.invalidateQueries({ queryKey: ['conversations'] });
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
          body: JSON.stringify({
            type: 'TEXT',
            text: expanded,
            replyToMessageId: replyTo?.id,
          }),
        });
        setText('');
        setReplyTo(null);
        // Sinaliza que paramos de digitar
        if (pausedTimer.current) clearTimeout(pausedTimer.current);
        sendTyping('paused');
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

  async function react(messageId: string, emoji: string) {
    try {
      await api(`/api/messages/${messageId}/react`, {
        method: 'POST',
        body: JSON.stringify({ emoji }),
      });
      await qc.invalidateQueries({ queryKey: ['conversation', id] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao reagir');
    }
  }

  function startEdit(msg: MessageItem) {
    setEditingMessageId(msg.id);
    setEditingText(msg.content ?? '');
  }
  function cancelEdit() {
    setEditingMessageId(null);
    setEditingText('');
    setEditingBusy(false);
  }
  async function submitEdit() {
    if (!editingMessageId || !editingText.trim() || editingBusy) return;
    setEditingBusy(true);
    try {
      await api(`/api/messages/${editingMessageId}/edit`, {
        method: 'POST',
        body: JSON.stringify({ text: editingText.trim() }),
      });
      toast.success('Mensagem editada');
      cancelEdit();
      await qc.invalidateQueries({ queryKey: ['conversation', id] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao editar');
      setEditingBusy(false);
    }
  }
  async function revokeMessage(msg: MessageItem) {
    if (
      !(await confirm({
        title: 'Apagar mensagem pra todos?',
        description:
          'A mensagem some pra você e pro contato. Só funciona até ~7 minutos após o envio.',
        confirmLabel: 'Apagar',
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/messages/${msg.id}/delete`, { method: 'POST' });
      toast.success('Mensagem apagada');
      await qc.invalidateQueries({ queryKey: ['conversation', id] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao apagar');
    }
  }

  async function removeNote(noteId: string) {
    if (
      !(await confirm({
        title: 'Remover esta nota?',
        confirmLabel: 'Remover',
        destructive: true,
      }))
    )
      return;
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
    <div
      className="flex h-[calc(100vh-7rem)] gap-0 relative"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const files = e.dataTransfer.files;
        if (files.length > 0) handleFiles(files);
      }}
    >
      {dragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center rounded-lg border-4 border-dashed border-primary bg-primary/10 backdrop-blur-sm">
          <div className="text-center">
            <Paperclip className="mx-auto h-10 w-10 text-primary" />
            <p className="mt-2 font-semibold">Solte pra anexar</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Imagens, vídeos, áudios e PDFs até 100 MB
            </p>
          </div>
        </div>
      )}
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

          {/* More actions: marcar não lida, arquivar, etc */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-1 text-xs hover:bg-accent"
                title="Mais ações"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Ações</DropdownMenuLabel>
              <DropdownMenuItem onSelect={markUnread} disabled={conv.unreadCount > 0}>
                <Mail className="h-3.5 w-3.5" />
                Marcar como não lida
              </DropdownMenuItem>
              {conv.archivedAt ? (
                <DropdownMenuItem onSelect={unarchive}>
                  <ArchiveRestore className="h-3.5 w-3.5" />
                  Desarquivar
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={archive}>
                  <Archive className="h-3.5 w-3.5" />
                  Arquivar conversa
                </DropdownMenuItem>
              )}
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
              className={`group flex ${item.direction === 'OUTBOUND' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`self-center mx-1 flex items-center gap-0.5 rounded-full border bg-card px-1 py-0.5 shadow-sm opacity-0 transition group-hover:opacity-100 ${
                  item.direction === 'OUTBOUND' ? 'order-1' : 'order-2'
                }`}
              >
                {!item.deletedAt &&
                  QUICK_REACTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => react(item.id, emoji)}
                      title={`Reagir ${emoji}`}
                      className="rounded-full px-1 py-0.5 text-sm transition hover:scale-125 hover:bg-muted"
                    >
                      {emoji}
                    </button>
                  ))}
                {!item.deletedAt && (
                  <button
                    type="button"
                    onClick={() => {
                      setReplyTo(item);
                      setMode('reply');
                      inputRef.current?.focus();
                    }}
                    title="Responder"
                    className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Reply className="h-3.5 w-3.5" />
                  </button>
                )}
                {!item.deletedAt &&
                  item.type !== 'STICKER' &&
                  item.type !== 'LOCATION' &&
                  item.type !== 'CONTACT' && (
                    <button
                      type="button"
                      onClick={() => setForwardingMessageId(item.id)}
                      title="Encaminhar"
                      className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Forward className="h-3.5 w-3.5" />
                    </button>
                  )}
                {item.direction === 'OUTBOUND' &&
                  item.type === 'TEXT' &&
                  !item.deletedAt &&
                  item.status !== 'FAILED' && (
                    <button
                      type="button"
                      onClick={() => startEdit(item)}
                      title="Editar (até 15min)"
                      className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                {item.direction === 'OUTBOUND' &&
                  !item.deletedAt &&
                  item.status !== 'FAILED' && (
                    <button
                      type="button"
                      onClick={() => revokeMessage(item)}
                      title="Apagar pra todos (até 7min)"
                      className="rounded-full p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
              </div>
              <div
                className={`max-w-[70%] rounded-lg px-3 py-2 text-sm ${
                  item.direction === 'OUTBOUND'
                    ? 'bg-primary text-primary-foreground order-2'
                    : 'bg-muted text-foreground order-1'
                }`}
              >
                {item.type === 'IMAGE' && item.mediaUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <a href={item.mediaUrl} target="_blank" rel="noreferrer" className="block">
                    <img
                      src={item.thumbnailUrl ?? item.mediaUrl}
                      alt="imagem"
                      className="mb-1 max-h-64 rounded-md cursor-zoom-in hover:opacity-90"
                      loading="lazy"
                    />
                  </a>
                )}
                {item.type === 'AUDIO' && item.mediaUrl && (
                  <div className="mb-1 space-y-1">
                    <audio controls src={item.mediaUrl} className="w-full" />
                    {item.transcriptionStatus === 'PENDING' && (
                      <p className="flex items-center gap-1 text-[10px] italic opacity-70">
                        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                        Transcrevendo…
                      </p>
                    )}
                    {item.transcriptionStatus === 'FAILED' && (
                      <p className="text-[10px] italic opacity-60">Transcrição falhou</p>
                    )}
                    {item.transcriptionStatus === 'COMPLETED' && item.transcription && (
                      <button
                        type="button"
                        onClick={() =>
                          setShowTranscription((s) => ({ ...s, [item.id]: !s[item.id] }))
                        }
                        className={`flex items-center gap-1 rounded text-[10px] opacity-80 hover:opacity-100 ${
                          item.direction === 'OUTBOUND' ? 'text-primary-foreground' : 'text-foreground'
                        }`}
                      >
                        <FileText className="h-3 w-3" />
                        {showTranscription[item.id] ? 'Ocultar transcrição' : 'Ver transcrição'}
                      </button>
                    )}
                    {item.transcriptionStatus === 'COMPLETED' &&
                      item.transcription &&
                      showTranscription[item.id] && (
                        <p
                          className={`whitespace-pre-wrap break-words rounded-md px-2 py-1.5 text-xs italic ${
                            item.direction === 'OUTBOUND'
                              ? 'bg-primary-foreground/10'
                              : 'bg-background/60'
                          }`}
                        >
                          {item.transcription}
                        </p>
                      )}
                  </div>
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
                {item.type === 'STICKER' && item.mediaUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.mediaUrl}
                    alt="sticker"
                    className="mb-1 max-h-32 max-w-[150px]"
                    loading="lazy"
                  />
                )}
                {item.type === 'LOCATION' &&
                  item.locationLat !== null &&
                  item.locationLon !== null && (
                    <a
                      href={`https://www.google.com/maps/search/?api=1&query=${item.locationLat},${item.locationLon}`}
                      target="_blank"
                      rel="noreferrer"
                      className={`mb-1 flex items-start gap-2 rounded-md p-2 transition hover:bg-foreground/5 ${
                        item.direction === 'OUTBOUND'
                          ? 'bg-primary-foreground/10'
                          : 'bg-background/60'
                      }`}
                    >
                      <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
                      <div className="min-w-0">
                        {item.locationName && (
                          <p className="truncate font-medium">{item.locationName}</p>
                        )}
                        {item.locationAddress && (
                          <p className="truncate text-xs opacity-80">{item.locationAddress}</p>
                        )}
                        <p className="mt-0.5 text-[10px] opacity-70">
                          Abrir no Google Maps · {item.locationLat.toFixed(5)},{' '}
                          {item.locationLon.toFixed(5)}
                        </p>
                      </div>
                    </a>
                  )}
                {item.forwardedFromId && !item.deletedAt && (
                  <p className="mb-1 flex items-center gap-1 text-[10px] italic opacity-60">
                    <Forward className="h-2.5 w-2.5" />
                    Encaminhada
                  </p>
                )}
                {item.deletedAt ? (
                  <p className="flex items-center gap-1.5 italic opacity-60">
                    <Ban className="h-3 w-3" />
                    Esta mensagem foi apagada
                  </p>
                ) : editingMessageId === item.id ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      submitEdit();
                    }}
                    className="flex flex-col gap-1.5"
                  >
                    <textarea
                      autoFocus
                      value={editingText}
                      onChange={(e) => setEditingText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          cancelEdit();
                        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          submitEdit();
                        }
                      }}
                      rows={Math.min(6, Math.max(2, editingText.split('\n').length))}
                      className={`w-full resize-none rounded border bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring`}
                    />
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={cancelEdit}
                        disabled={editingBusy}
                        className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                      >
                        Cancelar
                      </button>
                      <button
                        type="submit"
                        disabled={editingBusy || !editingText.trim()}
                        className="flex items-center gap-1 rounded bg-foreground px-2 py-0.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50"
                      >
                        <Check className="h-3 w-3" />
                        {editingBusy ? 'Salvando…' : 'Salvar'}
                      </button>
                    </div>
                  </form>
                ) : (
                  item.content && (
                    <p className="whitespace-pre-wrap break-words">{item.content}</p>
                  )
                )}
                <p className="mt-1 text-[10px] opacity-70">
                  {new Date(item.createdAt).toLocaleTimeString('pt-BR', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}{' '}
                  {item.editedAt && !item.deletedAt && (
                    <span className="italic">(editada)</span>
                  )}{' '}
                  {item.direction === 'OUTBOUND' && !item.deletedAt && STATUS_ICON[item.status]}
                </p>
                {item.reactions && item.reactions.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {item.reactions.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => r.fromMe && react(item.id, '')}
                        title={r.fromMe ? 'Clique pra remover' : 'Reagiu'}
                        className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0 text-xs ${
                          r.fromMe ? 'border-foreground/20 bg-background/40' : 'bg-background/40'
                        } ${item.direction === 'OUTBOUND' ? 'border-primary-foreground/20' : ''}`}
                      >
                        <span>{r.emoji}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ),
        )}
      </div>

      <div className="border-t pt-3 space-y-2">
        {partnerTyping && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="flex items-end gap-0.5">
              <span
                className="h-1.5 w-1.5 animate-bounce rounded-full bg-current"
                style={{ animationDelay: '0ms' }}
              />
              <span
                className="h-1.5 w-1.5 animate-bounce rounded-full bg-current"
                style={{ animationDelay: '150ms' }}
              />
              <span
                className="h-1.5 w-1.5 animate-bounce rounded-full bg-current"
                style={{ animationDelay: '300ms' }}
              />
            </span>
            <span className="italic">
              {conv.contact.name ?? conv.contact.phoneNumber} está digitando…
            </span>
          </div>
        )}
        {conv.inbox.status !== 'CONNECTED' && mode === 'reply' && (
          <p className="text-xs text-amber-600">
            Inbox não conectada — conecte em /inboxes antes de responder.
          </p>
        )}

        {/* Reply preview */}
        {replyTo && mode === 'reply' && (
          <div className="flex items-start gap-2 rounded-md border-l-2 border-primary bg-muted/40 px-2 py-1.5">
            <CornerDownRight className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Respondendo {replyTo.direction === 'OUTBOUND' ? 'você' : conv.contact.name ?? 'contato'}
              </p>
              <p className="line-clamp-2 text-xs text-muted-foreground">
                {replyTo.content ?? `[${replyTo.type}]`}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setReplyTo(null)}
              className="rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
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
            <>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setShowTemplates((v) => !v)}
                title="Templates de resposta"
              >
                <FileText className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => fileInputRef.current?.click()}
                disabled={conv.inbox.status !== 'CONNECTED'}
                title="Anexar arquivo"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,video/*,audio/*,application/pdf,application/zip"
                className="hidden"
                onChange={(e) => {
                  const files = e.target.files;
                  if (files && files.length > 0) handleFiles(files);
                  e.target.value = '';
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setScheduleOpen(true)}
                title="Agendar mensagem"
              >
                <CalendarClock className="h-4 w-4" />
              </Button>
              {!recording ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={startRecording}
                  disabled={conv.inbox.status !== 'CONNECTED'}
                  title="Gravar áudio"
                >
                  <Mic className="h-4 w-4" />
                </Button>
              ) : (
                <div className="ml-1 flex items-center gap-1 rounded-md border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:border-red-700 dark:text-red-200">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
                  <span className="font-mono">
                    {Math.floor(recordingMs / 1000)}.{String(Math.floor((recordingMs % 1000) / 100))}s
                  </span>
                  <button
                    type="button"
                    onClick={() => stopRecording(false)}
                    title="Cancelar"
                    className="ml-1 rounded p-0.5 hover:bg-red-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => stopRecording(true)}
                    title="Enviar áudio"
                    className="rounded p-0.5 hover:bg-red-100"
                  >
                    <Square className="h-3 w-3 fill-current" />
                  </button>
                </div>
              )}
            </>
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
            onChange={(e) => onComposerChange(e.target.value)}
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

      <ScheduleMessageDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        conversationId={conv.id}
        initialText={text}
        onScheduled={() => {
          setText('');
          setScheduleOpen(false);
        }}
      />

      <ForwardMessageDialog
        open={!!forwardingMessageId}
        onOpenChange={(v) => {
          if (!v) setForwardingMessageId(null);
        }}
        messageId={forwardingMessageId}
        excludeConversationId={conv.id}
      />
    </div>
  );
}
