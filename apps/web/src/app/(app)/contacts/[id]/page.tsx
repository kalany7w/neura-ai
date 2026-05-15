'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Clock,
  Edit3,
  LayoutGrid,
  MessageCircle,
  MessageSquare,
  MessageSquarePlus,
  Mail,
  Phone,
  PlayCircle,
  Send,
  Smile,
  StickyNote,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MentionTextarea, type MentionTarget } from '@/components/ui/mention-textarea';
import { renderMentions } from '@/lib/render-mentions';

interface LabelItem {
  id: string;
  name: string;
  color: string;
}

interface ContactConversation {
  id: string;
  status: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  inbox: { id: string; name: string };
}

interface ContactCard {
  id: string;
  title: string;
  value: string | null;
  funnel: { id: string; name: string };
  stage: { id: string; name: string; color: string; outcome: 'POSITIVE' | 'NEGATIVE' | 'RISK' | null };
}

interface Contact {
  id: string;
  name: string | null;
  phoneNumber: string;
  avatarUrl: string | null;
  customAttrs: Record<string, unknown> | null;
  createdAt: string;
  labels: Array<{ label: LabelItem }>;
  conversations: ContactConversation[];
}

interface ContactDetailResponse {
  contact: Contact;
  cards: ContactCard[];
}

interface Inbox {
  id: string;
  name: string;
  status: string;
}

const OUTCOME_COLOR: Record<'POSITIVE' | 'NEGATIVE' | 'RISK', string> = {
  POSITIVE: '#10b981',
  NEGATIVE: '#ef4444',
  RISK: '#f59e0b',
};

const STATUS_LABELS: Record<string, string> = {
  OPEN: 'Aberta',
  PENDING: 'Pendente',
  RESOLVED: 'Resolvida',
  SNOOZED: 'Adiada',
};

const STATUS_BADGE: Record<string, string> = {
  OPEN: 'bg-blue-100 text-blue-700',
  PENDING: 'bg-amber-100 text-amber-800',
  RESOLVED: 'bg-emerald-100 text-emerald-700',
  SNOOZED: 'bg-slate-200 text-slate-700',
};

