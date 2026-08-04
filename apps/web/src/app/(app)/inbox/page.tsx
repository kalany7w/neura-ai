'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  CheckSquare,
  Filter,
  Search,
  Square,
  UserCheck,
  UserMinus,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useRealtimeListener } from '@/hooks/use-realtime-listener';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { InboxBulkActionsBar } from '@/components/inbox/bulk-actions-bar';
import { useSession } from '@/lib/auth-client';

type ConversationStatus = 'OPEN' | 'PENDING' | 'RESOLVED' | 'SNOOZED';

interface LabelOnConv {
  label: { id: string; name: string; color: string };
}

interface AgentRef {
  id: string;
  name: string | null;
  email: string;
}

interface AiClassification {
  intent: 'sale' | 'support' | 'complaint' | 'info' | 'other';
  urgency: 'low' | 'medium' | 'high' | 'critical';
  sentiment: 'positive' | 'neutral' | 'negative';
  confidence: number;
  topics?: string[];
  classifiedAt?: string;
}

interface ConversationListItem {
  id: string;
  status: ConversationStatus;
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  assignedAgentId: string | null;
  archivedAt: string | null;
  firstResponseAt: string | null;
  slaBreachNotifiedAt: string | null;
  contact: { id: string; name: string | null; phoneNumber: string; avatarUrl: string | null };
  inbox: { id: string; name: string };
  labels: LabelOnConv[];
  lastAgentRepliedBy: AgentRef | null;
  aiClassification?: AiClassification | null;
}

