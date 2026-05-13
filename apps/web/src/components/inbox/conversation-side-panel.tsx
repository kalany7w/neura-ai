'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  History,
  LayoutGrid,
  MessageCircle,
  Phone,
  Tag,
  User,
} from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';

interface Contact {
  id: string;
  name: string | null;
  phoneNumber: string;
  avatarUrl: string | null;
  customAttrs: Record<string, unknown> | null;
  createdAt: string;
  labels: Array<{ label: { id: string; name: string; color: string } }>;
  conversations: Array<{
    id: string;
    status: string;
    lastMessageAt: string | null;
    lastMessagePreview: string | null;
    unreadCount: number;
    inbox: { id: string; name: string };
  }>;
}

interface CardItem {
  id: string;
  title: string;
  value: string | null;
  funnel: { id: string; name: string };
  stage: { id: string; name: string; color: string; outcome: 'POSITIVE' | 'NEGATIVE' | 'RISK' | null };
}

interface ContactDetailResponse {
  contact: Contact;
  cards: CardItem[];
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

const STATUS_BADGE_CLASS: Record<string, string> = {
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
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(iso).toLocaleDateString('pt-BR');
}

export function ConversationSidePanel({
  contactId,
  currentConversationId,
}: {
  contactId: string;
  currentConversationId: string;
}) {
  const { data, isLoading } = useQuery<ContactDetailResponse>({
    queryKey: ['contact-detail', contactId],
    queryFn: () => api(`/api/contacts/${contactId}`),
    enabled: !!contactId,
  });

  if (isLoading) {
    return (
      <aside className="w-80 shrink-0 border-l bg-card/30 p-4">
        <p className="text-xs text-muted-foreground">Carregando…</p>
      </aside>
    );
  }
  if (!data) return null;

  const { contact, cards } = data;
  const previousConversations = contact.conversations.filter((c) => c.id !== currentConversationId);

  return (
    <aside className="w-80 shrink-0 border-l bg-card/30 overflow-y-auto">
      <div className="space-y-5 p-4">
        {/* Contato */}
        <section>
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-slate-200 to-slate-300 text-sm font-semibold text-slate-700 ring-2 ring-card">
              {initialsFrom(contact.name ?? contact.phoneNumber)}
            </div>
            <div className="min-w-0 flex-1">
              <Link
                href={`/contacts/${contact.id}`}
                className="block truncate font-semibold hover:underline"
                title="Ver detalhe do contato"
              >
                {contact.name ?? 'Sem nome'}
              </Link>
              <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                <Phone className="h-3 w-3" />
                {contact.phoneNumber}
              </p>
            </div>
            <Link
              href={`/contacts/${contact.id}`}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Abrir detalhe completo"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          </div>
          {contact.labels.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {contact.labels.map((cl) => (
                <span
                  key={cl.label.id}
                  style={{
                    backgroundColor: cl.label.color + '22',
                    color: cl.label.color,
                    borderColor: cl.label.color + '50',
                  }}
                  className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium"
                >
                  <Tag className="h-2.5 w-2.5" />
                  {cl.label.name}
                </span>
              ))}
            </div>
          )}
        </section>

        {/* Cards kanban vinculados */}
        {cards.length > 0 && (
          <Collapsible
            title="Cards no kanban"
            count={cards.length}
            icon={LayoutGrid}
            defaultOpen
          >
            <ul className="space-y-1.5">
              {cards.map((card) => {
                const accent = card.stage.outcome
                  ? OUTCOME_COLOR[card.stage.outcome]
                  : card.stage.color;
                return (
                  <li key={card.id}>
                    <Link
                      href={`/kanban?card=${card.id}`}
                      className="block rounded-md border bg-background p-2 text-xs hover:bg-accent"
                    >
                      <p className="truncate font-medium">{card.title}</p>
                      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: accent }} />
                        <span>{card.funnel.name}</span>
                        <ChevronRight className="h-2.5 w-2.5" />
                        <span>{card.stage.name}</span>
                      </div>
                      {card.value && Number(card.value) > 0 && (
                        <p className="mt-1 text-[11px] font-semibold text-emerald-600">
                          {formatBRL(Number(card.value))}
                        </p>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Collapsible>
        )}

        {/* Conversas anteriores */}
        <Collapsible
          title="Conversas anteriores"
          count={previousConversations.length}
          icon={History}
          defaultOpen={previousConversations.length > 0}
        >
          {previousConversations.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Esta é a primeira conversa com este contato.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {previousConversations.slice(0, 8).map((conv) => (
                <li key={conv.id}>
                  <Link
                    href={`/inbox/${conv.id}`}
                    className="block rounded-md border bg-background p-2 text-xs hover:bg-accent"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`inline-flex rounded-full px-1.5 py-0.5 text-[9px] font-medium ${
                          STATUS_BADGE_CLASS[conv.status] ?? 'bg-muted'
                        }`}
                      >
                        {STATUS_LABELS[conv.status] ?? conv.status}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {formatRelative(conv.lastMessageAt)}
                      </span>
                    </div>
                    {conv.lastMessagePreview && (
                      <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                        {conv.lastMessagePreview}
                      </p>
                    )}
                    <p className="mt-1 truncate text-[10px] text-muted-foreground">
                      {conv.inbox.name}
                      {conv.unreadCount > 0 && (
                        <span className="ml-1 rounded-full bg-primary px-1.5 text-[9px] text-primary-foreground">
                          {conv.unreadCount}
                        </span>
                      )}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Collapsible>

        {/* Custom attrs */}
        {contact.customAttrs && Object.keys(contact.customAttrs).length > 0 && (
          <Collapsible title="Atributos" count={Object.keys(contact.customAttrs).length} icon={User}>
            <dl className="space-y-1.5 text-xs">
              {Object.entries(contact.customAttrs).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2 border-b py-1 last:border-0">
                  <dt className="font-medium text-muted-foreground">{k}</dt>
                  <dd className="truncate">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
                </div>
              ))}
            </dl>
          </Collapsible>
        )}

        <p className="border-t pt-3 text-[10px] text-muted-foreground">
          Contato adicionado em{' '}
          {new Date(contact.createdAt).toLocaleDateString('pt-BR')}
        </p>
      </div>
    </aside>
  );
}

function Collapsible({
  title,
  count,
  icon: Icon,
  defaultOpen = false,
  children,
}: {
  title: string;
  count?: number;
  icon: React.ComponentType<{ className?: string }>;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mb-2 flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        <Icon className="h-3 w-3" />
        <span>{title}</span>
        {count !== undefined && (
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium">
            {count}
          </span>
        )}
        <ChevronDown
          className={`ml-auto h-3 w-3 transition ${open ? '' : '-rotate-90'}`}
        />
      </button>
      {open && children}
    </section>
  );
}

interface ConversationStatusSwitcherProps {
  conversationId: string;
  currentStatus: string;
  currentAssigneeId: string | null;
  members: Array<{ userId: string; user: { name: string | null; email: string } }>;
  onUpdated?: () => void;
}

export function ConversationStatusSwitcher({
  conversationId,
  currentStatus,
  currentAssigneeId,
  members,
  onUpdated,
}: ConversationStatusSwitcherProps) {
  // Placeholder if needed externally; not used here since logic moved to inline header
  return null;
}
