'use client';

import { useQuery } from '@tanstack/react-query';
import { Phone, Mail } from 'lucide-react';
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

        {/* Sections T5-T9 a serem preenchidas */}
      </div>
    </aside>
  );
}
