'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Inbox,
  Layers,
  MessageCircle,
  Phone,
  TrendingDown,
  TrendingUp,
  User,
  UserX,
  Users,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/auth-client';
import { DashboardTimeseriesChart } from '@/components/dashboard/timeseries-chart';

interface DashboardStats {
  inbox: {
    open: number;
    pending: number;
    unassigned: number;
    mine: number;
    slaCritical: number;
  };
  workspace: {
    contacts: number;
    activeInboxes: number;
  };
  pipeline: {
    activeCount: number;
    activeValue: number;
    positive30d: number;
    negative30d: number;
    positiveValue30d: number;
    negativeValue30d: number;
    conversionRate: number | null;
  };
  recentConversations: Array<{
    id: string;
    status: string;
    lastMessageAt: string | null;
    lastMessagePreview: string | null;
    unreadCount: number;
    contact: { id: string; name: string | null; phoneNumber: string };
    inbox: { id: string; name: string };
  }>;
}

function formatBRL(n: number): string {
  return n.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  });
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `${minutes}m atrás`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h atrás`;
  const days = Math.floor(hours / 24);
  return `${days}d atrás`;
}

function initialsFrom(s: string | null | undefined): string {
  if (!s) return '?';
  return s
    .split(/[\s.@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

const STATUS_BADGE: Record<string, string> = {
  OPEN: 'bg-blue-100 text-blue-700',
  PENDING: 'bg-amber-100 text-amber-800',
  RESOLVED: 'bg-emerald-100 text-emerald-700',
  SNOOZED: 'bg-slate-200 text-slate-700',
};

export default function DashboardPage() {
  const { data: session } = useSession();
  const { data, isLoading } = useQuery<DashboardStats>({
    queryKey: ['dashboard-stats'],
    queryFn: () => api('/api/dashboard/stats'),
    refetchInterval: 60_000,
  });

  if (isLoading || !data) {
    return <p className="text-sm text-muted-foreground">Carregando dashboard…</p>;
  }

  const { inbox, workspace, pipeline, recentConversations } = data;
  const firstName = session?.user?.name?.split(' ')[0] ?? '';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Bem-vindo{firstName ? `, ${firstName}` : ''}</h1>
        <p className="text-muted-foreground">
          Visão geral do workspace em tempo real — atualiza a cada minuto.
        </p>
      </div>

      {/* KPIs principais */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Conversas abertas"
          value={inbox.open + inbox.pending}
          subtitle={`${inbox.open} abertas · ${inbox.pending} pendentes`}
          icon={MessageCircle}
          accent="blue"
          href="/inbox?status=OPEN"
        />
        <KpiCard
          label="Sem agente"
          value={inbox.unassigned}
          subtitle="Aguardando atribuição"
          icon={UserX}
          accent={inbox.unassigned > 0 ? 'amber' : 'slate'}
          href="/inbox?unassigned=true"
        />
        <KpiCard
          label="SLA crítico"
          value={inbox.slaCritical}
          subtitle="Cards atrasados ou no limite"
          icon={AlertTriangle}
          accent={inbox.slaCritical > 0 ? 'red' : 'slate'}
          href="/kanban"
        />
        <KpiCard
          label="Minha fila"
          value={inbox.mine}
          subtitle="Conversas atribuídas a você"
          icon={User}
          accent="indigo"
          href={session?.user?.id ? `/inbox?assignedAgentId=${session.user.id}` : '/inbox'}
        />
      </div>

      {/* Timeseries gráfico */}
      <DashboardTimeseriesChart />

      {/* Pipeline + workspace stats */}
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="rounded-lg border bg-card p-5 lg:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              <Layers className="h-4 w-4" />
              Pipeline
            </h2>
            <Link href="/kanban" className="text-xs text-muted-foreground hover:text-foreground">
              ver kanban →
            </Link>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Em aberto
              </p>
              <p className="mt-1 text-2xl font-bold">{pipeline.activeCount}</p>
              {pipeline.activeValue > 0 && (
                <p className="text-xs font-medium text-emerald-600">
                  {formatBRL(pipeline.activeValue)}
                </p>
              )}
            </div>
            <div>
              <p className="flex items-center gap-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                <TrendingUp className="h-3 w-3 text-emerald-500" />
                Positivos (30d)
              </p>
              <p className="mt-1 text-2xl font-bold text-emerald-600">{pipeline.positive30d}</p>
              {pipeline.positiveValue30d > 0 && (
                <p className="text-xs text-muted-foreground">
                  {formatBRL(pipeline.positiveValue30d)}
                </p>
              )}
            </div>
            <div>
              <p className="flex items-center gap-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                <TrendingDown className="h-3 w-3 text-red-500" />
                Negativos (30d)
              </p>
              <p className="mt-1 text-2xl font-bold text-red-600">{pipeline.negative30d}</p>
              {pipeline.negativeValue30d > 0 && (
                <p className="text-xs text-muted-foreground">
                  {formatBRL(pipeline.negativeValue30d)}
                </p>
              )}
            </div>
          </div>
          {pipeline.conversionRate !== null && (
            <div className="mt-4 rounded-md bg-muted/40 p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium uppercase tracking-wider text-muted-foreground">
                  Taxa de conversão (30d)
                </span>
                <span className="text-base font-bold">{pipeline.conversionRate}%</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-background">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-600 transition-all"
                  style={{ width: `${pipeline.conversionRate}%` }}
                />
              </div>
            </div>
          )}
        </div>

        <div className="rounded-lg border bg-card p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            <Users className="h-4 w-4" />
            Workspace
          </h2>
          <div className="mt-4 space-y-3">
            <div className="flex items-center justify-between border-b pb-2">
              <span className="text-sm text-muted-foreground">Contatos</span>
              <span className="text-xl font-bold">{workspace.contacts}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Inbox className="h-3.5 w-3.5" />
                Inboxes ativas
              </span>
              <span className="text-xl font-bold">{workspace.activeInboxes}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Atividade recente */}
      <div className="rounded-lg border bg-card p-5">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            <MessageCircle className="h-4 w-4" />
            Conversas recentes
          </h2>
          <Link href="/inbox" className="text-xs text-muted-foreground hover:text-foreground">
            ver todas →
          </Link>
        </div>
        {recentConversations.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Sem conversas em aberto. Conecte uma inbox em /inboxes.
          </p>
        ) : (
          <ul className="mt-3 space-y-1.5">
            {recentConversations.map((conv) => (
              <li key={conv.id}>
                <Link
                  href={`/inbox/${conv.id}`}
                  className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/50"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-slate-200 to-slate-300 text-[11px] font-semibold uppercase text-slate-700">
                    {initialsFrom(conv.contact.name ?? conv.contact.phoneNumber)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-medium">
                        {conv.contact.name ?? conv.contact.phoneNumber}
                      </p>
                      <span
                        className={`inline-flex rounded-full px-1.5 py-0.5 text-[9px] font-medium ${
                          STATUS_BADGE[conv.status] ?? 'bg-muted'
                        }`}
                      >
                        {conv.status}
                      </span>
                      {conv.unreadCount > 0 && (
                        <span className="rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground">
                          {conv.unreadCount}
                        </span>
                      )}
                    </div>
                    {conv.lastMessagePreview && (
                      <p className="truncate text-xs text-muted-foreground">
                        {conv.lastMessagePreview}
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="text-[11px] text-muted-foreground">
                      {formatRelative(conv.lastMessageAt)}
                    </p>
                    <p className="flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
                      <Phone className="h-2.5 w-2.5" />
                      {conv.inbox.name}
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const ACCENT_BG: Record<string, string> = {
  blue: 'bg-blue-50 text-blue-700 ring-blue-200',
  indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  slate: 'bg-slate-50 text-slate-600 ring-slate-200',
};

function KpiCard({
  label,
  value,
  subtitle,
  icon: Icon,
  accent,
  href,
}: {
  label: string;
  value: number;
  subtitle?: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: keyof typeof ACCENT_BG;
  href?: string;
}) {
  const inner = (
    <div className="rounded-lg border bg-card p-4 transition hover:shadow-md hover:-translate-y-0.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <p className="mt-1 text-3xl font-bold">{value}</p>
          {subtitle && <p className="mt-1 text-[11px] text-muted-foreground">{subtitle}</p>}
        </div>
        <div className={`flex h-9 w-9 items-center justify-center rounded-lg ring-1 ${ACCENT_BG[accent]}`}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </div>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}

// Lucida import alias for CheckCircle2 (used elsewhere, but unused vars triggers warning otherwise)
void CheckCircle2;
