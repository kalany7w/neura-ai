'use client';

import { use, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Ban,
  BookOpen,
  CalendarClock,
  Check,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Clock,
  CornerDownRight,
  FileText,
  Forward,
  History,
  Mail,
  MapPin,
  Mic,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  MessageSquare,
  PauseCircle,
  PlayCircle,
  Reply,
  Send,
  Sparkles,
  Square,
  StickyNote,
  Trash2,
  UserCheck,
  UserX,
  Wand2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { format, isToday, isYesterday } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { renderTemplate } from '@neura/shared/template-render';
import { api, ApiError } from '@/lib/api';
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
import { KbSearchDialog } from '@/components/kb-search-dialog';
import type { MentionTarget } from '@/components/ui/mention-textarea';
import { renderMentions } from '@/lib/render-mentions';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

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

interface ReplyToRef {
  id: string;
  content: string | null;
  type: string;
  direction: 'INBOUND' | 'OUTBOUND';
  deletedAt: string | null;
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
  pinnedAt: string | null;
  pinnedBy: string | null;
  replyToId: string | null;
  replyTo: ReplyToRef | null;
  sentAt: string | null;
  createdAt: string;
  reactions: ReactionItem[];
  senderType?: 'CUSTOMER' | 'AGENT' | 'AI_AGENT' | 'SYSTEM';
}

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

interface AiClassification {
  intent: 'sale' | 'support' | 'complaint' | 'info' | 'other';
  urgency: 'low' | 'medium' | 'high' | 'critical';
  sentiment: 'positive' | 'neutral' | 'negative';
  confidence: number;
  topics?: string[];
  classifiedAt?: string;
}

type AiSuggestedAction =
  | { kind: 'assign_agent'; agentSlug: string; reason: string; confidence: number }
  | { kind: 'apply_label'; labelName: string; reason: string; confidence: number }
  | {
      kind: 'set_status';
      status: 'OPEN' | 'PENDING' | 'RESOLVED' | 'SNOOZED';
      reason: string;
      confidence: number;
    }
  | { kind: 'send_template'; templateName: string; reason: string; confidence: number }
  | { kind: 'move_card_stage'; stageName: string; reason: string; confidence: number };

const AI_INTENT_LABEL: Record<AiClassification['intent'], string> = {
  sale: 'Venda',
  support: 'Suporte',
  complaint: 'Reclamação',
  info: 'Info',
  other: 'Outro',
};

const AI_INTENT_CLS: Record<AiClassification['intent'], string> = {
  sale: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  support: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  complaint: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300',
  info: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  other: 'bg-muted text-muted-foreground',
};

const AI_URGENCY_LABEL: Record<AiClassification['urgency'], string> = {
  low: 'Baixa',
  medium: 'Média',
  high: 'Alta',
  critical: 'Crítica',
};

const AI_URGENCY_CLS: Record<AiClassification['urgency'], string> = {
  low: 'bg-muted text-muted-foreground',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  high: 'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300',
  critical:
    'bg-red-500 text-white dark:bg-red-600 animate-pulse',
};

const AI_SENTIMENT_EMOJI: Record<AiClassification['sentiment'], string> = {
  positive: '😊',
  neutral: '😐',
  negative: '😠',
};

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
  pinnedAt: string | null;
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
  aiClassification?: AiClassification | null;
  aiSummary?: string | null;
  aiSummaryAt?: string | null;
  aiSuggestedActions?: AiSuggestedAction[] | null;
  aiSuggestedAt?: string | null;
  aiKbSuggestion?: {
    articleId: string;
    articleTitle: string;
    score: number;
    suggestedAt: string;
  } | null;
  aiKbSuggestionAt?: string | null;
  aiKbSuggestionAccepted?: boolean;
}

const STATUS_ICON: Record<MessageItem['status'], string> = {
  PENDING: '⏳',
  SENT: '✓',
  DELIVERED: '✓✓',
  READ: '✓✓',
  FAILED: '⚠',
};

function applyTemplate(body: string, contact: ConversationDetail['contact']): string {
  return renderTemplate(body, {
    contact: { name: contact.name, phoneNumber: contact.phoneNumber },
  });
}

