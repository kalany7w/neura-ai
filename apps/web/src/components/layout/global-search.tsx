'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronRight,
  LayoutGrid,
  MessageCircle,
  Phone,
  Search as SearchIcon,
  Users,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';

interface ContactHit {
  id: string;
  name: string | null;
  phoneNumber: string;
  avatarUrl: string | null;
}

interface ConversationHit {
  id: string;
  status: string;
  contact: { id: string; name: string | null; phoneNumber: string };
  inbox: { name: string };
}

interface CardHit {
  id: string;
  title: string;
  funnel: { id: string; name: string };
  stage: { id: string; name: string; color: string; outcome: 'POSITIVE' | 'NEGATIVE' | 'RISK' | null };
}

interface SearchResp {
  contacts: ContactHit[];
  conversations: ConversationHit[];
  cards: CardHit[];
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

export function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data } = useQuery<SearchResp>({
    queryKey: ['search', q],
    queryFn: () => api(`/api/search?q=${encodeURIComponent(q)}`),
    enabled: q.length >= 2,
    staleTime: 30_000,
  });

  // Cmd/Ctrl+K abre o input
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
      if (e.key === 'Escape') {
        setOpen(false);
        inputRef.current?.blur();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Click outside fecha
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const hasResults =
    !!data &&
    (data.contacts.length > 0 ||
      data.conversations.length > 0 ||
      data.cards.length > 0);

  function go(href: string) {
    router.push(href);
    setOpen(false);
    setQ('');
  }

  return (
    <div ref={containerRef} className="relative w-64">
      <SearchIcon className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
      <input
        ref={inputRef}
        type="text"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Buscar… (⌘K)"
        className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-7 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
      {q && (
        <button
          type="button"
          onClick={() => {
            setQ('');
            inputRef.current?.focus();
          }}
          className="absolute right-1.5 top-1.5 rounded p-0.5 text-muted-foreground hover:bg-muted"
        >
          <X className="h-3 w-3" />
        </button>
      )}

      {open && q.length >= 2 && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-96 overflow-y-auto rounded-md border bg-popover shadow-lg">
          {!hasResults ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              Nenhum resultado pra “{q}”.
            </p>
          ) : (
            <>
              {data!.conversations.length > 0 && (
                <Section icon={MessageCircle} label="Conversas">
                  {data!.conversations.map((conv) => (
                    <ResultRow
                      key={conv.id}
                      onClick={() => go(`/inbox/${conv.id}`)}
                      icon={
                        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-slate-200 to-slate-300 text-[10px] font-semibold text-slate-700">
                          {initialsFrom(conv.contact.name ?? conv.contact.phoneNumber)}
                        </div>
                      }
                      title={conv.contact.name ?? conv.contact.phoneNumber}
                      subtitle={`${conv.inbox.name} · ${conv.status}`}
                    />
                  ))}
                </Section>
              )}

              {data!.contacts.length > 0 && (
                <Section icon={Users} label="Contatos">
                  {data!.contacts.map((c) => (
                    <ResultRow
                      key={c.id}
                      onClick={() => go(`/contacts/${c.id}`)}
                      icon={
                        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-slate-200 to-slate-300 text-[10px] font-semibold text-slate-700">
                          {initialsFrom(c.name ?? c.phoneNumber)}
                        </div>
                      }
                      title={c.name ?? c.phoneNumber}
                      subtitle={
                        <span className="flex items-center gap-1 text-[11px]">
                          <Phone className="h-2.5 w-2.5" />
                          {c.phoneNumber}
                        </span>
                      }
                    />
                  ))}
                </Section>
              )}

              {data!.cards.length > 0 && (
                <Section icon={LayoutGrid} label="Cards no kanban">
                  {data!.cards.map((card) => {
                    const accent =
                      card.stage.outcome === 'POSITIVE'
                        ? '#10b981'
                        : card.stage.outcome === 'NEGATIVE'
                          ? '#ef4444'
                          : card.stage.outcome === 'RISK'
                            ? '#f59e0b'
                            : card.stage.color;
                    return (
                      <ResultRow
                        key={card.id}
                        onClick={() => go('/kanban')}
                        icon={
                          <span
                            className="flex h-7 w-7 items-center justify-center rounded-md text-white"
                            style={{ backgroundColor: accent }}
                          >
                            <LayoutGrid className="h-3.5 w-3.5" />
                          </span>
                        }
                        title={card.title}
                        subtitle={
                          <span className="flex items-center gap-1 text-[11px]">
                            {card.funnel.name}
                            <ChevronRight className="h-2.5 w-2.5" />
                            {card.stage.name}
                          </span>
                        }
                      />
                    );
                  })}
                </Section>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b last:border-0">
      <p className="flex items-center gap-1.5 bg-muted/40 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </p>
      <ul>{children}</ul>
    </div>
  );
}

function ResultRow({
  onClick,
  icon,
  title,
  subtitle,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle: React.ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-accent"
      >
        <div className="shrink-0">{icon}</div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{title}</p>
          <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
        </div>
      </button>
    </li>
  );
}
