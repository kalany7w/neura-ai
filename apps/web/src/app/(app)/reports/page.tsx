'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  Clock,
  Download,
  MessageCircle,
  TrendingDown,
  TrendingUp,
  Users,
  Inbox,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Overview {
  range: { since: string; until: string };
  conversations: { total: number; byStatus: Record<string, number> };
  messages: { total: number; byDirection: Record<string, number> };
  firstResponseTime: {
    count: number;
    avg: number;
    p50: number;
    p90: number;
    avgHuman: string;
    p50Human: string;
    p90Human: string;
  };
  pipeline: {
    positive: number;
    negative: number;
    positiveValue: number;
    negativeValue: number;
    conversionRate: number | null;
  };
}

interface AgentRow {
  userId: string;
  name: string;
  email: string;
  role: string;
  conversationsTotal: number;
  conversationsByStatus: Record<string, number>;
  frt: { count: number; avgHuman: string };
}

interface InboxRow {
  id: string;
  name: string;
  status: string;
  conversationsTotal: number;
  conversationsByStatus: Record<string, number>;
  messages: number;
  frt: { count: number; avgHuman: string };
}

function formatBRL(n: number): string {
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}

function toInputDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type Tab = 'overview' | 'agents' | 'inboxes' | 'sla';

interface SlaSummary {
  totalConversations: number;
  frtAvg: number;
  frtP50: number;
  frtP90: number;
  frtHitRate: number | null;
  frtAvgHuman: string;
  frtP50Human: string;
  frtP90Human: string;
  rtAvg: number;
  rtP50: number;
  rtP90: number;
  rtHitRate: number | null;
  rtAvgHuman: string;
  rtP90Human: string;
  currentlyBreached: number;
}

interface SlaAgentRow {
  userId: string;
  name: string | null;
  email: string;
  conversations: number;
  frtAvg: number;
  frtP50: number;
  frtP90: number;
  frtHitRate: number | null;
  rtAvg: number;
  rtHitRate: number | null;
}

interface SlaReport {
  thresholds: { firstResponseMin: number; resolutionMin: number };
  summary: SlaSummary;
  agents: SlaAgentRow[];
}

export default function ReportsPage() {
  const today = new Date();
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  const [since, setSince] = useState(toInputDate(thirtyDaysAgo));
  const [until, setUntil] = useState(toInputDate(today));
  const [tab, setTab] = useState<Tab>('overview');

  const sinceIso = new Date(since + 'T00:00:00').toISOString();
  const untilIso = new Date(until + 'T23:59:59').toISOString();
  const queryStr = `since=${encodeURIComponent(sinceIso)}&until=${encodeURIComponent(untilIso)}`;

  const overviewQ = useQuery<Overview>({
    queryKey: ['reports-overview', sinceIso, untilIso],
    queryFn: () => api(`/api/reports/overview?${queryStr}`),
    enabled: tab === 'overview',
  });
  const agentsQ = useQuery<{ rows: AgentRow[] }>({
    queryKey: ['reports-agents', sinceIso, untilIso],
    queryFn: () => api(`/api/reports/agents?${queryStr}`),
    enabled: tab === 'agents',
  });
  const inboxesQ = useQuery<{ rows: InboxRow[] }>({
    queryKey: ['reports-inboxes', sinceIso, untilIso],
    queryFn: () => api(`/api/reports/inboxes?${queryStr}`),
    enabled: tab === 'inboxes',
  });
  const slaQ = useQuery<SlaReport>({
    queryKey: ['reports-sla', sinceIso, untilIso],
    queryFn: () => api(`/api/reports/sla?${queryStr}`),
    enabled: tab === 'sla',
  });

  function downloadCsv(type: 'conversations' | 'messages') {
    const url = `/api/reports/export.csv?type=${type}&${queryStr}`;
    window.open(url, '_blank');
    toast.success(`Exportando ${type === 'conversations' ? 'conversas' : 'mensagens'}…`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-3xl font-bold">
          <BarChart3 className="h-7 w-7 text-violet-500" />
          Relatórios
        </h1>
        <p className="text-muted-foreground">
          Métricas de atendimento. Filtre por período e exporte como CSV.
        </p>
      </div>

      {/* Date range + export */}
      <div className="flex flex-wrap items-end justify-between gap-3 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="since" className="text-xs">
              De
            </Label>
            <Input
              id="since"
              type="date"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              className="w-40"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="until" className="text-xs">
              Até
            </Label>
            <Input
              id="until"
              type="date"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              className="w-40"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="outline" onClick={() => setShortcut(7, setSince, setUntil)}>
              7d
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShortcut(30, setSince, setUntil)}>
              30d
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShortcut(90, setSince, setUntil)}>
              90d
            </Button>
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => downloadCsv('conversations')}>
            <Download className="h-3.5 w-3.5" />
            CSV conversas
          </Button>
          <Button size="sm" variant="outline" onClick={() => downloadCsv('messages')}>
            <Download className="h-3.5 w-3.5" />
            CSV mensagens
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {(['overview', 'agents', 'inboxes', 'sla'] as const).map((t) => (
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
            {t === 'overview'
              ? 'Visão geral'
              : t === 'agents'
                ? 'Por agente'
                : t === 'inboxes'
                  ? 'Por inbox'
                  : 'SLA'}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          {overviewQ.isLoading ? (
            <p className="text-sm text-muted-foreground">Carregando…</p>
          ) : overviewQ.data ? (
            <OverviewTab data={overviewQ.data} />
          ) : null}
        </>
      )}

      {tab === 'agents' && (
        <>
          {agentsQ.isLoading ? (
            <p className="text-sm text-muted-foreground">Carregando…</p>
          ) : agentsQ.data ? (
            <AgentsTab rows={agentsQ.data.rows} />
          ) : null}
        </>
      )}

      {tab === 'inboxes' && (
        <>
          {inboxesQ.isLoading ? (
            <p className="text-sm text-muted-foreground">Carregando…</p>
          ) : inboxesQ.data ? (
            <InboxesTab rows={inboxesQ.data.rows} />
          ) : null}
        </>
      )}

      {tab === 'sla' && (
        <>
          {slaQ.isLoading ? (
            <p className="text-sm text-muted-foreground">Carregando…</p>
          ) : slaQ.data ? (
            <SlaTab data={slaQ.data} />
          ) : null}
        </>
      )}
    </div>
  );
}

