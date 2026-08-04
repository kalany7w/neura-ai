'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { api } from '@/lib/api';
import { useOnlineAgents } from '@/hooks/use-online-agents';

interface MembersResp {
  workspace: {
    members: Array<{
      userId: string;
      role: 'ADMIN' | 'SUPERVISOR' | 'AGENT';
      user: { id: string; name: string | null; email: string; image: string | null };
    }>;
  };
}

function initials(s: string): string {
  return s
    .split(/[\s.@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * Lista compacta de agentes online no workspace ativo. Mostra avatares com dot
 * verde + tooltip do nome. Click vai pra /settings/members. Ocultado quando
 * só o próprio user está online (não tem ninguém pra ver).
 */
export function TeamPresence({ currentUserId }: { currentUserId: string }) {
  const online = useOnlineAgents();
  const { data } = useQuery<MembersResp>({
    queryKey: ['workspace-me'],
    queryFn: () => api('/api/workspaces/me'),
    staleTime: 60_000,
  });
  const members = data?.workspace.members ?? [];
  const onlineMembers = members.filter((m) => online.has(m.userId) && m.userId !== currentUserId);
  if (onlineMembers.length === 0) return null;

  const visible = onlineMembers.slice(0, 4);
  const overflow = onlineMembers.length - visible.length;

  return (
    <Link
      href="/settings/members"
      className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
      title={`${onlineMembers.length} agente${onlineMembers.length > 1 ? 's' : ''} online`}
    >
      <Users className="h-3 w-3" />
      <div className="flex -space-x-1.5">
        {visible.map((m) => {
          const label = m.user.name?.trim() || m.user.email;
          return (
            <span
              key={m.userId}
              title={label}
              className="relative flex h-5 w-5 items-center justify-center rounded-full border-2 border-card bg-gradient-to-br from-indigo-500 to-violet-500 text-[8px] font-semibold uppercase text-white"
            >
              {initials(label)}
              <span className="absolute -bottom-0 -right-0 h-1.5 w-1.5 rounded-full bg-emerald-500 ring-1 ring-card" />
            </span>
          );
        })}
        {overflow > 0 && (
          <span className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-card bg-muted text-[9px] font-semibold text-foreground">
            +{overflow}
          </span>
        )}
      </div>
      <span className="font-medium">{onlineMembers.length} online</span>
    </Link>
  );
}
