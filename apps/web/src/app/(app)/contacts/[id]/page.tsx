'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ChevronRight,
  Edit3,
  LayoutGrid,
  MessageCircle,
  MessageSquarePlus,
  Phone,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
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

type Tab = 'overview' | 'conversations' | 'cards';

export default function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const router = useRouter();
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

  const refresh = () => qc.invalidateQueries({ queryKey: ['contact-detail', id] });

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
      !confirm(
        `Excluir contato "${data.contact.name ?? data.contact.phoneNumber}"? Conversas e cards relacionados perdem o vínculo.`,
      )
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
        {(['overview', 'conversations', 'cards'] as const).map((t) => {
          const labels: Record<Tab, string> = {
            overview: 'Visão geral',
            conversations: `Conversas (${contact.conversations.length})`,
            cards: `Cards (${cards.length})`,
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