function dayLabel(d: Date): string {
  if (isToday(d)) return 'Hoje';
  if (isYesterday(d)) return 'Ontem';
  return format(d, "EEEE, dd 'de' MMMM", { locale: ptBR });
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
  // Forward (single)
  const [forwardingMessageId, setForwardingMessageId] = useState<string | null>(null);
  // Knowledge base search
  const [kbSearchOpen, setKbSearchOpen] = useState(false);
  // KB auto-suggest
  const [kbSuggestRefreshing, setKbSuggestRefreshing] = useState(false);
  const [kbSuggestInserting, setKbSuggestInserting] = useState(false);
  // Multi-select pra forward batch
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const [batchForwardOpen, setBatchForwardOpen] = useState(false);
  // Histórico de edições — id da msg cujo histórico mostrar
  const [historyMessageId, setHistoryMessageId] = useState<string | null>(null);
  // IA Copilot
  const [summarizing, setSummarizing] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [suggestingActions, setSuggestingActions] = useState(false);
  const [aiActions, setAiActions] = useState<AiSuggestedAction[] | null>(null);
  const [executingActionIdx, setExecutingActionIdx] = useState<number | null>(null);
  // Macros
  const [executingMacroId, setExecutingMacroId] = useState<string | null>(null);
  // Sugestões de resposta com IA
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  // Marker "Novas mensagens": ts da última msg lida ao abrir a conversa
  const [readUpToTs, setReadUpToTs] = useState<number | null>(null);
  // Botão scroll-to-bottom: aparece quando estamos > 200px do fim
  const [showScrollDown, setShowScrollDown] = useState(false);

  function checkScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollDown(distFromBottom > 200);
  }

  function scrollToBottom() {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }

  async function fetchSuggestions() {
    if (suggesting) return;
    setSuggesting(true);
    setSuggestions([]);
    try {
      const res = await api<{ suggestions: string[]; model?: string; elapsedMs?: number }>(
        `/api/conversations/${id}/suggest-replies`,
        {
          method: 'POST',
          body: JSON.stringify({ count: 3 }),
        },
      );
      if (res.suggestions.length === 0) {
        toast.error('Nenhuma sugestão retornada');
      } else {
        setSuggestions(res.suggestions);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ai_disabled') {
        toast.error('IA desativada — configure OPENAI_API_KEY no Coolify');
      } else if (err instanceof ApiError && err.code === 'no_inbound') {
        toast.error('Sem mensagem do cliente pra responder');
      } else if (err instanceof ApiError && err.code === 'empty_conversation') {
        toast.error('Conversa vazia');
      } else {
        toast.error(err instanceof Error ? err.message : 'Erro ao gerar sugestões');
      }
    } finally {
      setSuggesting(false);
    }
  }

  function applySuggestion(suggestion: string) {
    setText(suggestion);
    setSuggestions([]);
    inputRef.current?.focus();
  }
  // Pinned bar
  const [pinnedExpanded, setPinnedExpanded] = useState(false);

  function isForwardableType(type: string): boolean {
    return type !== 'STICKER' && type !== 'LOCATION' && type !== 'CONTACT' && type !== 'SYSTEM';
  }

  function toggleSelectMessage(messageId: string) {
    setSelectedMessageIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else if (next.size < 20) next.add(messageId);
      else toast.error('Máximo 20 mensagens por encaminhamento');
      return next;
    });
  }

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedMessageIds(new Set());
  }

  function enterSelectionMode() {
    setSelectionMode(true);
    setSelectedMessageIds(new Set());
  }

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

  const { data: mentionsData } = useQuery<{ targets: MentionTarget[] }>({
    queryKey: ['mention-targets'],
    queryFn: () => api('/api/workspaces/me/mention-targets'),
    staleTime: 60_000,
  });
  const mentionSlugs = useMemo(
    () => new Set((mentionsData?.targets ?? []).map((t) => t.slug.toLowerCase())),
    [mentionsData?.targets],
  );

  const { data: templatesData } = useQuery<{ templates: TemplateItem[] }>({
    queryKey: ['templates'],
    queryFn: () => api('/api/templates'),
    // Recarrega quando volta pra aba — pra pegar pin/unpin feito em /settings/templates
    refetchOnWindowFocus: 'always',
  });
  const pinnedTemplates = useMemo(
    () =>
      (templatesData?.templates ?? [])
        .filter((t) => !!t.pinnedAt)
        .sort((a, b) => (b.pinnedAt ?? '').localeCompare(a.pinnedAt ?? ''))
        .slice(0, 3),
    [templatesData?.templates],
  );

  const { data: wsData } = useQuery<{ workspace: { members: Member[] } }>({
    queryKey: ['workspace-me'],
    queryFn: () => api('/api/workspaces/me'),
  });
  const members = wsData?.workspace.members ?? [];

  const { data: labelsData } = useQuery<{
    labels: Array<{ id: string; name: string; color: string }>;
  }>({
    queryKey: ['labels'],
    queryFn: () => api('/api/labels'),
    staleTime: 60_000,
  });

  const { data: macrosData } = useQuery<{
    macros: Array<{ id: string; name: string; description: string | null }>;
  }>({
    queryKey: ['macros'],
    queryFn: () => api('/api/automations/macros'),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!data?.conversation) return;
    if (data.conversation.unreadCount > 0) {
      api(`/api/conversations/${id}/read`, { method: 'POST' }).catch(() => {});
    }
  }, [data?.conversation?.id, data?.conversation?.unreadCount, id]);

  // Sincroniza state local de IA Copilot com snapshot do server
  useEffect(() => {
    if (!data?.conversation) return;
    setSummary(data.conversation.aiSummary ?? null);
    setAiActions(data.conversation.aiSuggestedActions ?? null);
  }, [
    data?.conversation?.id,
    data?.conversation?.aiSummary,
    data?.conversation?.aiSummaryAt,
    data?.conversation?.aiSuggestedAt,
  ]);

  // Marca a última msg INBOUND existente como "lido até aqui" no primeiro render desta conversa
  useEffect(() => {
    if (!data?.conversation.messages) return;
    const lastInbound = [...data.conversation.messages]
      .reverse()
      .find((m) => m.direction === 'INBOUND');
    if (lastInbound && readUpToTs === null) {
      setReadUpToTs(new Date(lastInbound.createdAt).getTime());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.conversation.id]);

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
    if (event.event === 'conversation.classified') {
      qc.invalidateQueries({ queryKey: ['conversation', id] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    }
    if (
      event.event === 'conversation.kb_suggested' ||
      event.event === 'conversation.kb_suggestion_accepted' ||
      event.event === 'conversation.kb_suggestion_dismissed'
    ) {
      qc.invalidateQueries({ queryKey: ['conversation', id] });
    }
    if (event.event === 'message.pinned' || event.event === 'message.unpinned') {
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

  // ============================
  // IA Copilot — handlers
  // ============================
  async function summarizeAi() {
    if (summarizing) return;
    setSummarizing(true);
    try {
      const res = await api<{ summary: string }>(
        `/api/conversations/${id}/ai/summarize`,
        { method: 'POST' },
      );
      setSummary(res.summary);
    } catch (err) {
      const msg =
        err instanceof ApiError && err.code === 'ai_disabled'
          ? 'Configure OPENAI_API_KEY pra ativar IA'
          : err instanceof Error
            ? err.message
            : 'Erro ao gerar resumo';
      toast.error(msg);
    } finally {
      setSummarizing(false);
    }
  }

  async function suggestNextAi() {
    if (suggestingActions) return;
    setSuggestingActions(true);
    try {
      const res = await api<{ actions: AiSuggestedAction[] }>(
        `/api/conversations/${id}/ai/next-actions`,
        { method: 'POST' },
      );
      setAiActions(res.actions);
      if (res.actions.length === 0) toast.info('IA não encontrou ações claras pra sugerir agora.');
    } catch (err) {
      const msg =
        err instanceof ApiError && err.code === 'ai_disabled'
          ? 'Configure OPENAI_API_KEY pra ativar IA'
          : err instanceof Error
            ? err.message
            : 'Erro ao sugerir ações';
      toast.error(msg);
    } finally {
      setSuggestingActions(false);
    }
  }

  async function executeAiAction(action: AiSuggestedAction, idx: number) {
    setExecutingActionIdx(idx);
    try {
      if (action.kind === 'set_status') {
        await updateConversation({ status: action.status });
      } else if (action.kind === 'assign_agent') {
        // Resolve userId a partir do slug via /api/workspaces/me/mention-targets
        const targets = await api<{ targets: Array<{ userId: string; slug: string }> }>(
          '/api/workspaces/me/mention-targets',
        );
        const found = targets.targets.find((t) => t.slug === action.agentSlug);
        if (!found) {
          toast.error('Agente sugerido não encontrado');
          return;
        }
        await updateConversation({ assignedAgentId: found.userId });
      } else if (action.kind === 'apply_label') {
        const label = (labelsData?.labels ?? []).find(
          (l) => l.name.toLowerCase() === action.labelName.toLowerCase(),
        );
        if (!label) {
          toast.error('Etiqueta sugerida não encontrada');
          return;
        }
        await api('/api/labels/apply', {
          method: 'POST',
          body: JSON.stringify({
            labelId: label.id,
            targetType: 'CONVERSATION',
            targetId: id,
          }),
        });
        toast.success(`Etiqueta "${label.name}" aplicada`);
        await qc.invalidateQueries({ queryKey: ['conversation', id] });
      } else if (action.kind === 'send_template') {
        const tpl = (templatesData?.templates ?? []).find(
          (t) => t.name.toLowerCase() === action.templateName.toLowerCase(),
        );
        if (!tpl) {
          toast.error('Template sugerido não encontrado');
          return;
        }
        pickTemplate(tpl);
        toast.success('Template aplicado no composer — edite e envie');
      } else if (action.kind === 'move_card_stage') {
        toast.info('Mover card no kanban — abra o card pra confirmar');
      }
      // Remove ação executada da lista
      setAiActions((prev) => (prev ?? []).filter((_, i) => i !== idx));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao executar ação');
    } finally {
      setExecutingActionIdx(null);
    }
  }

  function dismissAiAction(idx: number) {
    setAiActions((prev) => (prev ?? []).filter((_, i) => i !== idx));
  }

  async function insertKbSuggestion() {
    const sug = conv?.aiKbSuggestion;
    if (!sug || kbSuggestInserting) return;
    setKbSuggestInserting(true);
    try {
      // Carrega body do artigo + cola no composer.
      const res = await api<{ article: { id: string; title: string; body: string } }>(
        `/api/kb/articles/${sug.articleId}`,
      );
      setText((prev) => (prev.trim() ? `${prev}\n\n${res.article.body}` : res.article.body));
      // Marca métrica de aceito + invalida pra esconder o card.
      await api(`/api/conversations/${id}/ai/kb-suggest/accept`, { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['conversation', id] });
      toast.success(`"${res.article.title}" inserido no composer`);
      // Incrementa view counter em background.
      api(`/api/kb/articles/${sug.articleId}/view`, { method: 'POST' }).catch(() => {});
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao inserir artigo');
    } finally {
      setKbSuggestInserting(false);
    }
  }

  async function dismissKbSuggestion() {
    try {
      await api(`/api/conversations/${id}/ai/kb-suggest/dismiss`, { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['conversation', id] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function refreshKbSuggestion() {
    if (kbSuggestRefreshing) return;
    setKbSuggestRefreshing(true);
    try {
      await api(`/api/conversations/${id}/ai/kb-suggest`, { method: 'POST' });
      toast.success('Busca em fila — atualiza em alguns segundos');
    } catch (err) {
      const msg =
        err instanceof ApiError && err.code === 'ai_disabled'
          ? 'Configure OPENAI_API_KEY pra ativar IA'
          : err instanceof Error
            ? err.message
            : 'Erro';
      toast.error(msg);
    } finally {
      setKbSuggestRefreshing(false);
    }
  }

  async function executeMacroOnConv(macroId: string, macroName: string) {
    if (executingMacroId) return;
    setExecutingMacroId(macroId);
    try {
      const res = await api<{
        status: 'MATCHED' | 'PARTIAL' | 'FAILED' | 'NOT_FOUND';
        errorMessage?: string;
      }>(`/api/automations/macros/${macroId}/execute`, {
        method: 'POST',
        body: JSON.stringify({ conversationId: id }),
      });
      if (res.status === 'MATCHED') {
        toast.success(`Macro "${macroName}" executada`);
      } else if (res.status === 'PARTIAL') {
        toast.warning(`Macro "${macroName}" rodou parcialmente`);
      } else if (res.status === 'FAILED') {
        toast.error(`Macro "${macroName}" falhou: ${res.errorMessage ?? 'erro'}`);
      }
      await qc.invalidateQueries({ queryKey: ['conversation', id] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao executar macro');
    } finally {
      setExecutingMacroId(null);
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
  async function pinMessage(msg: MessageItem) {
    try {
      await api(`/api/messages/${msg.id}/pin`, { method: 'POST' });
      toast.success('Mensagem fixada');
      await qc.invalidateQueries({ queryKey: ['conversation', id] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }
  async function unpinMessage(msg: MessageItem) {
    try {
      await api(`/api/messages/${msg.id}/unpin`, { method: 'POST' });
      toast.success('Mensagem desafixada');
      await qc.invalidateQueries({ queryKey: ['conversation', id] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
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
      <div className="relative flex min-w-0 flex-1 flex-col">
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

          {/* Macros: dropdown só aparece se workspace tem macros enabled */}
          {macrosData && macrosData.macros.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-md border border-indigo-300 bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700 transition hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300 dark:hover:bg-indigo-900/40"
                  title="Executar macro nessa conversa"
                  disabled={executingMacroId !== null}
                >
                  <Wand2 className="h-3.5 w-3.5" />
                  {executingMacroId ? 'Executando…' : 'Macros'}
                  <ChevronDown className="h-3 w-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64 max-h-72 overflow-y-auto">
                <DropdownMenuLabel>Macros disponíveis</DropdownMenuLabel>
                {macrosData.macros.map((m) => (
                  <DropdownMenuItem
                    key={m.id}
                    onSelect={() => executeMacroOnConv(m.id, m.name)}
                  >
                    <Wand2 className="h-3.5 w-3.5 text-indigo-500" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{m.name}</p>
                      {m.description && (
                        <p className="truncate text-[10px] text-muted-foreground">
                          {m.description}
                        </p>
                      )}
                    </div>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

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
              <DropdownMenuItem onSelect={enterSelectionMode}>
                <CheckSquare className="h-3.5 w-3.5" />
                Selecionar mensagens
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

      {selectionMode && (
        <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-2 border-b bg-indigo-500/95 px-3 py-2 text-indigo-50 shadow-sm">
          <div className="flex items-center gap-2 text-sm">
            <CheckSquare className="h-4 w-4" />
            <span className="font-medium">
              {selectedMessageIds.size === 0
                ? 'Selecionar mensagens — clique nas mensagens'
                : `${selectedMessageIds.size} selecionada${selectedMessageIds.size > 1 ? 's' : ''}`}
            </span>
            <span className="text-[11px] opacity-80">máx 20</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setBatchForwardOpen(true)}
              disabled={selectedMessageIds.size === 0}
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-900 transition hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Forward className="h-3.5 w-3.5" />
              Encaminhar
            </button>
            <button
              type="button"
              onClick={exitSelectionMode}
              className="inline-flex items-center gap-1.5 rounded-md border border-indigo-200/40 px-2.5 py-1 text-xs font-medium hover:bg-indigo-400"
            >
              <X className="h-3.5 w-3.5" />
              Cancelar
            </button>
          </div>
        </div>
      )}

      {(() => {
        const pinned = (data?.conversation.messages ?? []).filter((m) => m.pinnedAt);
        if (pinned.length === 0) return null;
        return (
          <div className="sticky top-0 z-10 border-b bg-amber-50/80 backdrop-blur dark:bg-amber-950/40">
            <button
              type="button"
              onClick={() => setPinnedExpanded((v) => !v)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] text-amber-900 dark:text-amber-200"
            >
              <Pin className="h-3 w-3" />
              <span className="font-medium">
                {pinned.length} mensagem{pinned.length > 1 ? 's' : ''} fixada{pinned.length > 1 ? 's' : ''}
              </span>
              {pinnedExpanded ? (
                <ChevronUp className="ml-auto h-3 w-3" />
              ) : (
                <ChevronDown className="ml-auto h-3 w-3" />
              )}
            </button>
            {pinnedExpanded && (
              <ul className="divide-y divide-amber-200 dark:divide-amber-800 max-h-40 overflow-y-auto">
                {pinned.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-start gap-2 px-3 py-1.5 text-[11px]"
                  >
                    <span className="mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-semibold opacity-70">
                        {m.direction === 'OUTBOUND'
                          ? 'Você'
                          : conv.contact.name ?? conv.contact.phoneNumber}
                        :
                      </span>{' '}
                      {m.content ?? `[${m.type.toLowerCase()}]`}
                    </span>
                    <button
                      type="button"
                      onClick={() => unpinMessage(m)}
                      title="Desafixar"
                      className="shrink-0 rounded p-0.5 hover:bg-amber-200 dark:hover:bg-amber-900"
                    >
                      <PinOff className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })()}

      {/* IA Copilot bar — classify + summarize + next-actions */}
      <div className="mt-3 space-y-2 rounded-lg border border-indigo-200 bg-indigo-50/50 px-3 py-2 dark:border-indigo-900/50 dark:bg-indigo-950/20">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-indigo-700 dark:text-indigo-300">
            <Sparkles className="h-3 w-3" />
            IA Copilot
          </div>
          {conv.aiClassification ? (
            <>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${AI_INTENT_CLS[conv.aiClassification.intent]}`}
                title={`Confiança ${Math.round(conv.aiClassification.confidence * 100)}%`}
              >
                {AI_INTENT_LABEL[conv.aiClassification.intent]}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${AI_URGENCY_CLS[conv.aiClassification.urgency]}`}
              >
                Urgência: {AI_URGENCY_LABEL[conv.aiClassification.urgency]}
              </span>
              <span
                className="text-base leading-none"
                title={`Sentimento: ${conv.aiClassification.sentiment}`}
              >
                {AI_SENTIMENT_EMOJI[conv.aiClassification.sentiment]}
              </span>
              {(conv.aiClassification.topics ?? []).slice(0, 3).map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-card/70 px-2 py-0.5 text-[10px] text-muted-foreground border"
                >
                  #{t}
                </span>
              ))}
            </>
          ) : (
            <span className="text-[11px] text-muted-foreground italic">
              Sem análise ainda — classificação automática roda 30s após nova mensagem
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={summarizeAi}
              disabled={summarizing}
              className="h-7 text-xs"
              title="Resumir conversa em 1-2 frases"
            >
              <Sparkles className={`h-3 w-3 ${summarizing ? 'animate-pulse' : ''}`} />
              {summarizing ? 'Resumindo…' : summary ? 'Refazer resumo' : 'Resumir'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={suggestNextAi}
              disabled={suggestingActions}
              className="h-7 text-xs"
              title="Sugerir próximas ações com IA"
            >
              <Sparkles className={`h-3 w-3 ${suggestingActions ? 'animate-pulse' : ''}`} />
              {suggestingActions ? 'Pensando…' : 'Sugerir ações'}
            </Button>
          </div>
        </div>
        {summary && (
          <p className="rounded-md bg-card/60 p-2 text-xs leading-relaxed text-foreground/90 border">
            <span className="font-semibold">Resumo: </span>
            {summary}
          </p>
        )}
        {conv.aiKbSuggestion && !conv.aiKbSuggestionAccepted && (
          <div className="flex items-start gap-2 rounded-md border-2 border-indigo-300 bg-indigo-50/60 p-2.5 dark:border-indigo-700 dark:bg-indigo-950/40">
            <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600 dark:text-indigo-400" />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-700 dark:text-indigo-300">
                Base de conhecimento sugere
                <span className="rounded bg-indigo-500/15 px-1.5 py-0 normal-case text-[10px]">
                  {Math.round(conv.aiKbSuggestion.score * 100)}% match
                </span>
              </p>
              <p className="mt-0.5 text-sm font-medium">{conv.aiKbSuggestion.articleTitle}</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  onClick={insertKbSuggestion}
                  disabled={kbSuggestInserting}
                  className="h-6 text-[11px]"
                >
                  {kbSuggestInserting ? '…' : 'Inserir resposta'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={refreshKbSuggestion}
                  disabled={kbSuggestRefreshing}
                  className="h-6 text-[11px]"
                  title="Buscar de novo"
                >
                  {kbSuggestRefreshing ? '…' : 'Refazer'}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={dismissKbSuggestion}
                  className="h-6 w-6"
                  title="Dispensar sugestão"
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            </div>
          </div>
        )}
        {aiActions && aiActions.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-700 dark:text-indigo-300">
              Próximas ações sugeridas
            </p>
            {aiActions.map((a, idx) => {
              const isExecuting = executingActionIdx === idx;
              const label =
                a.kind === 'assign_agent'
                  ? `Atribuir pra @${a.agentSlug}`
                  : a.kind === 'apply_label'
                    ? `Aplicar etiqueta "${a.labelName}"`
                    : a.kind === 'set_status'
                      ? `Mudar status pra ${a.status}`
                      : a.kind === 'send_template'
                        ? `Usar template "${a.templateName}"`
                        : `Mover card pra "${a.stageName}"`;
              return (
                <div
                  key={idx}
                  className="flex items-start gap-2 rounded-md border bg-card/80 p-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium">{label}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{a.reason}</p>
                    <p className="mt-0.5 text-[10px] text-indigo-600 dark:text-indigo-400">
                      Confiança {Math.round(a.confidence * 100)}%
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
                      variant="default"
                      onClick={() => executeAiAction(a, idx)}
                      disabled={isExecuting}
                      className="h-6 text-[11px]"
                    >
                      {isExecuting ? '…' : 'Aceitar'}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => dismissAiAction(idx)}
                      className="h-6 w-6"
                      title="Dispensar"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div ref={scrollRef} onScroll={checkScroll} className="flex-1 overflow-y-auto py-4 space-y-3">
        {(() => {
          let lastDay: string | null = null;
          let markerShown = false;
          return timeline.map((item) => {
            const itemDate = new Date(item.createdAt);
            const dayKey = format(itemDate, 'yyyy-MM-dd');
            const showSeparator = dayKey !== lastDay;
            lastDay = dayKey;
            const showReadMarker =
              readUpToTs !== null && !markerShown && itemDate.getTime() > readUpToTs;
            if (showReadMarker) markerShown = true;
            return (
              <div key={item.kind === 'note' ? `note-${item.id}` : item.id}>
                {showSeparator && (
                  <div className="flex items-center justify-center py-3">
                    <span className="rounded-full bg-muted px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      {dayLabel(itemDate)}
                    </span>
                  </div>
                )}
                {showReadMarker && (
                  <div className="flex items-center gap-2 py-2">
                    <div className="h-px flex-1 bg-primary" />
                    <span className="text-[10px] font-medium uppercase tracking-wider text-primary">
                      Novas mensagens
                    </span>
                    <div className="h-px flex-1 bg-primary" />
                  </div>
                )}
                {item.kind === 'note' ? (
            <div className="flex justify-center">
              <div className="group relative max-w-[80%] rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-700">
                <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider opacity-70">
                  <StickyNote className="h-3 w-3" />
                  Nota interna
                </div>
                <p className="whitespace-pre-wrap break-words">
                  {renderMentions(item.body, mentionSlugs)}
                </p>
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
              className={`group flex ${item.direction === 'OUTBOUND' ? 'justify-end' : 'justify-start'} ${
                selectionMode ? 'cursor-pointer' : ''
              } ${
                selectionMode && selectedMessageIds.has(item.id)
                  ? 'rounded-md bg-indigo-100/40 dark:bg-indigo-900/30 -mx-1 px-1'
                  : ''
              }`}
              onClick={
                selectionMode
                  ? (e) => {
                      // Não selecionar se clicar dentro de link/áudio/vídeo (deixa interação normal)
                      const target = e.target as HTMLElement;
                      if (target.closest('a, audio, video, button, input, textarea')) return;
                      if (item.deletedAt) {
                        toast.error('Mensagem apagada não pode ser encaminhada');
                        return;
                      }
                      if (!isForwardableType(item.type)) {
                        toast.error(`Tipo ${item.type} não pode ser encaminhado`);
                        return;
                      }
                      toggleSelectMessage(item.id);
                    }
                  : undefined
              }
            >
              {selectionMode && (
                <div
                  className={`flex shrink-0 items-center px-1 ${
                    item.direction === 'OUTBOUND' ? 'order-3' : 'order-0'
                  }`}
                >
                  {selectedMessageIds.has(item.id) ? (
                    <CheckSquare className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                  ) : (
                    <Square
                      className={`h-4 w-4 ${
                        !item.deletedAt && isForwardableType(item.type)
                          ? 'text-muted-foreground'
                          : 'text-muted-foreground/30'
                      }`}
                    />
                  )}
                </div>
              )}
              <div
                className={`self-center mx-1 flex items-center gap-0.5 rounded-full border bg-card px-1 py-0.5 shadow-sm opacity-0 transition group-hover:opacity-100 ${
                  item.direction === 'OUTBOUND' ? 'order-1' : 'order-2'
                } ${selectionMode ? 'hidden' : ''}`}
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
                {!item.deletedAt && (
                  <button
                    type="button"
                    onClick={() => (item.pinnedAt ? unpinMessage(item) : pinMessage(item))}
                    title={item.pinnedAt ? 'Desafixar' : 'Fixar mensagem'}
                    className={`rounded-full p-1 hover:bg-muted ${
                      item.pinnedAt
                        ? 'text-amber-600'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {item.pinnedAt ? (
                      <PinOff className="h-3.5 w-3.5" />
                    ) : (
                      <Pin className="h-3.5 w-3.5" />
                    )}
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
                {item.editedAt && !item.deletedAt && (
                  <button
                    type="button"
                    onClick={() => setHistoryMessageId(item.id)}
                    title="Ver histórico de edições"
                    className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <History className="h-3.5 w-3.5" />
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
                {item.senderType === 'AI_AGENT' && (
                  <div className="mb-1 inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700">
                    <Sparkles className="h-2.5 w-2.5" />
                    Agente IA
                  </div>
                )}
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
                {item.replyTo && !item.deletedAt && (
                  <div
                    className={`mb-1.5 flex items-start gap-1.5 rounded-md border-l-2 px-2 py-1 text-[11px] ${
                      item.direction === 'OUTBOUND'
                        ? 'border-primary-foreground/40 bg-primary-foreground/10'
                        : 'border-foreground/30 bg-background/60'
                    }`}
                  >
                    <CornerDownRight className="mt-0.5 h-3 w-3 shrink-0 opacity-60" />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold opacity-70">
                        {item.replyTo.direction === 'OUTBOUND'
                          ? 'Você'
                          : conv.contact.name ?? conv.contact.phoneNumber}
                      </p>
                      {item.replyTo.deletedAt ? (
                        <p className="italic opacity-60">Mensagem apagada</p>
                      ) : (
                        <p className="line-clamp-2 opacity-80">
                          {item.replyTo.content ?? `[${item.replyTo.type.toLowerCase()}]`}
                        </p>
                      )}
                    </div>
                  </div>
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
                )}
              </div>
            );
          });
        })()}
      </div>

      {showScrollDown && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-24 right-6 z-10 rounded-full border bg-card p-2 shadow-lg hover:bg-accent"
          aria-label="Ir para última mensagem"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      )}

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

        {/* Top 3 templates fixados — atalho direto sem digitar /shortcut */}
        {mode === 'reply' && pinnedTemplates.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Atalhos
            </span>
            {pinnedTemplates.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                onClick={() => pickTemplate(tpl)}
                title={tpl.body}
                className="inline-flex items-center gap-1 rounded-full border border-indigo-300 bg-indigo-50 px-2.5 py-0.5 text-[11px] font-medium text-indigo-700 transition hover:border-indigo-500 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300 dark:hover:bg-indigo-900/40"
              >
                <Pin className="h-2.5 w-2.5" />
                {tpl.name}
              </button>
            ))}
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

        {suggestions.length > 0 && mode === 'reply' && (
          <div className="mb-2 space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Sparkles className="h-3 w-3 text-indigo-500" />
                Sugestões com IA — clique pra usar
              </span>
              <button
                type="button"
                onClick={() => setSuggestions([])}
                className="rounded p-0.5 hover:bg-muted"
                title="Fechar"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <ul className="space-y-1.5">
              {suggestions.map((s, idx) => (
                <li key={idx}>
                  <button
                    type="button"
                    onClick={() => applySuggestion(s)}
                    className="group w-full rounded-md border border-indigo-200 bg-indigo-50/50 px-3 py-2 text-left text-sm transition hover:border-indigo-400 hover:bg-indigo-100/60 dark:border-indigo-800 dark:bg-indigo-950/30 dark:hover:bg-indigo-900/40"
                  >
                    <span className="mr-2 inline-flex h-4 w-4 items-center justify-center rounded-full bg-indigo-500 text-[10px] font-bold text-white">
                      {idx + 1}
                    </span>
                    <span className="whitespace-pre-wrap break-words">{s}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

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
          {mode === 'reply' && (
            <>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setKbSearchOpen(true)}
                title="Buscar na base de conhecimento"
              >
                <BookOpen className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={fetchSuggestions}
                disabled={suggesting || conv.inbox.status !== 'CONNECTED'}
                title="Sugerir respostas com IA"
                className={suggesting ? 'animate-pulse' : ''}
              >
                <Sparkles className={`h-4 w-4 ${suggesting ? 'text-indigo-500' : ''}`} />
              </Button>
            </>
          )}
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
        <ConversationSidePanel conversationId={conv.id} />
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

      <KbSearchDialog
        open={kbSearchOpen}
        onOpenChange={setKbSearchOpen}
        onInsert={(snippet) => {
          // Insere body do artigo no composer (substitui se vazio, append senão).
          setText((prev) => (prev.trim() ? `${prev}\n\n${snippet}` : snippet));
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
      />

      <ForwardMessageDialog
        open={batchForwardOpen}
        onOpenChange={(v) => setBatchForwardOpen(v)}
        messageIds={Array.from(selectedMessageIds)}
        excludeConversationId={conv.id}
        onForwarded={() => {
          setBatchForwardOpen(false);
          exitSelectionMode();
        }}
      />

      <MessageEditHistoryDialog
        messageId={historyMessageId}
        onClose={() => setHistoryMessageId(null)}
      />
    </div>
  );
}

interface MessageEditAuthor {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
}

interface MessageEditEntry {
  id: string;
  previousContent: string;
  editedAt: string;
  editedBy: string | null;
  author: MessageEditAuthor | null;
}

interface MessageEditHistoryResponse {
  current: { content: string | null; editedAt: string | null; createdAt: string };
  edits: MessageEditEntry[];
}

function MessageEditHistoryDialog({
  messageId,
  onClose,
}: {
  messageId: string | null;
  onClose: () => void;
}) {
  const open = !!messageId;
  const { data, isLoading } = useQuery<MessageEditHistoryResponse>({
    queryKey: ['message-history', messageId],
    queryFn: () => api(`/api/messages/${messageId}/history`),
    enabled: open,
  });

  const totalVersions = (data?.edits.length ?? 0) + 1; // edits + atual

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4 text-indigo-500" />
            Histórico de edições
          </DialogTitle>
          <DialogDescription>
            {isLoading
              ? 'Carregando…'
              : `${totalVersions} versão${totalVersions > 1 ? 'ões' : ''} (a atual e ${data?.edits.length ?? 0} anterior${(data?.edits.length ?? 0) === 1 ? '' : 'es'})`}
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Carregando…</p>
        ) : !data ? (
          <p className="text-sm text-destructive">Erro ao carregar histórico</p>
        ) : (
          <ol className="space-y-3">
            <li className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-700 dark:bg-emerald-950/40">
              <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                <Check className="h-3 w-3" />
                Versão atual
                {data.current.editedAt && (
                  <span className="ml-auto text-[10px] font-normal text-emerald-700/80 dark:text-emerald-300/80">
                    {new Date(data.current.editedAt).toLocaleString('pt-BR')}
                  </span>
                )}
              </div>
              <p className="whitespace-pre-wrap break-words text-sm">
                {data.current.content ?? <span className="italic opacity-70">(vazia)</span>}
              </p>
            </li>
            {data.edits.map((ed, idx) => {
              const authorName =
                ed.author?.name?.trim() || ed.author?.email || 'Agente removido';
              return (
                <li key={ed.id} className="rounded-lg border bg-card p-3">
                  <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Versão anterior #{data.edits.length - idx}
                    <span className="ml-auto font-normal">
                      {new Date(ed.editedAt).toLocaleString('pt-BR')}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                    {ed.previousContent}
                  </p>
                  {ed.editedBy && (
                    <p className="mt-1.5 text-[11px] text-muted-foreground">
                      Editada por <span className="font-medium">{authorName}</span>
                    </p>
                  )}
                </li>
              );
            })}
            {data.edits.length === 0 && (
              <li className="rounded-md border border-dashed bg-muted/20 p-4 text-center text-xs text-muted-foreground">
                Nenhuma versão anterior registrada — primeira edição foi antes desse histórico
                existir.
              </li>
            )}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}
