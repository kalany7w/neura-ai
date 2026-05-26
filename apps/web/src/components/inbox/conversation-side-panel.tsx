'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { SlaBadge } from './sla-badge';

export interface LeadDetail {
  conversation: {
    id: string;
    status: string;
    assignedAgentId: string | null;
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
    aiSummary: string | null;
    aiSummaryAt: string | null;
    isAwaitingWelcomeChoice: boolean;
    welcomeAttempts: number;
    welcomeFallbackSent: boolean;
    inbox: { id: string; name: string };
    labels: Array<{ id: string; name: string; color: string }>;
  };
  contact: {
    id: string;
    name: string | null;
    phoneNumber: string;
    email: string | null;
    avatarUrl: string | null;
    customAttrs: Record<string, unknown> | null;
    welcomeRespondedAt: string | null;
    labels: Array<{ label: { id: string; name: string; color: string } }>;
  };
  card: {
    id: string;
    title: string;
    value: string | null;
    funnel: { id: string; name: string };
    stage: { id: string; name: string; color: string; outcome: 'POSITIVE' | 'NEGATIVE' | 'RISK' | null };
    products: Array<{ id: string; name: string; price: string | null; quantity: number }>;
  } | null;
  customAttributeDefs: Array<{
    id: string;
    key: string;
    label: string;
    type: 'STRING' | 'NUMBER' | 'DATE' | 'SELECT';
    options: string[] | null;
  }>;
  allLabels: Array<{ id: string; name: string; color: string; scope: string }>;
  funnels: Array<{ id: string; name: string; stages: Array<{ id: string; name: string; order: number }> }>;
  temperature: 'CALIENTE' | 'TIBIO' | 'FRIO';
}

function initialsFrom(s: string | null | undefined): string {
  if (!s) return '?';
  return s.split(/[\s.@]/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('');
}

export function ConversationSidePanel({ conversationId }: { conversationId: string }) {
  const { data, isLoading } = useQuery<LeadDetail>({
    queryKey: ['lead-detail', conversationId],
    queryFn: () => api(`/api/conversations/${conversationId}/lead-detail`),
    enabled: !!conversationId,
  });

  const qc = useQueryClient();
  const moveStageMut = useMutation({
    mutationFn: (stageId: string) =>
      api(`/api/kanban/cards/${data?.card?.id}/move`, {
        method: 'POST',
        body: JSON.stringify({ stageId, position: 0 }),
      }),
    onSuccess: () => {
      toast.success('Etapa atualizada');
      qc.invalidateQueries({ queryKey: ['lead-detail', conversationId] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Erro ao mover'),
  });

  if (isLoading) {
    return (
      <aside className="w-80 shrink-0 border-l bg-card/30 p-4">
        <div className="space-y-3 animate-pulse">
          <div className="h-12 w-12 rounded-full bg-muted" />
          <div className="h-4 w-32 rounded bg-muted" />
          <div className="h-3 w-24 rounded bg-muted" />
        </div>
      </aside>
    );
  }
  if (!data) return null;

  const { contact, temperature } = data;
  const title = contact.name ?? contact.phoneNumber;

  return (
    <aside className="w-80 shrink-0 border-l bg-card/30 overflow-y-auto">
      <div className="space-y-4 p-4">
        {/* Header */}
        <section>
          <div className="flex items-start gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-slate-200 to-slate-300 text-sm font-semibold text-slate-700">
              {initialsFrom(title)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{title}</p>
              <a
                href={`tel:${contact.phoneNumber}`}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Phone className="h-3 w-3" />
                {contact.phoneNumber}
              </a>
              {contact.email && (
                <a
                  href={`mailto:${contact.email}`}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  <Mail className="h-3 w-3" />
                  {contact.email}
                </a>
              )}
              <div className="mt-1.5">
                <SlaBadge temperature={temperature} />
              </div>
            </div>
          </div>
        </section>

        {data.card && (
          <section className="rounded-md border bg-card p-3 space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Embudo
            </p>
            <p className="text-sm font-medium">{data.card.funnel.name}</p>
            <select
              className="w-full rounded border bg-background px-2 py-1.5 text-sm"
              value={data.card.stage.id}
              onChange={(e) => moveStageMut.mutate(e.target.value)}
              disabled={moveStageMut.isPending}
            >
              {(data.funnels.find((f) => f.id === data.card!.funnel.id)?.stages ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            {data.card.value && (
              <p className="text-xs text-muted-foreground">
                Valor: <span className="font-medium text-foreground">{data.card.value}</span>
              </p>
            )}
          </section>
        )}

        {data.customAttributeDefs.length > 0 && (
          <CustomAttrsSection
            defs={data.customAttributeDefs}
            values={data.contact.customAttrs ?? {}}
            conversationId={conversationId}
          />
        )}

        {/* Sections T6-T9 a serem preenchidas */}
      </div>
    </aside>
  );
}

interface CustomAttrsSectionProps {
  defs: LeadDetail['customAttributeDefs'];
  values: Record<string, unknown>;
  conversationId: string;
}

function CustomAttrsSection({ defs, values, conversationId }: CustomAttrsSectionProps) {
  const qc = useQueryClient();
  const [local, setLocal] = useState<Record<string, unknown>>(values);

  const saveMut = useMutation({
    mutationFn: (next: Record<string, unknown>) =>
      api(`/api/conversations/${conversationId}/contact`, {
        method: 'PATCH',
        body: JSON.stringify({ customAttrs: next }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lead-detail', conversationId] }),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Erro ao salvar atributo'),
  });

  function updateField(key: string, value: unknown) {
    const next = { ...local, [key]: value };
    setLocal(next);
    saveMut.mutate(next);
  }

  return (
    <section className="rounded-md border bg-card p-3 space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Atributos
      </p>
      {defs.map((def) => {
        const current = local[def.key];
        if (def.type === 'SELECT' && def.options) {
          return (
            <div key={def.id} className="space-y-1">
              <label className="text-xs">{def.label}</label>
              <select
                className="w-full rounded border bg-background px-2 py-1 text-sm"
                value={typeof current === 'string' ? current : ''}
                onChange={(e) => updateField(def.key, e.target.value || null)}
              >
                <option value="">—</option>
                {def.options.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </div>
          );
        }
        if (def.type === 'NUMBER') {
          return (
            <div key={def.id} className="space-y-1">
              <label className="text-xs">{def.label}</label>
              <input
                type="number"
                className="w-full rounded border bg-background px-2 py-1 text-sm"
                value={typeof current === 'number' ? current : ''}
                onChange={(e) => updateField(def.key, e.target.value ? Number(e.target.value) : null)}
              />
            </div>
          );
        }
        if (def.type === 'DATE') {
          return (
            <div key={def.id} className="space-y-1">
              <label className="text-xs">{def.label}</label>
              <input
                type="date"
                className="w-full rounded border bg-background px-2 py-1 text-sm"
                value={typeof current === 'string' ? current : ''}
                onChange={(e) => updateField(def.key, e.target.value || null)}
              />
            </div>
          );
        }
        // STRING (default)
        return (
          <div key={def.id} className="space-y-1">
            <label className="text-xs">{def.label}</label>
            <input
              type="text"
              className="w-full rounded border bg-background px-2 py-1 text-sm"
              value={typeof current === 'string' ? current : ''}
              onChange={(e) => setLocal({ ...local, [def.key]: e.target.value || null })}
              onBlur={(e) => saveMut.mutate({ ...local, [def.key]: e.target.value || null })}
            />
          </div>
        );
      })}
    </section>
  );
}