function initialsFrom(s: string | null | undefined): string {
  if (!s) return '?';
  return s
    .split(/[\s.@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

function formatBRL(n: number): string {
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}

interface NoteAuthor {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
}

interface ContactNoteItem {
  id: string;
  contactId: string;
  authorId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: NoteAuthor | null;
}

type Tab = 'overview' | 'conversations' | 'cards' | 'notes' | 'journey';

export default function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const router = useRouter();
  const confirm = useConfirm();
  const [tab, setTab] = useState<Tab>('overview');
  const [editOpen, setEditOpen] = useState(false);
  const [startConvOpen, setStartConvOpen] = useState(false);

  const { data, isLoading } = useQuery<ContactDetailResponse>({
    queryKey: ['contact-detail', id],
    queryFn: () => api(`/api/contacts/${id}`),
  });

  const { data: labelsData } = useQuery<{ labels: LabelItem[] }>({
    queryKey: ['labels'],
    queryFn: () => api('/api/labels'),
  });

  const { data: notesData, isLoading: notesLoading } = useQuery<{ notes: ContactNoteItem[] }>({
    queryKey: ['contact-notes', id],
    queryFn: () => api(`/api/contacts/${id}/notes`),
    enabled: tab === 'notes',
  });

  const { data: mentionsData } = useQuery<{ targets: MentionTarget[] }>({
    queryKey: ['mention-targets'],
    queryFn: () => api('/api/workspaces/me/mention-targets'),
    staleTime: 60_000,
    enabled: tab === 'notes',
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['contact-detail', id] });
  const refreshNotes = () => qc.invalidateQueries({ queryKey: ['contact-notes', id] });

  async function applyLabel(labelId: string) {
    try {
      await api('/api/labels/apply', {
        method: 'POST',
        body: JSON.stringify({ labelId, targetType: 'CONTACT', targetId: id }),
      });
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function unapplyLabel(labelId: string) {
    try {
      await api('/api/labels/unapply', {
        method: 'POST',
        body: JSON.stringify({ labelId, targetType: 'CONTACT', targetId: id }),
      });
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function remove() {
    if (!data?.contact) return;
    if (
      !(await confirm({
        title: `Excluir contato "${data.contact.name ?? data.contact.phoneNumber}"?`,
        description: 'Conversas e cards relacionados perdem o vínculo.',
        confirmLabel: 'Excluir',
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/contacts/${id}`, { method: 'DELETE' });
      toast.success('Contato excluído');
      router.push('/contacts');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  if (isLoading) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  if (!data) return <p className="text-sm text-destructive">Contato não encontrado.</p>;

  const { contact, cards } = data;
  const appliedIds = new Set(contact.labels.map((cl) => cl.label.id));
  const availableLabels = (labelsData?.labels ?? []).filter((l) => !appliedIds.has(l.id));

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button asChild size="icon" variant="ghost">
            <Link href="/contacts">
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-slate-200 to-slate-300 text-sm font-semibold text-slate-700 ring-2 ring-card">
            {initialsFrom(contact.name ?? contact.phoneNumber)}
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold">{contact.name ?? 'Sem nome'}</h1>
            <p className="flex items-center gap-1 text-sm text-muted-foreground">
              <Phone className="h-3.5 w-3.5" />
              {contact.phoneNumber}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setStartConvOpen(true)}>
            <MessageSquarePlus className="h-3.5 w-3.5" />
            Iniciar conversa
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
            <Edit3 className="h-3.5 w-3.5" />
            Editar
          </Button>
          <Button size="sm" variant="ghost" onClick={remove} className="text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {(['overview', 'conversations', 'cards', 'notes', 'journey'] as const).map((t) => {
          const notesCount = notesData?.notes.length;
          const labels: Record<Tab, string> = {
            overview: 'Visão geral',
            conversations: `Conversas (${contact.conversations.length})`,
            cards: `Cards (${cards.length})`,
            notes: notesCount === undefined ? 'Notas' : `Notas (${notesCount})`,
            journey: 'Linha do tempo',
          };
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
                tab === t
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {labels[t]}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {tab === 'overview' && (
        <div className="grid gap-5 md:grid-cols-2">
          <section className="rounded-lg border bg-card p-5">
            <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Tag className="h-3.5 w-3.5" />
              Etiquetas
            </h2>
            <div className="flex flex-wrap items-center gap-1.5">
              {contact.labels.map((cl) => (
                <span
                  key={cl.label.id}
                  style={{
                    backgroundColor: cl.label.color + '22',
                    color: cl.label.color,
                    borderColor: cl.label.color + '50',
                  }}
                  className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium"
                >
                  {cl.label.name}
                  <button
                    type="button"
                    onClick={() => unapplyLabel(cl.label.id)}
                    className="rounded-full p-0.5 hover:bg-foreground/10"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
              {availableLabels.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-md border border-dashed bg-background px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      + Adicionar
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                    {availableLabels.map((l) => (
                      <DropdownMenuItem key={l.id} onSelect={() => applyLabel(l.id)}>
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} />
                        {l.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {contact.labels.length === 0 && availableLabels.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Nenhuma etiqueta criada. Crie em Configurações → Etiquetas.
                </p>
              )}
            </div>
          </section>

          <section className="rounded-lg border bg-card p-5">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Atributos customizados
            </h2>
            {contact.customAttrs && Object.keys(contact.customAttrs).length > 0 ? (
              <dl className="space-y-2 text-sm">
                {Object.entries(contact.customAttrs).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 border-b py-1 last:border-0">
                    <dt className="font-medium text-muted-foreground">{k}</dt>
                    <dd className="truncate text-right">
                      {typeof v === 'string' ? v : JSON.stringify(v)}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-xs text-muted-foreground">
                Sem atributos. Edite o contato pra adicionar.
              </p>
            )}
          </section>

          <section className="rounded-lg border bg-card p-5 md:col-span-2">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Resumo
            </h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatBox label="Conversas" value={contact.conversations.length} />
              <StatBox label="Cards" value={cards.length} />
              <StatBox
                label="Não lidas"
                value={contact.conversations.reduce((acc, c) => acc + c.unreadCount, 0)}
              />
              <StatBox
                label="Desde"
                value={new Date(contact.createdAt).toLocaleDateString('pt-BR')}
              />
            </div>
          </section>
        </div>
      )}

      {tab === 'conversations' && (
        <section className="space-y-2">
          {contact.conversations.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-muted/20 p-8 text-center text-sm text-muted-foreground">
              Nenhuma conversa ainda. Use “Iniciar conversa” pra falar com este contato.
            </div>
          ) : (
            contact.conversations.map((conv) => (
              <Link
                key={conv.id}
                href={`/inbox/${conv.id}`}
                className="flex items-start gap-3 rounded-lg border bg-card p-3 hover:bg-accent"
              >
                <MessageCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                        STATUS_BADGE[conv.status] ?? 'bg-muted'
                      }`}
                    >
                      {STATUS_LABELS[conv.status] ?? conv.status}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">{conv.inbox.name}</span>
                    {conv.unreadCount > 0 && (
                      <span className="rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground">
                        {conv.unreadCount}
                      </span>
                    )}
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {conv.lastMessageAt
                        ? new Date(conv.lastMessageAt).toLocaleString('pt-BR', {
                            day: '2-digit',
                            month: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : '—'}
                    </span>
                  </div>
                  {conv.lastMessagePreview && (
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {conv.lastMessagePreview}
                    </p>
                  )}
                </div>
              </Link>
            ))
          )}
        </section>
      )}

      {tab === 'cards' && (
        <section className="space-y-2">
          {cards.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-muted/20 p-8 text-center text-sm text-muted-foreground">
              Sem cards no kanban vinculados a este contato.
            </div>
          ) : (
            cards.map((card) => {
              const accent = card.stage.outcome
                ? OUTCOME_COLOR[card.stage.outcome]
                : card.stage.color;
              return (
                <Link
                  key={card.id}
                  href="/kanban"
                  className="flex items-center gap-3 rounded-lg border bg-card p-3 hover:bg-accent"
                >
                  <LayoutGrid className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{card.title}</p>
                    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span>{card.funnel.name}</span>
                      <ChevronRight className="h-2.5 w-2.5" />
                      <span className="inline-flex items-center gap-1">
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: accent }} />
                        {card.stage.name}
                      </span>
                    </div>
                  </div>
                  {card.value && Number(card.value) > 0 && (
                    <span className="font-semibold text-emerald-600">
                      {formatBRL(Number(card.value))}
                    </span>
                  )}
                </Link>
              );
            })
          )}
        </section>
      )}

      {tab === 'notes' && (
        <NotesTab
          contactId={id}
          notes={notesData?.notes ?? []}
          loading={notesLoading}
          onChange={refreshNotes}
          mentionTargets={mentionsData?.targets ?? []}
        />
      )}

      {tab === 'journey' && <JourneyTab contactId={id} />}

      <EditContactDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        contact={contact}
        onSaved={refresh}
      />
      <StartConversationDialog
        open={startConvOpen}
        onOpenChange={setStartConvOpen}
        contact={contact}
      />
    </div>
  );
}

function formatNoteDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return `Hoje, ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  }
  const diffMs = now.getTime() - d.getTime();
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (diffMs >= 0 && diffMs < oneDayMs * 2) {
    return `Ontem, ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  }
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function NotesTab({
  contactId,
  notes,
  loading,
  onChange,
  mentionTargets,
}: {
  contactId: string;
  notes: ContactNoteItem[];
  loading: boolean;
  onChange: () => void;
  mentionTargets: MentionTarget[];
}) {
  const validSlugs = new Set(mentionTargets.map((t) => t.slug.toLowerCase()));
  const confirm = useConfirm();
  const [composer, setComposer] = useState('');
  const [composerSubmitting, setComposerSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function addNote() {
    const body = composer.trim();
    if (!body || composerSubmitting) return;
    setComposerSubmitting(true);
    try {
      await api(`/api/contacts/${contactId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      setComposer('');
      toast.success('Nota adicionada');
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao adicionar nota');
    } finally {
      setComposerSubmitting(false);
    }
  }

  function startEdit(note: ContactNoteItem) {
    setEditingId(note.id);
    setEditDraft(note.body);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft('');
  }

  async function saveEdit(noteId: string) {
    const body = editDraft.trim();
    if (!body || editSubmitting) return;
    setEditSubmitting(true);
    try {
      await api(`/api/contact-notes/${noteId}`, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      });
      cancelEdit();
      toast.success('Nota atualizada');
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar nota');
    } finally {
      setEditSubmitting(false);
    }
  }

  async function removeNote(note: ContactNoteItem) {
    const ok = await confirm({
      title: 'Excluir nota?',
      description: 'A nota é apagada definitivamente.',
      confirmLabel: 'Excluir',
      destructive: true,
    });
    if (!ok) return;
    setDeletingId(note.id);
    try {
      await api(`/api/contact-notes/${note.id}`, { method: 'DELETE' });
      toast.success('Nota excluída');
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao excluir');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="space-y-4">
      <div className="rounded-lg border bg-card p-4">
        <Label htmlFor="contact-note-composer" className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <StickyNote className="h-3.5 w-3.5" />
          Adicionar nota
        </Label>
        <MentionTextarea
          id="contact-note-composer"
          value={composer}
          onChange={setComposer}
          targets={mentionTargets}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              addNote();
            }
          }}
          rows={3}
          maxLength={2000}
          placeholder="Informações que persistem além de uma conversa: histórico, preferências, contexto de relacionamento… (use @ para mencionar um agente)"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">
            {composer.length}/2000 · Cmd/Ctrl+Enter pra salvar · @ menciona agente
          </p>
          <Button
            size="sm"
            onClick={addNote}
            disabled={composerSubmitting || !composer.trim()}
          >
            {composerSubmitting ? 'Salvando…' : 'Adicionar nota'}
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Carregando notas…</p>
      ) : notes.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-muted/20 p-8 text-center text-sm text-muted-foreground">
          Nenhuma nota ainda. Use o campo acima pra criar a primeira.
        </div>
      ) : (
        <ul className="space-y-3">
          {notes.map((note) => {
            const isEditing = editingId === note.id;
            const isDeleting = deletingId === note.id;
            const wasEdited = note.updatedAt && note.updatedAt !== note.createdAt;
            const authorName =
              note.author?.name?.trim() || note.author?.email || 'Agente removido';
            return (
              <li
                key={note.id}
                className="group rounded-lg border bg-card p-4 transition hover:border-foreground/20"
              >
                <header className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    {note.author?.image ? (
                      <img
                        src={note.author.image}
                        alt={authorName}
                        className="h-7 w-7 rounded-full object-cover"
                      />
                    ) : (
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                        {initialsFrom(authorName)}
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{authorName}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {formatNoteDate(note.createdAt)}
                        {wasEdited && (
                          <span className="ml-1.5 italic">
                            · editada {formatNoteDate(note.updatedAt)}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                  {!isEditing && (
                    <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        title="Editar"
                        onClick={() => startEdit(note)}
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        title="Excluir"
                        disabled={isDeleting}
                        onClick={() => removeNote(note)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </header>
                {isEditing ? (
                  <div className="space-y-2">
                    <MentionTextarea
                      value={editDraft}
                      onChange={setEditDraft}
                      targets={mentionTargets}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          cancelEdit();
                        }
                        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                          e.preventDefault();
                          saveEdit(note.id);
                        }
                      }}
                      rows={Math.max(3, Math.min(editDraft.split('\n').length + 1, 12))}
                      maxLength={2000}
                      autoFocus
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <div className="flex items-center justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={editSubmitting}>
                        <X className="h-3.5 w-3.5" />
                        Cancelar
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => saveEdit(note.id)}
                        disabled={editSubmitting || !editDraft.trim() || editDraft.trim() === note.body}
                      >
                        <Check className="h-3.5 w-3.5" />
                        {editSubmitting ? 'Salvando…' : 'Salvar'}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                    {renderMentions(note.body, validSlugs)}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function StatBox({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-xl font-bold">{value}</p>
    </div>
  );
}

function EditContactDialog({
  open,
  onOpenChange,
  contact,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  contact: Contact;
  onSaved: () => void;
}) {
  const [name, setName] = useState(contact.name ?? '');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) setName(contact.name ?? '');
  }, [open, contact.name]);

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await api(`/api/contacts/${contact.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim() || null }),
      });
      toast.success('Contato atualizado');
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar contato</DialogTitle>
          <DialogDescription>
            Telefone é único e não pode ser alterado — use “Mesclar contatos” se for outro caso.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="contact-name">Nome</Label>
            <Input
              id="contact-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nome do contato"
              maxLength={120}
            />
          </div>
          <div className="space-y-2">
            <Label>Telefone</Label>
            <Input value={contact.phoneNumber} disabled />
          </div>
          <Button onClick={submit} className="w-full" disabled={submitting}>
            {submitting ? 'Salvando…' : 'Salvar'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StartConversationDialog({
  open,
  onOpenChange,
  contact,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  contact: Contact;
}) {
  const router = useRouter();
  const { data: inboxesData } = useQuery<{ inboxes: Inbox[] }>({
    queryKey: ['inboxes'],
    queryFn: () => api('/api/inboxes'),
    enabled: open,
  });

  const [inboxId, setInboxId] = useState<string>('');
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open && inboxesData?.inboxes) {
      const connected = inboxesData.inboxes.find((i) => i.status === 'CONNECTED');
      if (connected) setInboxId(connected.id);
    }
  }, [open, inboxesData]);

  // Verifica se já existe conversa neste contato + inbox
  const existing = contact.conversations.find((c) => c.inbox.id === inboxId);

  async function submit() {
    if (!inboxId || !text.trim() || submitting) return;
    setSubmitting(true);
    try {
      let conversationId = existing?.id;
      if (!conversationId) {
        // Cria conversa nova via endpoint
        const r = await api<{ conversation: { id: string } }>(`/api/conversations`, {
          method: 'POST',
          body: JSON.stringify({ contactId: contact.id, inboxId }),
        });
        conversationId = r.conversation.id;
      }
      // Envia primeira msg
      await api(`/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ type: 'TEXT', text }),
      });
      toast.success('Mensagem enviada');
      onOpenChange(false);
      router.push(`/inbox/${conversationId}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'inbox_not_connected') {
        toast.error('Inbox não está conectada. Conecte em /inboxes.');
      } else {
        toast.error(err instanceof Error ? err.message : 'Erro');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const connectedInboxes = (inboxesData?.inboxes ?? []).filter((i) => i.status === 'CONNECTED');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Iniciar conversa</DialogTitle>
          <DialogDescription>
            Envia a primeira mensagem pra {contact.phoneNumber}.
            {existing && ' Já existe conversa nesta inbox — vai retomar.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="start-inbox">Inbox</Label>
            <select
              id="start-inbox"
              value={inboxId}
              onChange={(e) => setInboxId(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Selecione…</option>
              {connectedInboxes.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
            {connectedInboxes.length === 0 && (
              <p className="text-xs text-amber-600">
                Nenhuma inbox conectada. Conecte uma em /inboxes.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="start-text">Mensagem</Label>
            <textarea
              id="start-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              placeholder="Olá, tudo bem?"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <Button
            onClick={submit}
            className="w-full"
            disabled={submitting || !inboxId || !text.trim()}
          >
            {submitting ? 'Enviando…' : 'Enviar mensagem'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// Journey Tab — cross-canal timeline
// ============================================================

type JourneyEventKind =
  | 'msg'
  | 'note'
  | 'card'
  | 'csat'
  | 'conv_started'
  | 'conv_resolved';

interface JourneyEvent {
  id: string;
  kind: JourneyEventKind;
  at: string;
  conversationId?: string;
  inboxName?: string;
  inboxType?: string;
  direction?: 'INBOUND' | 'OUTBOUND';
  preview?: string;
  cardTitle?: string;
  cardId?: string;
  funnelName?: string;
  csatScore?: number;
  csatScoreType?: string;
  csatComment?: string | null;
  noteAuthor?: string | null;
}

const EVENT_FILTERS: Array<{ key: JourneyEventKind | 'all'; label: string }> = [
  { key: 'all', label: 'Tudo' },
  { key: 'msg', label: 'Mensagens' },
  { key: 'note', label: 'Notas' },
  { key: 'card', label: 'Cards' },
  { key: 'csat', label: 'Satisfação' },
  { key: 'conv_started', label: 'Conversas' },
];

const INBOX_TYPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  WHATSAPP: MessageCircle,
  TELEGRAM: Send,
  EMAIL: Mail,
  WEBCHAT: MessageSquare,
};

function JourneyTab({ contactId }: { contactId: string }) {
  const [filter, setFilter] = useState<JourneyEventKind | 'all'>('all');
  const queryStr =
    filter !== 'all'
      ? `?types=${encodeURIComponent(filter === 'conv_started' ? 'conv_started,conv_resolved' : filter)}`
      : '';
  const { data, isLoading } = useQuery<{ events: JourneyEvent[]; total: number; truncated: boolean }>({
    queryKey: ['journey', contactId, filter],
    queryFn: () => api(`/api/contacts/${contactId}/journey${queryStr}`),
  });

  const events = data?.events ?? [];
  const grouped = groupByDay(events);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-card p-2.5">
        {EVENT_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
              filter === f.key
                ? 'border-foreground bg-accent text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-accent/50'
            }`}
          >
            {f.label}
          </button>
        ))}
        {data?.truncated && (
          <span className="ml-auto rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
            mostrando {events.length} mais recentes
          </span>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando histórico…</p>
      ) : events.length === 0 ? (
        <div className="rounded-lg border-2 border-dashed py-12 text-center">
          <Clock className="mx-auto h-10 w-10 text-muted-foreground/40" />
          <p className="mt-3 font-medium">Nada por enquanto</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Quando esse contato tiver mensagens, notas, cards ou survey, aparecem aqui.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map((group) => (
            <div key={group.day}>
              <h3 className="sticky top-0 z-10 mb-2 bg-background/95 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
                {group.label}
              </h3>
              <ol className="space-y-2">
                {group.events.map((e) => (
                  <li key={e.id}>
                    <JourneyEventCard event={e} />
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function groupByDay(events: JourneyEvent[]): Array<{
  day: string;
  label: string;
  events: JourneyEvent[];
}> {
  const groups = new Map<string, JourneyEvent[]>();
  for (const e of events) {
    const d = new Date(e.at);
    const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!groups.has(dayKey)) groups.set(dayKey, []);
    groups.get(dayKey)!.push(e);
  }
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const ymdToday = today.toISOString().slice(0, 10);
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const ymdYesterday = yesterday.toISOString().slice(0, 10);
  return Array.from(groups.entries()).map(([day, evs]) => {
    let label = day;
    if (day === ymdToday) label = 'Hoje';
    else if (day === ymdYesterday) label = 'Ontem';
    else {
      const [y, m, d] = day.split('-');
      label = `${d}/${m}/${y}`;
    }
    return { day, label, events: evs };
  });
}

function JourneyEventCard({ event }: { event: JourneyEvent }) {
  const time = new Date(event.at).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const ChannelIcon = event.inboxType ? INBOX_TYPE_ICON[event.inboxType] : null;

  const { iconBg, icon, content, link } = useEventVisuals(event);

  const inner = (
    <div className="flex gap-3 rounded-lg border bg-card p-3 transition-colors hover:border-foreground/30">
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${iconBg}`}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">{content.title}</div>
          <div className="flex shrink-0 items-center gap-1.5">
            {event.inboxName && ChannelIcon && (
              <span
                className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                title={`${event.inboxName} (${event.inboxType?.toLowerCase()})`}
              >
                <ChannelIcon className="h-2.5 w-2.5" />
                {event.inboxName}
              </span>
            )}
            <span className="text-[10px] tabular-nums text-muted-foreground">{time}</span>
          </div>
        </div>
        {content.body && <div className="mt-1 text-xs text-foreground/80">{content.body}</div>}
      </div>
    </div>
  );

  if (link) {
    return (
      <Link href={link} className="block">
        {inner}
      </Link>
    );
  }
  return inner;
}

function useEventVisuals(event: JourneyEvent): {
  iconBg: string;
  icon: React.ReactElement;
  content: { title: React.ReactNode; body?: React.ReactNode };
  link?: string;
} {
  if (event.kind === 'msg') {
    const isIn = event.direction === 'INBOUND';
    return {
      iconBg: isIn
        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
        : 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
      icon: isIn ? <MessageCircle className="h-4 w-4" /> : <Send className="h-4 w-4" />,
      content: {
        title: (
          <span className="text-sm font-medium">
            {isIn ? 'Mensagem do cliente' : 'Resposta enviada'}
          </span>
        ),
        body: (
          <span className="line-clamp-2 whitespace-pre-wrap break-words text-foreground/80">
            {event.preview}
          </span>
        ),
      },
      link: event.conversationId ? `/inbox/${event.conversationId}` : undefined,
    };
  }
  if (event.kind === 'note') {
    return {
      iconBg: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
      icon: <StickyNote className="h-4 w-4" />,
      content: {
        title: (
          <span className="text-sm font-medium">
            Nota interna
            {event.noteAuthor && (
              <span className="ml-1 font-normal text-muted-foreground">
                · {event.noteAuthor}
              </span>
            )}
          </span>
        ),
        body: (
          <span className="line-clamp-2 whitespace-pre-wrap break-words text-foreground/80">
            {event.preview}
          </span>
        ),
      },
      link: event.conversationId ? `/inbox/${event.conversationId}` : undefined,
    };
  }
  if (event.kind === 'card') {
    return {
      iconBg: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400',
      icon: <LayoutGrid className="h-4 w-4" />,
      content: {
        title: (
          <span className="text-sm font-medium">
            Card criado:{' '}
            <span className="font-normal">
              {event.cardTitle}
              {event.funnelName && (
                <span className="text-muted-foreground"> · {event.funnelName}</span>
              )}
            </span>
          </span>
        ),
      },
      link: '/kanban',
    };
  }
  if (event.kind === 'csat') {
    const score = event.csatScore;
    const type = event.csatScoreType;
    const isPositive =
      (type === 'CSAT' && (score ?? 0) >= 4) ||
      (type === 'NPS' && (score ?? 0) >= 9) ||
      (type === 'THUMBS' && score === 1);
    const isNegative =
      (type === 'CSAT' && (score ?? 0) <= 2) ||
      (type === 'NPS' && (score ?? 0) <= 6) ||
      (type === 'THUMBS' && score === 0);
    return {
      iconBg: isPositive
        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
        : isNegative
          ? 'bg-red-500/15 text-red-600 dark:text-red-400'
          : 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
      icon: <Smile className="h-4 w-4" />,
      content: {
        title: (
          <span className="text-sm font-medium">
            Resposta de satisfação · {type} {score}
            {type === 'CSAT' && '/5'}
            {type === 'NPS' && '/10'}
          </span>
        ),
        body: event.csatComment ? (
          <span className="italic text-foreground/80">&ldquo;{event.csatComment}&rdquo;</span>
        ) : undefined,
      },
      link: event.conversationId ? `/inbox/${event.conversationId}` : undefined,
    };
  }
  if (event.kind === 'conv_started') {
    return {
      iconBg: 'bg-slate-500/15 text-slate-600 dark:text-slate-300',
      icon: <PlayCircle className="h-4 w-4" />,
      content: {
        title: <span className="text-sm font-medium">Conversa iniciada</span>,
      },
      link: event.conversationId ? `/inbox/${event.conversationId}` : undefined,
    };
  }
  // conv_resolved
  return {
    iconBg: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    icon: <Check className="h-4 w-4" />,
    content: {
      title: <span className="text-sm font-medium">Conversa resolvida</span>,
    },
    link: event.conversationId ? `/inbox/${event.conversationId}` : undefined,
  };
}