function SlaTab({ data }: { data: SlaReport }) {
  const { summary, agents, thresholds } = data;
  const hitColor = (rate: number | null) => {
    if (rate == null) return 'text-muted-foreground';
    if (rate >= 90) return 'text-emerald-600 dark:text-emerald-400';
    if (rate >= 70) return 'text-amber-600 dark:text-amber-400';
    return 'text-red-600 dark:text-red-400';
  };
  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-amber-50/50 p-3 text-sm dark:bg-amber-950/20">
        Alvos: FRT <strong>{thresholds.firstResponseMin}min</strong> · RT{' '}
        <strong>{thresholds.resolutionMin}min</strong>. Configure em{' '}
        <a href="/settings/sla" className="font-medium underline">
          Configurações → SLA
        </a>
        .
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <SlaKpiCard label="Conversas no período" value={summary.totalConversations.toLocaleString('pt-BR')} />
        <SlaKpiCard
          label="FRT médio"
          value={summary.frtAvgHuman}
          sub={`P50 ${summary.frtP50Human} · P90 ${summary.frtP90Human}`}
        />
        <SlaKpiCard
          label="FRT hit rate"
          value={summary.frtHitRate != null ? `${summary.frtHitRate}%` : '—'}
          valueClass={hitColor(summary.frtHitRate)}
          sub={`dentro de ${thresholds.firstResponseMin}min`}
        />
        <SlaKpiCard
          label="Em breach agora"
          value={summary.currentlyBreached.toLocaleString('pt-BR')}
          valueClass={
            summary.currentlyBreached > 0 ? 'text-red-600 dark:text-red-400' : 'text-foreground'
          }
          sub="aguardando primeira resposta"
        />
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <SlaKpiCard
          label="RT médio"
          value={summary.rtAvgHuman}
          sub={`P90 ${summary.rtP90Human}`}
        />
        <SlaKpiCard
          label="RT hit rate"
          value={summary.rtHitRate != null ? `${summary.rtHitRate}%` : '—'}
          valueClass={hitColor(summary.rtHitRate)}
          sub={`dentro de ${thresholds.resolutionMin}min`}
        />
        <SlaKpiCard
          label="P50 resolução"
          value={summary.rtP50 != null ? formatSeconds(summary.rtP50) : '—'}
        />
      </div>

      <div className="rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <h3 className="text-sm font-semibold">Por agente</h3>
          <p className="text-xs text-muted-foreground">
            Quem mais respondeu primeiro nas conversas do período.
          </p>
        </div>
        {agents.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">Sem dados.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left">Agente</th>
                  <th className="px-4 py-2 text-right">Conversas</th>
                  <th className="px-4 py-2 text-right">FRT médio</th>
                  <th className="px-4 py-2 text-right">FRT P90</th>
                  <th className="px-4 py-2 text-right">FRT hit %</th>
                  <th className="px-4 py-2 text-right">RT médio</th>
                  <th className="px-4 py-2 text-right">RT hit %</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {agents.map((a) => (
                  <tr key={a.userId} className="hover:bg-accent/30">
                    <td className="px-4 py-2">
                      <p className="font-medium">{a.name ?? a.email}</p>
                      {a.name && (
                        <p className="text-[11px] text-muted-foreground">{a.email}</p>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{a.conversations}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatSeconds(a.frtAvg)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatSeconds(a.frtP90)}
                    </td>
                    <td className={`px-4 py-2 text-right tabular-nums font-semibold ${hitColor(a.frtHitRate)}`}>
                      {a.frtHitRate != null ? `${a.frtHitRate}%` : '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {a.rtAvg ? formatSeconds(a.rtAvg) : '—'}
                    </td>
                    <td className={`px-4 py-2 text-right tabular-nums font-semibold ${hitColor(a.rtHitRate)}`}>
                      {a.rtHitRate != null ? `${a.rtHitRate}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function SlaKpiCard({
  label,
  value,
  sub,
  valueClass,
}: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-bold ${valueClass ?? ''}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function formatSeconds(sec: number): string {
  if (!sec || sec <= 0) return '0s';
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}min`;
  if (sec < 86400) return `${Math.round(sec / 360) / 10}h`;
  return `${Math.round(sec / 8640) / 10}d`;
}

function setShortcut(
  days: number,
  setSince: (v: string) => void,
  setUntil: (v: string) => void,
) {
  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
  setSince(toInputDate(since));
  setUntil(toInputDate(until));
}

function OverviewTab({ data }: { data: Overview }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Conversas"
          value={data.conversations.total}
          icon={MessageCircle}
          accent="blue"
        />
        <KpiCard
          label="Mensagens"
          value={data.messages.total}
          subtitle={`${data.messages.byDirection.INBOUND ?? 0} IN · ${data.messages.byDirection.OUTBOUND ?? 0} OUT`}
          icon={MessageCircle}
          accent="slate"
        />
        <KpiCard
          label="FRT médio"
          value={data.firstResponseTime.avgHuman}
          subtitle={`${data.firstResponseTime.count} respondidas · p90 ${data.firstResponseTime.p90Human}`}
          icon={Clock}
          accent="amber"
        />
        <KpiCard
          label="Conversão pipeline"
          value={data.pipeline.conversionRate !== null ? `${data.pipeline.conversionRate}%` : '—'}
          subtitle={`${data.pipeline.positive} ganhos · ${data.pipeline.negative} perdas`}
          icon={TrendingUp}
          accent={data.pipeline.conversionRate && data.pipeline.conversionRate >= 50 ? 'emerald' : 'slate'}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-lg border bg-card p-5">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Conversas por status
          </h3>
          <ul className="space-y-2">
            {['OPEN', 'PENDING', 'RESOLVED', 'SNOOZED'].map((s) => {
              const n = data.conversations.byStatus[s] ?? 0;
              const pct = data.conversations.total > 0 ? (n / data.conversations.total) * 100 : 0;
              return (
                <li key={s}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium">{s}</span>
                    <span className="text-muted-foreground">
                      {n} ({Math.round(pct)}%)
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full ${
                        s === 'OPEN'
                          ? 'bg-blue-500'
                          : s === 'PENDING'
                            ? 'bg-amber-500'
                            : s === 'RESOLVED'
                              ? 'bg-emerald-500'
                              : 'bg-slate-500'
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="rounded-lg border bg-card p-5">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Pipeline
          </h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-md bg-emerald-50 px-3 py-2 ring-1 ring-emerald-100">
              <span className="flex items-center gap-2 text-sm">
                <TrendingUp className="h-4 w-4 text-emerald-600" />
                Positivos
              </span>
              <div className="text-right">
                <p className="text-lg font-bold text-emerald-700">{data.pipeline.positive}</p>
                {data.pipeline.positiveValue > 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    {formatBRL(data.pipeline.positiveValue)}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md bg-red-50 px-3 py-2 ring-1 ring-red-100">
              <span className="flex items-center gap-2 text-sm">
                <TrendingDown className="h-4 w-4 text-red-600" />
                Negativos
              </span>
              <div className="text-right">
                <p className="text-lg font-bold text-red-700">{data.pipeline.negative}</p>
                {data.pipeline.negativeValue > 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    {formatBRL(data.pipeline.negativeValue)}
                  </p>
                )}
              </div>
            </div>
            {data.pipeline.conversionRate !== null && (
              <div className="mt-4">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium uppercase tracking-wider text-muted-foreground">
                    Taxa de conversão
                  </span>
                  <span className="text-base font-bold">{data.pipeline.conversionRate}%</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-600"
                    style={{ width: `${data.pipeline.conversionRate}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-5">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Tempo de primeira resposta (FRT)
        </h3>
        <div className="grid grid-cols-3 gap-4">
          <Stat label="Média" value={data.firstResponseTime.avgHuman} />
          <Stat label="Mediana (p50)" value={data.firstResponseTime.p50Human} />
          <Stat label="p90" value={data.firstResponseTime.p90Human} />
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          Baseado em {data.firstResponseTime.count} conversas respondidas no período.
        </p>
      </div>
    </div>
  );
}

function AgentsTab({ rows }: { rows: AgentRow[] }) {
  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <th className="px-4 py-2.5">Agente</th>
            <th className="px-4 py-2.5">Role</th>
            <th className="px-4 py-2.5 text-right">Conversas</th>
            <th className="px-4 py-2.5 text-right">Abertas</th>
            <th className="px-4 py-2.5 text-right">Resolvidas</th>
            <th className="px-4 py-2.5 text-right">FRT médio</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                Sem dados no período.
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.userId} className="border-t">
                <td className="px-4 py-2.5">
                  <div>
                    <p className="font-medium">{r.name}</p>
                    <p className="text-[11px] text-muted-foreground">{r.email}</p>
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase">
                    {r.role}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right font-bold">{r.conversationsTotal}</td>
                <td className="px-4 py-2.5 text-right text-blue-700">
                  {(r.conversationsByStatus.OPEN ?? 0) + (r.conversationsByStatus.PENDING ?? 0)}
                </td>
                <td className="px-4 py-2.5 text-right text-emerald-700">
                  {r.conversationsByStatus.RESOLVED ?? 0}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span className="font-medium">{r.frt.avgHuman}</span>
                  {r.frt.count > 0 && (
                    <span className="ml-1 text-[10px] text-muted-foreground">({r.frt.count})</span>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function InboxesTab({ rows }: { rows: InboxRow[] }) {
  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <th className="px-4 py-2.5">Inbox</th>
            <th className="px-4 py-2.5 text-right">Conversas</th>
            <th className="px-4 py-2.5 text-right">Mensagens</th>
            <th className="px-4 py-2.5 text-right">Abertas</th>
            <th className="px-4 py-2.5 text-right">Resolvidas</th>
            <th className="px-4 py-2.5 text-right">FRT médio</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                Sem dados no período.
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <Inbox className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="font-medium">{r.name}</span>
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${
                        r.status === 'CONNECTED'
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {r.status}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-right font-bold">{r.conversationsTotal}</td>
                <td className="px-4 py-2.5 text-right">{r.messages}</td>
                <td className="px-4 py-2.5 text-right text-blue-700">
                  {(r.conversationsByStatus.OPEN ?? 0) + (r.conversationsByStatus.PENDING ?? 0)}
                </td>
                <td className="px-4 py-2.5 text-right text-emerald-700">
                  {r.conversationsByStatus.RESOLVED ?? 0}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span className="font-medium">{r.frt.avgHuman}</span>
                  {r.frt.count > 0 && (
                    <span className="ml-1 text-[10px] text-muted-foreground">({r.frt.count})</span>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}

const ACCENT_BG: Record<string, string> = {
  blue: 'bg-blue-50 text-blue-700 ring-blue-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  slate: 'bg-slate-50 text-slate-600 ring-slate-200',
};

function KpiCard({
  label,
  value,
  subtitle,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string | number;
  subtitle?: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: keyof typeof ACCENT_BG;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <p className="mt-1 text-2xl font-bold">{value}</p>
          {subtitle && <p className="mt-1 text-[11px] text-muted-foreground">{subtitle}</p>}
        </div>
        <div className={`flex h-9 w-9 items-center justify-center rounded-lg ring-1 ${ACCENT_BG[accent]}`}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </div>
  );
}

// Prevent unused import warning for Users
void Users;
