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
import { useT, formatMoney, formatDateShort, localeFor, type Lang } from '@/lib/i18n';

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

const STATUS_LABEL_KEY: Record<string, string> = {
  OPEN: 'contacts_id.status_open',
  PENDING: 'contacts_id.status_pending',
  RESOLVED: 'contacts_id.status_resolved',
  SNOOZED: 'contacts_id.status_snoozed',
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
  const { t, lang } = useT();
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
      toast.error(err instanceof Error ? err.message : t('common.error'));
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
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  async function remove() {
    if (!data?.contact) return;
    if (
      !(await confirm({
        title: t('contacts_id.delete_confirm_title', {
          name: data.contact.name ?? data.contact.phoneNumber,
        }),
        description: t('contacts_id.delete_confirm_desc'),
        confirmLabel: t('action.delete'),
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/contacts/${id}`, { method: 'DELETE' });
      toast.success(t('contacts_id.contact_deleted'));
      router.push('/contacts');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  if (isLoading) return <p className="text-sm text-muted-foreground">{t('action.loading')}</p>;
  if (!data) return <p className="text-sm text-destructive">{t('contacts_id.not_found')}</p>;

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
            <h1 className="truncate text-2xl font-bold">{contact.name ?? t('contacts_id.no_name')}</h1>
            <p className="flex items-center gap-1 text-sm text-muted-foreground">
              <Phone className="h-3.5 w-3.5" />
              {contact.phoneNumber}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setStartConvOpen(true)}>
            <MessageSquarePlus className="h-3.5 w-3.5" />
            {t('contacts_id.start_conversation')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
            <Edit3 className="h-3.5 w-3.5" />
            {t('action.edit')}
          </Button>
          <Button size="sm" variant="ghost" onClick={remove} className="text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {(['overview', 'conversations', 'cards', 'notes', 'journey'] as const).map((tabKey) => {
          const notesCount = notesData?.notes.length;
          const labels: Record<Tab, string> = {
            overview: t('contacts_id.tab_overview'),
            conversations: t('contacts_id.tab_conversations', { n: contact.conversations.length }),
            cards: t('contacts_id.tab_cards', { n: cards.length }),
            notes:
              notesCount === undefined
                ? t('contacts_id.tab_notes')
                : t('contacts_id.tab_notes_count', { n: notesCount }),
            journey: t('contacts_id.tab_journey'),
          };
          return (
            <button
              key={tabKey}
              type="button"
              onClick={() => setTab(tabKey)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
                tab === tabKey
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {labels[tabKey]}
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
              {t('contacts_id.labels')}
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
                      {t('contacts_id.add_label')}
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
                  {t('contacts_id.no_labels')}
                </p>
              )}
            </div>
          </section>

          <section className="rounded-lg border bg-card p-5">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('contacts_id.custom_attrs_title')}
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
                {t('contacts_id.no_attrs')}
              </p>
            )}
          </section>

          <section className="rounded-lg border bg-card p-5 md:col-span-2">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('contacts_id.summary')}
            </h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatBox label={t('contacts_id.stat_conversations')} value={contact.conversations.length} />
              <StatBox label={t('contacts_id.stat_cards')} value={cards.length} />
              <StatBox
                label={t('contacts_id.stat_unread')}
                value={contact.conversations.reduce((acc, c) => acc + c.unreadCount, 0)}
              />
              <StatBox
                label={t('contacts_id.stat_since')}
                value={formatDateShort(contact.createdAt, lang)}
              />
            </div>
          </section>
        </div>
      )}

      {tab === 'conversations' && (
        <section className="space-y-2">
          {contact.conversations.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-muted/20 p-8 text-center text-sm text-muted-foreground">
              {t('contacts_id.no_conversations')}
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
                      {t(STATUS_LABEL_KEY[conv.status] ?? conv.status)}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">{conv.inbox.name}</span>
                    {conv.unreadCount > 0 && (
                      <span className="rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground">
                        {conv.unreadCount}
                      </span>
                    )}
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {conv.lastMessageAt
                        ? new Date(conv.lastMessageAt).toLocaleString(localeFor(lang), {
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
              {t('contacts_id.no_cards')}
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
                      {formatMoney(Number(card.value), lang)}
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

function formatNoteDate(
  iso: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
  lang: Lang,
): string {
  const d = new Date(iso);
  const now = new Date();
  const locale = localeFor(lang);
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return t('contacts_id.note_today', {
      time: d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }),
    });
  }
  const diffMs = now.getTime() - d.getTime();
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (diffMs >= 0 && diffMs < oneDayMs * 2) {
    return t('contacts_id.note_yesterday', {
      time: d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }),
    });
  }
  return d.toLocaleString(locale, {
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
  const { t, lang } = useT();
  const validSlugs = new Set(mentionTargets.map((m) => m.slug.toLowerCase()));
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
      toast.success(t('contacts_id.note_added'));
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('contacts_id.note_add_error'));
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
      toast.success(t('contacts_id.note_updated'));
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('contacts_id.note_save_error'));
    } finally {
      setEditSubmitting(false);
    }
  }

  async function removeNote(note: ContactNoteItem) {
    const ok = await confirm({
      title: t('contacts_id.note_delete_title'),
      description: t('contacts_id.note_delete_desc'),
      confirmLabel: t('action.delete'),
      destructive: true,
    });
    if (!ok) return;
    setDeletingId(note.id);
    try {
      await api(`/api/contact-notes/${note.id}`, { method: 'DELETE' });
      toast.success(t('contacts_id.note_deleted'));
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('contacts_id.note_delete_error'));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="space-y-4">
      <div className="rounded-lg border bg-card p-4">
        <Label htmlFor="contact-note-composer" className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <StickyNote className="h-3.5 w-3.5" />
          {t('contacts_id.add_note')}
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
          placeholder={t('contacts_id.note_placeholder')}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">
            {t('contacts_id.note_hint', { n: composer.length })}
          </p>
          <Button
            size="sm"
            onClick={addNote}
            disabled={composerSubmitting || !composer.trim()}
          >
            {composerSubmitting ? t('action.saving') : t('contacts_id.add_note')}
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">{t('contacts_id.loading_notes')}</p>
      ) : notes.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-muted/20 p-8 text-center text-sm text-muted-foreground">
          {t('contacts_id.no_notes')}
        </div>
      ) : (
        <ul className="space-y-3">
          {notes.map((note) => {
            const isEditing = editingId === note.id;
            const isDeleting = deletingId === note.id;
            const wasEdited = note.updatedAt && note.updatedAt !== note.createdAt;
            const authorName =
              note.author?.name?.trim() || note.author?.email || t('contacts_id.agent_removed');
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
                        {formatNoteDate(note.createdAt, t, lang)}
                        {wasEdited && (
                          <span className="ml-1.5 italic">
                            {t('contacts_id.note_edited', {
                              date: formatNoteDate(note.updatedAt, t, lang),
                            })}
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
                        title={t('action.edit')}
                        onClick={() => startEdit(note)}
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        title={t('action.delete')}
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
                        {t('action.cancel')}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => saveEdit(note.id)}
                        disabled={editSubmitting || !editDraft.trim() || editDraft.trim() === note.body}
                      >
                        <Check className="h-3.5 w-3.5" />
                        {editSubmitting ? t('action.saving') : t('action.save')}
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
  const { t } = useT();
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
      toast.success(t('contacts_id.contact_updated'));
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('contacts_id.edit_contact_title')}</DialogTitle>
          <DialogDescription>
            {t('contacts_id.edit_contact_desc')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="contact-name">{t('common.name')}</Label>
            <Input
              id="contact-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('contacts_id.contact_name_placeholder')}
              maxLength={120}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('common.phone')}</Label>
            <Input value={contact.phoneNumber} disabled />
          </div>
          <Button onClick={submit} className="w-full" disabled={submitting}>
            {submitting ? t('action.saving') : t('action.save')}
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
  const { t } = useT();
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
      toast.success(t('contacts_id.message_sent'));
      onOpenChange(false);
      router.push(`/inbox/${conversationId}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'inbox_not_connected') {
        toast.error(t('contacts_id.inbox_not_connected'));
      } else {
        toast.error(err instanceof Error ? err.message : t('common.error'));
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
          <DialogTitle>{t('contacts_id.start_conversation')}</DialogTitle>
          <DialogDescription>
            {t('contacts_id.start_conv_desc', { phone: contact.phoneNumber })}
            {existing && t('contacts_id.start_conv_existing')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="start-inbox">{t('contacts_id.inbox_label')}</Label>
            <select
              id="start-inbox"
              value={inboxId}
              onChange={(e) => setInboxId(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">{t('contacts_id.select_placeholder')}</option>
              {connectedInboxes.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
            {connectedInboxes.length === 0 && (
              <p className="text-xs text-amber-600">
                {t('contacts_id.no_connected_inbox')}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="start-text">{t('contacts_id.message_label')}</Label>
            <textarea
              id="start-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              placeholder={t('contacts_id.message_placeholder')}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <Button
            onClick={submit}
            className="w-full"
            disabled={submitting || !inboxId || !text.trim()}
          >
            {submitting ? t('contacts_id.sending') : t('contacts_id.send_message')}
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

const EVENT_FILTERS: Array<{ key: JourneyEventKind | 'all'; labelKey: string }> = [
  { key: 'all', labelKey: 'contacts_id.filter_all' },
  { key: 'msg', labelKey: 'contacts_id.filter_msg' },
  { key: 'note', labelKey: 'contacts_id.filter_notes' },
  { key: 'card', labelKey: 'contacts_id.filter_cards' },
  { key: 'csat', labelKey: 'contacts_id.filter_csat' },
  { key: 'conv_started', labelKey: 'contacts_id.filter_conversations' },
];

const INBOX_TYPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  WHATSAPP: MessageCircle,
  TELEGRAM: Send,
  EMAIL: Mail,
  WEBCHAT: MessageSquare,
};

function JourneyTab({ contactId }: { contactId: string }) {
  const { t } = useT();
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
  const grouped = groupByDay(events, t);

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
            {t(f.labelKey)}
          </button>
        ))}
        {data?.truncated && (
          <span className="ml-auto rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
            {t('contacts_id.showing_recent', { n: events.length })}
          </span>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('contacts_id.loading_history')}</p>
      ) : events.length === 0 ? (
        <div className="rounded-lg border-2 border-dashed py-12 text-center">
          <Clock className="mx-auto h-10 w-10 text-muted-foreground/40" />
          <p className="mt-3 font-medium">{t('contacts_id.journey_empty_title')}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('contacts_id.journey_empty_desc')}
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

function groupByDay(
  events: JourneyEvent[],
  t: (key: string, vars?: Record<string, string | number>) => string,
): Array<{
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
    if (day === ymdToday) label = t('action.today');
    else if (day === ymdYesterday) label = t('contacts_id.yesterday');
    else {
      const [y, m, d] = day.split('-');
      label = `${d}/${m}/${y}`;
    }
    return { day, label, events: evs };
  });
}

function JourneyEventCard({ event }: { event: JourneyEvent }) {
  const { lang } = useT();
  const time = new Date(event.at).toLocaleTimeString(localeFor(lang), {
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
  const { t } = useT();
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
            {isIn ? t('contacts_id.event_msg_in') : t('contacts_id.event_msg_out')}
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
            {t('contacts_id.event_note')}
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
            {t('contacts_id.event_card')}{' '}
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
            {t('contacts_id.event_csat')} · {type} {score}
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
        title: <span className="text-sm font-medium">{t('contacts_id.event_conv_started')}</span>,
      },
      link: event.conversationId ? `/inbox/${event.conversationId}` : undefined,
    };
  }
  // conv_resolved
  return {
    iconBg: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    icon: <Check className="h-4 w-4" />,
    content: {
      title: <span className="text-sm font-medium">{t('contacts_id.event_conv_resolved')}</span>,
    },
    link: event.conversationId ? `/inbox/${event.conversationId}` : undefined,
  };
}