const INTENT_BADGE: Record<AiClassification['intent'], { label: string; cls: string }> = {
  sale: {
    label: 'Venda',
    cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  },
  support: {
    label: 'Suporte',
    cls: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  },
  complaint: {
    label: 'Reclamação',
    cls: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300',
  },
  info: { label: 'Info', cls: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  other: { label: 'Outro', cls: 'bg-muted text-muted-foreground' },
};

const URGENCY_DOT: Record<AiClassification['urgency'], string> = {
  low: '',
  medium: 'bg-amber-400',
  high: 'bg-orange-500',
  critical: 'bg-red-500 animate-pulse',
};

const URGENCY_LABEL: Record<AiClassification['urgency'], string> = {
  low: 'Baixa urgência',
  medium: 'Urgência média',
  high: 'Alta urgência',
  critical: 'Urgência crítica',
};

type SlaStatus = 'ok' | 'soft' | 'hard' | 'critical' | null;

const SLA_LIMITS = { soft: 15, hard: 30, critical: 60 }; // minutos

function computeSla(item: ConversationListItem): SlaStatus {
  if (item.status === 'RESOLVED' || item.status === 'SNOOZED') return null;
  if (item.archivedAt) return null;
  if (!item.lastInboundAt) return null;
  const inboundMs = new Date(item.lastInboundAt).getTime();
  const outboundMs = item.lastOutboundAt ? new Date(item.lastOutboundAt).getTime() : 0;
  if (outboundMs >= inboundMs) return null;
  const ageMin = (Date.now() - inboundMs) / 60_000;
  if (ageMin < SLA_LIMITS.soft) return 'ok';
  if (ageMin < SLA_LIMITS.hard) return 'soft';
  if (ageMin < SLA_LIMITS.critical) return 'hard';
  return 'critical';
}

const SLA_DOT: Record<NonNullable<SlaStatus>, string> = {
  ok: 'bg-emerald-500',
  soft: 'bg-amber-500',
  hard: 'bg-orange-500',
  critical: 'bg-red-500 animate-pulse',
};

const SLA_LABEL: Record<NonNullable<SlaStatus>, string> = {
  ok: 'Resposta dentro do prazo',
  soft: 'Atrasada > 15min',
  hard: 'Atrasada > 30min',
  critical: 'Crítica > 1h',
};

type Tab = 'ALL' | 'AWAITING' | 'OPEN' | 'UNASSIGNED' | 'PENDING' | 'RESOLVED' | 'ARCHIVED';

const STATUS_TABS: Array<{ value: Tab; key: string }> = [
  { value: 'ALL', key: 'inbox.tab.all' },
  { value: 'AWAITING', key: 'inbox.tab.awaiting' },
  { value: 'OPEN', key: 'inbox.tab.open' },
  { value: 'UNASSIGNED', key: 'inbox.tab.unassigned' },
  { value: 'PENDING', key: 'inbox.tab.pending' },
  { value: 'RESOLVED', key: 'inbox.tab.resolved' },
  { value: 'ARCHIVED', key: 'inbox.tab.archived' },
];

const STATUS_BADGE: Record<ConversationStatus, string> = {
  OPEN: 'bg-blue-100 text-blue-700',
  PENDING: 'bg-amber-100 text-amber-800',
  RESOLVED: 'bg-emerald-100 text-emerald-700',
  SNOOZED: 'bg-slate-200 text-slate-700',
};

const STATUS_LABEL: Record<ConversationStatus, string> = {
  OPEN: 'Aberta',
  PENDING: 'Pendente',
  RESOLVED: 'Resolvida',
  SNOOZED: 'Adiada',
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

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

interface InboxRef {
  id: string;
  name: string;
}
interface LabelRef {
  id: string;
  name: string;
  color: string;
}

export default function InboxPage() {
  const qc = useQueryClient();
  const { t } = useT();
  const [tab, setTab] = useState<Tab>('ALL');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const perPage = 25;

  // Filtros avançados
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [advStatuses, setAdvStatuses] = useState<Set<string>>(new Set());
  const [advInboxIds, setAdvInboxIds] = useState<Set<string>>(new Set());
  const [advLabelId, setAdvLabelId] = useState<string | null>(null);
  const [advSince, setAdvSince] = useState('');
  const [advUntil, setAdvUntil] = useState('');

  const { data: inboxesData } = useQuery<{ inboxes: InboxRef[] }>({
    queryKey: ['inboxes-min'],
    queryFn: () => api('/api/inboxes'),
  });
  const { data: labelsData } = useQuery<{ labels: LabelRef[] }>({
    queryKey: ['labels'],
    queryFn: () => api('/api/labels'),
  });
  const { data: counts } = useQuery<{ awaiting: number }>({
    queryKey: ['conversations-counts'],
    queryFn: () => api('/api/conversations/counts'),
    refetchInterval: 60_000,
  });

  const { data: wsData } = useQuery<{
    workspace: {
      members: Array<{
        userId: string;
        role: 'ADMIN' | 'SUPERVISOR' | 'AGENT';
        user: { id: string; name: string | null; email: string };
      }>;
    };
  }>({
    queryKey: ['workspace-me'],
    queryFn: () => api('/api/workspaces/me'),
  });
  const { data: session } = useSession();
  const currentUserId = session?.user.id;
  const currentRole =
    wsData?.workspace.members.find((m) => m.userId === currentUserId)?.role ?? 'AGENT';
  const agentsForAssign = useMemo(
    () =>
      (wsData?.workspace.members ?? []).map((m) => ({
        userId: m.userId,
        name: m.user.name,
        email: m.user.email,
      })),
    [wsData?.workspace.members],
  );

  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function clearSelection() {
    setSelectedIds(new Set());
  }

  const advActiveCount =
    (advStatuses.size > 0 ? 1 : 0) +
    (advInboxIds.size > 0 ? 1 : 0) +
    (advLabelId ? 1 : 0) +
    (advSince ? 1 : 0) +
    (advUntil ? 1 : 0);

  function clearAdvanced() {
    setAdvStatuses(new Set());
    setAdvInboxIds(new Set());
    setAdvLabelId(null);
    setAdvSince('');
    setAdvUntil('');
    setPage(1);
  }

  const params = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), perPage: String(perPage) });
    if (tab === 'UNASSIGNED') p.set('unassigned', 'true');
    else if (tab === 'ARCHIVED') p.set('archived', 'true');
    else if (tab === 'AWAITING') p.set('awaiting', 'true');
    else if (tab !== 'ALL') p.set('status', tab);
    if (search) p.set('search', search);

    // Avançado sobrescreve status do tab quando ativo
    if (advStatuses.size > 0) p.set('status', Array.from(advStatuses).join(','));
    if (advInboxIds.size > 0) p.set('inboxId', Array.from(advInboxIds).join(','));
    if (advLabelId) p.set('labelId', advLabelId);
    if (advSince) p.set('since', new Date(advSince).toISOString());
    if (advUntil) p.set('until', new Date(advUntil + 'T23:59:59').toISOString());
    return p;
  }, [tab, search, page, advStatuses, advInboxIds, advLabelId, advSince, advUntil]);

  const { data, isLoading } = useQuery<{
    items: ConversationListItem[];
    total: number;
    page: number;
    perPage: number;
  }>({
    queryKey: [
      'conversations',
      tab,
      search,
      page,
      Array.from(advStatuses).sort().join(','),
      Array.from(advInboxIds).sort().join(','),
      advLabelId,
      advSince,
      advUntil,
    ],
    queryFn: () => api(`/api/conversations?${params.toString()}`),
  });

  useRealtimeListener((event) => {
    if (
      event.event === 'message.new' ||
      event.event === 'conversation.updated' ||
      event.event === 'conversation.read' ||
      event.event === 'conversation.archived' ||
      event.event === 'conversation.unarchived' ||
      event.event === 'conversation.status_changed' ||
      event.event === 'conversation.assigned' ||
      event.event === 'conversation.classified' ||
      event.event === 'conversation.sla_breached'
    ) {
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['conversations-counts'] });
    }
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / perPage)) : 1;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">{t('page.inbox.title')}</h1>
        <p className="text-muted-foreground">{t('page.inbox.subtitle')}</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1 rounded-md bg-muted p-1">
          {STATUS_TABS.map((tabOpt) => {
            const badge =
              tabOpt.value === 'AWAITING' && counts && counts.awaiting > 0 ? counts.awaiting : null;
            const isAwaiting = tabOpt.value === 'AWAITING';
            return (
              <button
                key={tabOpt.value}
                type="button"
                onClick={() => {
                  setTab(tabOpt.value);
                  setPage(1);
                }}
                className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm transition-colors ${
                  tab === tabOpt.value
                    ? 'bg-background shadow-sm font-medium'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {t(tabOpt.key)}
                {badge != null && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none ${
                      isAwaiting
                        ? 'bg-amber-500 text-white'
                        : 'bg-muted-foreground/20 text-foreground'
                    }`}
                  >
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant={advActiveCount > 0 ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFiltersOpen((v) => !v)}
          >
            <Filter className="h-3.5 w-3.5" />
            Filtros
            {advActiveCount > 0 && (
              <span className="rounded-full bg-background/30 px-1.5 text-[10px] font-bold">
                {advActiveCount}
              </span>
            )}
          </Button>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder={t('inbox.search_placeholder')}
              className="w-64 pl-8"
            />
          </div>
        </div>
      </div>

      {filtersOpen && (
        <div className="rounded-lg border bg-card p-4 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">Filtros avançados</p>
            <div className="flex gap-2">
              {advActiveCount > 0 && (
                <Button size="sm" variant="ghost" onClick={clearAdvanced}>
                  <X className="h-3 w-3" />
                  Limpar
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setFiltersOpen(false)}>
                Fechar
              </Button>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Status (múltiplos)
              </p>
              <div className="flex flex-wrap gap-1.5">
                {(['OPEN', 'PENDING', 'RESOLVED', 'SNOOZED'] as const).map((s) => {
                  const active = advStatuses.has(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => {
                        setAdvStatuses((prev) => {
                          const next = new Set(prev);
                          if (next.has(s)) next.delete(s);
                          else next.add(s);
                          return next;
                        });
                        setPage(1);
                      }}
                      className={`rounded-full border px-2.5 py-0.5 text-xs ${
                        active
                          ? 'bg-foreground text-background border-foreground'
                          : 'border-input hover:bg-accent'
                      }`}
                    >
                      {s === 'OPEN'
                        ? 'Aberta'
                        : s === 'PENDING'
                          ? 'Pendente'
                          : s === 'RESOLVED'
                            ? 'Resolvida'
                            : 'Adiada'}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Inboxes
              </p>
              <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
                {(inboxesData?.inboxes ?? []).map((ib) => {
                  const active = advInboxIds.has(ib.id);
                  return (
                    <button
                      key={ib.id}
                      type="button"
                      onClick={() => {
                        setAdvInboxIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(ib.id)) next.delete(ib.id);
                          else next.add(ib.id);
                          return next;
                        });
                        setPage(1);
                      }}
                      className={`rounded-full border px-2.5 py-0.5 text-xs ${
                        active
                          ? 'bg-foreground text-background border-foreground'
                          : 'border-input hover:bg-accent'
                      }`}
                    >
                      {ib.name}
                    </button>
                  );
                })}
                {!inboxesData?.inboxes.length && (
                  <span className="text-xs text-muted-foreground">Nenhuma inbox.</span>
                )}
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Etiqueta
              </p>
              <select
                value={advLabelId ?? ''}
                onChange={(e) => {
                  setAdvLabelId(e.target.value || null);
                  setPage(1);
                }}
                className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">— Qualquer —</option>
                {(labelsData?.labels ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Criada entre
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={advSince}
                  onChange={(e) => {
                    setAdvSince(e.target.value);
                    setPage(1);
                  }}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                />
                <span className="text-xs text-muted-foreground">até</span>
                <input
                  type="date"
                  value={advUntil}
                  onChange={(e) => {
                    setAdvUntil(e.target.value);
                    setPage(1);
                  }}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {(data?.items.length ?? 0) > 0 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => {
              const ids = (data?.items ?? []).map((c) => c.id);
              const allSelected = ids.every((id) => selectedIds.has(id));
              if (allSelected) {
                setSelectedIds((prev) => {
                  const next = new Set(prev);
                  ids.forEach((id) => next.delete(id));
                  return next;
                });
              } else {
                setSelectedIds((prev) => {
                  const next = new Set(prev);
                  ids.forEach((id) => next.add(id));
                  return next;
                });
              }
            }}
            className="rounded-md border px-2 py-0.5 hover:bg-accent"
          >
            {(data?.items ?? []).every((c) => selectedIds.has(c.id))
              ? 'Desselecionar página'
              : `Selecionar página (${data?.items.length})`}
          </button>
          {selectedIds.size > 0 && (
            <span>
              {selectedIds.size} selecionada{selectedIds.size > 1 ? 's' : ''}
            </span>
          )}
        </div>
      )}

      <div className="rounded-lg border bg-card divide-y">
        {isLoading ? (
          <p className="p-6 text-sm text-muted-foreground">{t('action.loading')}</p>
        ) : !data?.items.length ? (
          <p className="p-6 text-sm text-muted-foreground">
            {tab === 'ARCHIVED'
              ? t('inbox.empty_archived')
              : tab === 'AWAITING'
                ? t('inbox.empty_awaiting')
                : t('inbox.empty')}
          </p>
        ) : (
          data.items.map((c) => {
            const isArchived = !!c.archivedAt;
            const sla = computeSla(c);
            const isSelected = selectedIds.has(c.id);
            const hasSelection = selectedIds.size > 0;
            return (
              <div
                key={c.id}
                className={`group flex items-start gap-3 p-4 transition-colors hover:bg-accent/50 ${
                  isArchived ? 'opacity-70' : ''
                } ${isSelected ? 'bg-accent/40' : ''}`}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    toggleSelect(c.id);
                  }}
                  aria-label={isSelected ? 'Desselecionar' : 'Selecionar'}
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
                    isSelected
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input bg-background opacity-0 group-hover:opacity-100'
                  } ${hasSelection ? 'opacity-100' : ''}`}
                >
                  {isSelected ? (
                    <CheckSquare className="h-3 w-3" />
                  ) : (
                    <Square className="h-3 w-3 opacity-0" />
                  )}
                </button>
                <Link href={`/inbox/${c.id}`} className="flex min-w-0 flex-1 items-start gap-3">
                  <div className="relative shrink-0">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-slate-200 to-slate-300 text-xs font-semibold uppercase text-slate-700 ring-2 ring-card">
                      {initialsFrom(c.contact.name ?? c.contact.phoneNumber)}
                    </div>
                    {sla && (
                      <span
                        title={SLA_LABEL[sla]}
                        className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-card ${SLA_DOT[sla]}`}
                      />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-medium">
                        {c.contact.name ?? c.contact.phoneNumber}
                      </p>
                      {c.unreadCount > 0 && (
                        <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
                          {c.unreadCount}
                        </span>
                      )}
                      {isArchived && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                          <Archive className="h-2.5 w-2.5" />
                          Arquivada
                        </span>
                      )}
                      {c.slaBreachNotifiedAt && !c.firstResponseAt && (
                        <span
                          title="SLA estourado — cliente aguardando primeira resposta acima do alvo"
                          className="inline-flex items-center gap-0.5 rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-semibold text-white animate-pulse"
                        >
                          SLA breach
                        </span>
                      )}
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS_BADGE[c.status]}`}
                      >
                        {STATUS_LABEL[c.status]}
                      </span>
                      {c.aiClassification && (
                        <>
                          <span
                            title={`IA: ${INTENT_BADGE[c.aiClassification.intent].label} (${Math.round(c.aiClassification.confidence * 100)}%)`}
                            className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${INTENT_BADGE[c.aiClassification.intent].cls}`}
                          >
                            {INTENT_BADGE[c.aiClassification.intent].label}
                          </span>
                          {c.aiClassification.urgency !== 'low' && (
                            <span
                              title={URGENCY_LABEL[c.aiClassification.urgency]}
                              className={`h-2 w-2 rounded-full ${URGENCY_DOT[c.aiClassification.urgency]}`}
                            />
                          )}
                        </>
                      )}
                    </div>

                    {c.lastMessagePreview && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {c.lastAgentRepliedBy && (
                          <span className="font-medium text-foreground/70">
                            {c.lastAgentRepliedBy.name?.split(' ')[0] ??
                              c.lastAgentRepliedBy.email.split('@')[0]}
                            :{' '}
                          </span>
                        )}
                        {c.lastMessagePreview}
                      </p>
                    )}

                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {c.labels.slice(0, 4).map((cl) => (
                        <span
                          key={cl.label.id}
                          style={{ backgroundColor: cl.label.color + '20', color: cl.label.color }}
                          className="rounded-full px-1.5 py-0 text-[10px] font-medium"
                        >
                          {cl.label.name}
                        </span>
                      ))}
                      {c.labels.length > 4 && (
                        <span className="text-[10px] text-muted-foreground">
                          +{c.labels.length - 4}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-1 text-xs text-muted-foreground">
                    <time>{formatRelative(c.lastMessageAt)}</time>
                    <span className="truncate max-w-[140px]">{c.inbox.name}</span>
                    {c.assignedAgentId ? (
                      <span
                        title={
                          c.lastAgentRepliedBy?.name ?? c.lastAgentRepliedBy?.email ?? 'Atribuída'
                        }
                        className="flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-[9px] font-semibold uppercase text-white"
                      >
                        {initialsFrom(
                          c.lastAgentRepliedBy?.name ?? c.lastAgentRepliedBy?.email ?? 'A',
                        )}
                      </span>
                    ) : (
                      <span className="flex items-center gap-0.5 text-amber-600">
                        <UserMinus className="h-3 w-3" />
                        {t('inbox.tab.unassigned')}
                      </span>
                    )}
                    {tab === 'ARCHIVED' && <ArchiveRestore className="h-3 w-3 opacity-50" />}
                    {tab !== 'ARCHIVED' && c.assignedAgentId && (
                      <UserCheck className="h-3 w-3 opacity-0" />
                    )}
                  </div>
                </Link>
              </div>
            );
          })
        )}
      </div>

      {data && data.total > perPage && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-muted-foreground">
            {data.total} conversas · página {data.page} de {totalPages}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded border px-3 py-1 disabled:opacity-50"
            >
              Anterior
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="rounded border px-3 py-1 disabled:opacity-50"
            >
              Próxima
            </button>
          </div>
        </div>
      )}

      <InboxBulkActionsBar
        selectedIds={Array.from(selectedIds)}
        labels={labelsData?.labels ?? []}
        agents={agentsForAssign}
        role={currentRole}
        tab={tab}
        onClear={clearSelection}
      />
    </div>
  );
}
