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
import { useT, formatMoney, localeFor } from '@/lib/i18n';
import { useWorkspaceCurrency } from '@/hooks/use-workspace-currency';
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

function toInputDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type Tab = 'overview' | 'agents' | 'inboxes' | 'sla' | 'csat' | 'kb';

interface KbReport {
  summary: {
    published: number;
    drafts: number;
    archived: number;
    withEmbedding: number;
    coverage: number | null;
    suggestedTotal: number;
    acceptedTotal: number;
    acceptRate: number | null;
  };
  topArticles: Array<{
    id: string;
    title: string;
    slug: string;
    viewCount: number;
    category: { name: string; color: string } | null;
    indexed: boolean;
  }>;
}

interface CsatAgentRow {
  userId: string;
  name: string | null;
  email: string;
  responses: number;
  csatAvg: number | null;
  npsScore: number | null;
  thumbsRate: number | null;
}
interface CsatReport {
  summary: {
    totalSent: number;
    totalResponses: number;
    responseRate: number | null;
    csatAvg: number | null;
    csatSatisfactionRate: number | null;
    npsScore: number | null;
    npsBreakdown: { promoters: number; passives: number; detractors: number };
    thumbsPositiveRate: number | null;
    thumbsBreakdown: { positives: number; negatives: number };
  };
  csatDistribution: Array<{ score: number; count: number }>;
  agents: CsatAgentRow[];
  recentComments: Array<{
    score: number;
    scoreType: 'CSAT' | 'NPS' | 'THUMBS';
    comment: string | null;
    respondedAt: string;
  }>;
  surveys: Array<{
    id: string;
    name: string;
    scoreType: 'CSAT' | 'NPS' | 'THUMBS';
    sentCount: number;
    responseCount: number;
    enabled: boolean;
  }>;
}

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
  const { t } = useT();
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
  const csatQ = useQuery<CsatReport>({
    queryKey: ['reports-csat', sinceIso, untilIso],
    queryFn: () => api(`/api/reports/csat?${queryStr}`),
    enabled: tab === 'csat',
  });
  const kbQ = useQuery<KbReport>({
    queryKey: ['reports-kb', sinceIso, untilIso],
    queryFn: () => api(`/api/reports/kb?${queryStr}`),
    enabled: tab === 'kb',
  });

  function downloadCsv(type: 'conversations' | 'messages') {
    const url = `/api/reports/export.csv?type=${type}&${queryStr}`;
    window.open(url, '_blank');
    toast.success(
      type === 'conversations'
        ? t('reports.toast.exporting_conversations')
        : t('reports.toast.exporting_messages'),
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-3xl font-bold">
          <BarChart3 className="h-7 w-7 text-violet-500" />
          {t('page.reports.title')}
        </h1>
        <p className="text-muted-foreground">{t('page.reports.subtitle')}</p>
      </div>

      {/* Date range + export */}
      <div className="flex flex-wrap items-end justify-between gap-3 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="since" className="text-xs">
              {t('reports.date.from')}
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
              {t('reports.date.to')}
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
            {t('reports.csv_conversations')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => downloadCsv('messages')}>
            <Download className="h-3.5 w-3.5" />
            {t('reports.csv_messages')}
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {(['overview', 'agents', 'inboxes', 'sla', 'csat', 'kb'] as const).map((tabKey) => (
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
            {t(`reports.tab.${tabKey}`)}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          {overviewQ.isLoading ? (
            <p className="text-sm text-muted-foreground">{t('action.loading')}</p>
          ) : overviewQ.data ? (
            <OverviewTab data={overviewQ.data} />
          ) : null}
        </>
      )}

      {tab === 'agents' && (
        <>
          {agentsQ.isLoading ? (
            <p className="text-sm text-muted-foreground">{t('action.loading')}</p>
          ) : agentsQ.data ? (
            <AgentsTab rows={agentsQ.data.rows} />
          ) : null}
        </>
      )}

      {tab === 'inboxes' && (
        <>
          {inboxesQ.isLoading ? (
            <p className="text-sm text-muted-foreground">{t('action.loading')}</p>
          ) : inboxesQ.data ? (
            <InboxesTab rows={inboxesQ.data.rows} />
          ) : null}
        </>
      )}

      {tab === 'sla' && (
        <>
          {slaQ.isLoading ? (
            <p className="text-sm text-muted-foreground">{t('action.loading')}</p>
          ) : slaQ.data ? (
            <SlaTab data={slaQ.data} />
          ) : null}
        </>
      )}

      {tab === 'csat' && (
        <>
          {csatQ.isLoading ? (
            <p className="text-sm text-muted-foreground">{t('action.loading')}</p>
          ) : csatQ.data ? (
            <CsatTab data={csatQ.data} />
          ) : null}
        </>
      )}

      {tab === 'kb' && (
        <>
          {kbQ.isLoading ? (
            <p className="text-sm text-muted-foreground">{t('action.loading')}</p>
          ) : kbQ.data ? (
            <KbTab data={kbQ.data} />
          ) : null}
        </>
      )}
    </div>
  );
}

function KbTab({ data }: { data: KbReport }) {
  const { t } = useT();
  const { summary, topArticles } = data;
  const acceptColor =
    summary.acceptRate == null
      ? 'text-muted-foreground'
      : summary.acceptRate >= 50
        ? 'text-emerald-600 dark:text-emerald-400'
        : summary.acceptRate >= 25
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-red-600 dark:text-red-400';
  const coverageColor =
    summary.coverage == null
      ? 'text-muted-foreground'
      : summary.coverage >= 90
        ? 'text-emerald-600 dark:text-emerald-400'
        : summary.coverage >= 60
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-red-600 dark:text-red-400';

  return (
    <div className="space-y-6">
      {summary.published === 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50/40 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/30">
          {t('reports.kb.empty_before')}{' '}
          <a href="/settings/kb" className="font-medium underline">
            /settings/kb
          </a>{' '}
          {t('reports.kb.empty_after')}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <CsatKpiCard label={t('reports.kb.published')} value={summary.published.toString()} />
        <CsatKpiCard
          label={t('reports.kb.ai_coverage')}
          value={summary.coverage !== null ? `${summary.coverage}%` : '—'}
          sub={t('reports.kb.indexed', {
            indexed: summary.withEmbedding,
            total: summary.published,
          })}
          valueClass={coverageColor}
        />
        <CsatKpiCard
          label={t('reports.kb.suggestions')}
          value={summary.suggestedTotal.toString()}
          sub={t('reports.kb.in_period')}
        />
        <CsatKpiCard
          label={t('reports.kb.accept_rate')}
          value={summary.acceptRate !== null ? `${summary.acceptRate}%` : '—'}
          sub={t('reports.kb.accepted_by_agent', { n: summary.acceptedTotal })}
          valueClass={acceptColor}
        />
      </div>

      {summary.drafts + summary.archived > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          <CsatKpiCard
            label={t('reports.kb.drafts')}
            value={summary.drafts.toString()}
            sub={t('reports.kb.drafts_sub')}
          />
          <CsatKpiCard
            label={t('reports.kb.archived')}
            value={summary.archived.toString()}
            sub={t('reports.kb.archived_sub')}
          />
        </div>
      )}

      <div className="rounded-lg border bg-card p-4">
        <h3 className="mb-3 font-semibold">{t('reports.kb.top_articles')}</h3>
        {topArticles.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t('reports.kb.no_articles_before')}{' '}
            <strong>{t('reports.kb.no_articles_strong')}</strong>{' '}
            {t('reports.kb.no_articles_after')}
          </p>
        ) : (
          <ol className="space-y-1.5">
            {topArticles.map((a, idx) => (
              <li key={a.id} className="flex items-center gap-3 rounded-md border bg-card/60 p-2.5">
                <span className="w-5 text-right text-xs font-medium tabular-nums text-muted-foreground">
                  {idx + 1}.
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{a.title}</p>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    {a.category && (
                      <span className="inline-flex items-center gap-1">
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ background: a.category.color }}
                        />
                        {a.category.name}
                      </span>
                    )}
                    {!a.indexed && (
                      <span className="rounded bg-amber-500/15 px-1 text-amber-700 dark:text-amber-300">
                        {t('reports.kb.no_embedding')}
                      </span>
                    )}
                  </div>
                </div>
                <span className="shrink-0 text-sm font-medium tabular-nums">
                  {a.viewCount}
                  <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">
                    {t('reports.kb.usage')}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function CsatTab({ data }: { data: CsatReport }) {
  const { t, lang } = useT();
  const { summary, csatDistribution, agents, recentComments, surveys } = data;
  const enabledSurveys = surveys.filter((s) => s.enabled);
  const hasCsat = csatDistribution.some((d) => d.count > 0);
  const hasNps = summary.npsScore !== null;
  const hasThumbs = summary.thumbsPositiveRate !== null;

  const maxCsatCount = csatDistribution.reduce((m, d) => Math.max(m, d.count), 1);
  const npsColor =
    summary.npsScore == null
      ? 'text-muted-foreground'
      : summary.npsScore >= 50
        ? 'text-emerald-600 dark:text-emerald-400'
        : summary.npsScore >= 0
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-red-600 dark:text-red-400';
  const csatAvgColor =
    summary.csatAvg == null
      ? 'text-muted-foreground'
      : summary.csatAvg >= 4
        ? 'text-emerald-600 dark:text-emerald-400'
        : summary.csatAvg >= 3
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-red-600 dark:text-red-400';

  return (
    <div className="space-y-6">
      {enabledSurveys.length === 0 && summary.totalSent === 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50/40 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/30">
          {t('reports.csat.empty_before')}{' '}
          <a href="/settings/csat" className="font-medium underline">
            /settings/csat
          </a>{' '}
          {t('reports.csat.empty_after')}
        </div>
      )}

      {/* KPIs */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <CsatKpiCard label={t('reports.csat.surveys_sent')} value={summary.totalSent.toString()} />
        <CsatKpiCard
          label={t('reports.col.responses')}
          value={summary.totalResponses.toString()}
          sub={
            summary.responseRate !== null
              ? t('reports.csat.response_rate', { rate: summary.responseRate })
              : '—'
          }
        />
        {hasCsat && (
          <CsatKpiCard
            label={t('reports.csat.csat_avg')}
            value={summary.csatAvg !== null ? summary.csatAvg.toFixed(2) : '—'}
            sub={
              summary.csatSatisfactionRate !== null
                ? t('reports.csat.satisfied', { rate: summary.csatSatisfactionRate })
                : '—'
            }
            valueClass={csatAvgColor}
          />
        )}
        {hasNps && (
          <CsatKpiCard
            label="NPS"
            value={summary.npsScore !== null ? String(summary.npsScore) : '—'}
            sub={t('reports.csat.nps_breakdown', {
              prom: summary.npsBreakdown.promoters,
              pas: summary.npsBreakdown.passives,
              det: summary.npsBreakdown.detractors,
            })}
            valueClass={npsColor}
          />
        )}
        {hasThumbs && (
          <CsatKpiCard
            label={t('reports.csat.thumbs_positive')}
            value={summary.thumbsPositiveRate !== null ? `${summary.thumbsPositiveRate}%` : '—'}
            sub={t('reports.csat.thumbs_breakdown', {
              pos: summary.thumbsBreakdown.positives,
              neg: summary.thumbsBreakdown.negatives,
            })}
          />
        )}
      </div>

      {/* Distribuição CSAT */}
      {hasCsat && (
        <div className="rounded-lg border bg-card p-4">
          <h3 className="mb-3 font-semibold">{t('reports.csat.distribution')}</h3>
          <div className="space-y-1.5">
            {csatDistribution
              .slice()
              .reverse()
              .map((d) => {
                const pct = maxCsatCount > 0 ? Math.round((d.count / maxCsatCount) * 100) : 0;
                const total = csatDistribution.reduce((a, b) => a + b.count, 0);
                const sharePct = total > 0 ? Math.round((d.count / total) * 100) : 0;
                const fill =
                  d.score >= 4 ? 'bg-emerald-500' : d.score === 3 ? 'bg-amber-500' : 'bg-red-500';
                return (
                  <div key={d.score} className="flex items-center gap-3">
                    <span className="w-14 text-sm tabular-nums">
                      {Array(d.score).fill('★').join('')}
                    </span>
                    <div className="relative flex-1">
                      <div className="h-5 rounded bg-muted/50">
                        <div className={`h-5 rounded ${fill}`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                    <span className="w-24 text-right text-xs text-muted-foreground tabular-nums">
                      {d.count} ({sharePct}%)
                    </span>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* Por agente */}
      {agents.length > 0 && (
        <div className="rounded-lg border bg-card p-4">
          <h3 className="mb-3 font-semibold">{t('reports.section.by_agent')}</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="py-2 pr-2">{t('reports.col.agent')}</th>
                  <th className="py-2 px-2 text-right">{t('reports.col.responses')}</th>
                  <th className="py-2 px-2 text-right">CSAT</th>
                  <th className="py-2 px-2 text-right">NPS</th>
                  <th className="py-2 pl-2 text-right">👍</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.userId} className="border-b last:border-0">
                    <td className="py-2 pr-2">
                      <p className="font-medium">{a.name ?? a.email}</p>
                      <p className="text-[10px] text-muted-foreground">{a.email}</p>
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums">{a.responses}</td>
                    <td className="py-2 px-2 text-right tabular-nums">
                      {a.csatAvg !== null ? a.csatAvg.toFixed(2) : '—'}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums">
                      {a.npsScore !== null ? a.npsScore : '—'}
                    </td>
                    <td className="py-2 pl-2 text-right tabular-nums">
                      {a.thumbsRate !== null ? `${a.thumbsRate}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Comentários recentes */}
      {recentComments.length > 0 && (
        <div className="rounded-lg border bg-card p-4">
          <h3 className="mb-3 font-semibold">{t('reports.csat.recent_comments')}</h3>
          <ul className="space-y-2">
            {recentComments.map((c, idx) => (
              <li
                key={idx}
                className={`rounded-md border-l-4 p-3 ${
                  c.scoreType === 'CSAT' && c.score >= 4
                    ? 'border-emerald-500 bg-emerald-50/40 dark:bg-emerald-950/20'
                    : c.scoreType === 'CSAT' && c.score <= 2
                      ? 'border-red-500 bg-red-50/40 dark:bg-red-950/20'
                      : c.scoreType === 'NPS' && c.score >= 9
                        ? 'border-emerald-500 bg-emerald-50/40 dark:bg-emerald-950/20'
                        : c.scoreType === 'NPS' && c.score <= 6
                          ? 'border-red-500 bg-red-50/40 dark:bg-red-950/20'
                          : 'border-amber-500 bg-amber-50/40 dark:bg-amber-950/20'
                }`}
              >
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    {c.scoreType} {c.score}
                    {c.scoreType === 'CSAT' && '/5'}
                    {c.scoreType === 'NPS' && '/10'}
                  </span>
                  <span>{new Date(c.respondedAt).toLocaleString(localeFor(lang))}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm">{c.comment}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CsatKpiCard({
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
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-3xl font-bold tabular-nums ${valueClass ?? ''}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function SlaTab({ data }: { data: SlaReport }) {
  const { t, lang } = useT();
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
        {t('reports.sla.targets_before')} <strong>{thresholds.firstResponseMin}min</strong>{' '}
        {t('reports.sla.targets_rt')} <strong>{thresholds.resolutionMin}min</strong>.{' '}
        {t('reports.sla.targets_configure')}{' '}
        <a href="/settings/sla" className="font-medium underline">
          {t('reports.sla.targets_link')}
        </a>
        .
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <SlaKpiCard
          label={t('reports.sla.conversations_period')}
          value={summary.totalConversations.toLocaleString(localeFor(lang))}
        />
        <SlaKpiCard
          label={t('reports.col.frt_avg')}
          value={summary.frtAvgHuman}
          sub={t('reports.sla.frt_p50_p90', { p50: summary.frtP50Human, p90: summary.frtP90Human })}
        />
        <SlaKpiCard
          label={t('reports.sla.frt_hit_rate')}
          value={summary.frtHitRate != null ? `${summary.frtHitRate}%` : '—'}
          valueClass={hitColor(summary.frtHitRate)}
          sub={t('reports.sla.within', { n: thresholds.firstResponseMin })}
        />
        <SlaKpiCard
          label={t('reports.sla.breached_now')}
          value={summary.currentlyBreached.toLocaleString(localeFor(lang))}
          valueClass={
            summary.currentlyBreached > 0 ? 'text-red-600 dark:text-red-400' : 'text-foreground'
          }
          sub={t('reports.sla.breached_sub')}
        />
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <SlaKpiCard
          label={t('reports.sla.rt_avg')}
          value={summary.rtAvgHuman}
          sub={t('reports.sla.rt_p90', { p90: summary.rtP90Human })}
        />
        <SlaKpiCard
          label={t('reports.sla.rt_hit_rate')}
          value={summary.rtHitRate != null ? `${summary.rtHitRate}%` : '—'}
          valueClass={hitColor(summary.rtHitRate)}
          sub={t('reports.sla.within', { n: thresholds.resolutionMin })}
        />
        <SlaKpiCard
          label={t('reports.sla.rt_p50')}
          value={summary.rtP50 != null ? formatSeconds(summary.rtP50) : '—'}
        />
      </div>

      <div className="rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <h3 className="text-sm font-semibold">{t('reports.section.by_agent')}</h3>
          <p className="text-xs text-muted-foreground">{t('reports.sla.by_agent_sub')}</p>
        </div>
        {agents.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">{t('common.no_data')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left">{t('reports.col.agent')}</th>
                  <th className="px-4 py-2 text-right">{t('reports.col.conversations')}</th>
                  <th className="px-4 py-2 text-right">{t('reports.col.frt_avg')}</th>
                  <th className="px-4 py-2 text-right">{t('reports.col.frt_p90')}</th>
                  <th className="px-4 py-2 text-right">{t('reports.col.frt_hit')}</th>
                  <th className="px-4 py-2 text-right">{t('reports.sla.rt_avg')}</th>
                  <th className="px-4 py-2 text-right">{t('reports.col.rt_hit')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {agents.map((a) => (
                  <tr key={a.userId} className="hover:bg-accent/30">
                    <td className="px-4 py-2">
                      <p className="font-medium">{a.name ?? a.email}</p>
                      {a.name && <p className="text-[11px] text-muted-foreground">{a.email}</p>}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{a.conversations}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatSeconds(a.frtAvg)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatSeconds(a.frtP90)}</td>
                    <td
                      className={`px-4 py-2 text-right tabular-nums font-semibold ${hitColor(a.frtHitRate)}`}
                    >
                      {a.frtHitRate != null ? `${a.frtHitRate}%` : '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {a.rtAvg ? formatSeconds(a.rtAvg) : '—'}
                    </td>
                    <td
                      className={`px-4 py-2 text-right tabular-nums font-semibold ${hitColor(a.rtHitRate)}`}
                    >
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

function setShortcut(days: number, setSince: (v: string) => void, setUntil: (v: string) => void) {
  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
  setSince(toInputDate(since));
  setUntil(toInputDate(until));
}

function OverviewTab({ data }: { data: Overview }) {
  const { t, lang } = useT();
  const currency = useWorkspaceCurrency();
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label={t('reports.col.conversations')}
          value={data.conversations.total}
          icon={MessageCircle}
          accent="blue"
        />
        <KpiCard
          label={t('reports.col.messages')}
          value={data.messages.total}
          subtitle={t('reports.overview.messages_sub', {
            in: data.messages.byDirection.INBOUND ?? 0,
            out: data.messages.byDirection.OUTBOUND ?? 0,
          })}
          icon={MessageCircle}
          accent="slate"
        />
        <KpiCard
          label={t('reports.col.frt_avg')}
          value={data.firstResponseTime.avgHuman}
          subtitle={t('reports.overview.frt_sub', {
            count: data.firstResponseTime.count,
            p90: data.firstResponseTime.p90Human,
          })}
          icon={Clock}
          accent="amber"
        />
        <KpiCard
          label={t('reports.overview.pipeline_conversion')}
          value={data.pipeline.conversionRate !== null ? `${data.pipeline.conversionRate}%` : '—'}
          subtitle={t('reports.overview.pipeline_sub', {
            pos: data.pipeline.positive,
            neg: data.pipeline.negative,
          })}
          icon={TrendingUp}
          accent={
            data.pipeline.conversionRate && data.pipeline.conversionRate >= 50 ? 'emerald' : 'slate'
          }
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-lg border bg-card p-5">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t('reports.overview.by_status')}
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
            {t('reports.overview.pipeline')}
          </h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-md bg-emerald-50 px-3 py-2 ring-1 ring-emerald-100">
              <span className="flex items-center gap-2 text-sm">
                <TrendingUp className="h-4 w-4 text-emerald-600" />
                {t('reports.overview.positive')}
              </span>
              <div className="text-right">
                <p className="text-lg font-bold text-emerald-700">{data.pipeline.positive}</p>
                {data.pipeline.positiveValue > 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    {formatMoney(data.pipeline.positiveValue, lang, currency)}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md bg-red-50 px-3 py-2 ring-1 ring-red-100">
              <span className="flex items-center gap-2 text-sm">
                <TrendingDown className="h-4 w-4 text-red-600" />
                {t('reports.overview.negative')}
              </span>
              <div className="text-right">
                <p className="text-lg font-bold text-red-700">{data.pipeline.negative}</p>
                {data.pipeline.negativeValue > 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    {formatMoney(data.pipeline.negativeValue, lang, currency)}
                  </p>
                )}
              </div>
            </div>
            {data.pipeline.conversionRate !== null && (
              <div className="mt-4">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium uppercase tracking-wider text-muted-foreground">
                    {t('reports.overview.conversion_rate')}
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
          {t('reports.overview.frt_title')}
        </h3>
        <div className="grid grid-cols-3 gap-4">
          <Stat label={t('reports.overview.stat_avg')} value={data.firstResponseTime.avgHuman} />
          <Stat label={t('reports.overview.stat_median')} value={data.firstResponseTime.p50Human} />
          <Stat label="p90" value={data.firstResponseTime.p90Human} />
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          {t('reports.overview.frt_note', { count: data.firstResponseTime.count })}
        </p>
      </div>
    </div>
  );
}

function AgentsTab({ rows }: { rows: AgentRow[] }) {
  const { t } = useT();
  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <th className="px-4 py-2.5">{t('reports.col.agent')}</th>
            <th className="px-4 py-2.5">{t('common.role')}</th>
            <th className="px-4 py-2.5 text-right">{t('reports.col.conversations')}</th>
            <th className="px-4 py-2.5 text-right">{t('reports.col.open')}</th>
            <th className="px-4 py-2.5 text-right">{t('reports.col.resolved')}</th>
            <th className="px-4 py-2.5 text-right">{t('reports.col.frt_avg')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                {t('reports.empty_period')}
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
  const { t } = useT();
  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <th className="px-4 py-2.5">Inbox</th>
            <th className="px-4 py-2.5 text-right">{t('reports.col.conversations')}</th>
            <th className="px-4 py-2.5 text-right">{t('reports.col.messages')}</th>
            <th className="px-4 py-2.5 text-right">{t('reports.col.open')}</th>
            <th className="px-4 py-2.5 text-right">{t('reports.col.resolved')}</th>
            <th className="px-4 py-2.5 text-right">{t('reports.col.frt_avg')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                {t('reports.empty_period')}
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
        <div
          className={`flex h-9 w-9 items-center justify-center rounded-lg ring-1 ${ACCENT_BG[accent]}`}
        >
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </div>
  );
}

// Prevent unused import warning for Users
void Users;
