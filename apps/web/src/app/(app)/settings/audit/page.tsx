'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ScrollText, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface AuditItem {
  id: string;
  actorId: string | null;
  action: string;
  resource: string | null;
  metadata: unknown;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  actor: { id: string; name: string | null; email: string } | null;
}

interface AuditResp {
  items: AuditItem[];
  total: number;
  page: number;
  perPage: number;
}

const ACTION_BADGE: Record<string, string> = {
  created: 'bg-emerald-100 text-emerald-700',
  updated: 'bg-blue-100 text-blue-700',
  deleted: 'bg-red-100 text-red-700',
  moved: 'bg-amber-100 text-amber-800',
  assigned: 'bg-indigo-100 text-indigo-700',
  invited: 'bg-purple-100 text-purple-700',
  merged: 'bg-cyan-100 text-cyan-700',
  imported: 'bg-violet-100 text-violet-700',
  snoozed: 'bg-slate-100 text-slate-700',
};

function badgeForAction(action: string): string {
  const last = action.split('.').slice(-1)[0]?.split('_')[0] ?? '';
  return ACTION_BADGE[last] ?? 'bg-muted text-foreground';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR');
}

export default function AuditPage() {
  const { t } = useT();
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState('');
  const [resourceFilter, setResourceFilter] = useState('');

  const params = new URLSearchParams({
    page: String(page),
    perPage: '50',
  });
  if (actionFilter) params.set('action', actionFilter);
  if (resourceFilter) params.set('resource', resourceFilter);

  const { data, isLoading } = useQuery<AuditResp>({
    queryKey: ['audit-log', page, actionFilter, resourceFilter],
    queryFn: () => api(`/api/audit-log?${params.toString()}`),
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-3xl font-bold">
          <ScrollText className="h-7 w-7 text-slate-500" />
          {t('page.audit.title')}
        </h1>
        <p className="text-muted-foreground">{t('page.audit.subtitle')}</p>
      </div>

      <div className="flex flex-wrap gap-3 rounded-lg border bg-card p-3">
        <div className="space-y-1.5">
          <Label htmlFor="action-filter" className="text-xs">
            Filtrar por ação
          </Label>
          <Input
            id="action-filter"
            value={actionFilter}
            onChange={(e) => {
              setActionFilter(e.target.value);
              setPage(1);
            }}
            placeholder="ex: card.moved"
            className="w-48 h-8"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="resource-filter" className="text-xs">
            Filtrar por recurso
          </Label>
          <Input
            id="resource-filter"
            value={resourceFilter}
            onChange={(e) => {
              setResourceFilter(e.target.value);
              setPage(1);
            }}
            placeholder="ex: Card:abc"
            className="w-48 h-8"
          />
        </div>
        {(actionFilter || resourceFilter) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setActionFilter('');
              setResourceFilter('');
              setPage(1);
            }}
            className="self-end"
          >
            <X className="h-3.5 w-3.5" />
            Limpar
          </Button>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : !data?.items.length ? (
        <div className="rounded-lg border border-dashed bg-muted/20 p-12 text-center text-sm text-muted-foreground">
          Sem eventos no período/filtros.
        </div>
      ) : (
        <>
          <div className="rounded-lg border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <th className="px-3 py-2.5">Quando</th>
                  <th className="px-3 py-2.5">Quem</th>
                  <th className="px-3 py-2.5">Ação</th>
                  <th className="px-3 py-2.5">Recurso</th>
                  <th className="px-3 py-2.5">Metadata</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((it) => (
                  <tr key={it.id} className="border-t align-top">
                    <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                      {formatDate(it.createdAt)}
                    </td>
                    <td className="px-3 py-2">
                      {it.actor ? (
                        <>
                          <p className="text-xs font-medium">{it.actor.name ?? it.actor.email}</p>
                          <p className="text-[10px] text-muted-foreground">{it.actor.email}</p>
                        </>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">sistema</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${badgeForAction(it.action)}`}
                      >
                        {it.action}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                      {it.resource ?? '—'}
                    </td>
                    <td className="px-3 py-2">
                      {it.metadata ? (
                        <code className="block max-w-md whitespace-pre-wrap break-words text-[10px] text-muted-foreground line-clamp-3">
                          {JSON.stringify(it.metadata)}
                        </code>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {data.total} evento(s) · página {page} de {totalPages}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
