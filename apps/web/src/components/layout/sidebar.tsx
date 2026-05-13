'use client';

import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  MessageCircle,
  LayoutGrid,
  Users,
  Inbox,
  FileText,
  Tag,
  UserCog,
  LogOut,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { signOut } from '@/lib/auth-client';
import { useRealtimeStore } from '@/lib/realtime-store';
import { cn } from '@/lib/utils';

type Role = 'ADMIN' | 'SUPERVISOR' | 'AGENT';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  roles?: Role[];
}

interface NavGroup {
  label?: string;
  items: NavItem[];
}

const groups: NavGroup[] = [
  {
    items: [{ href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    label: 'Operação',
    items: [
      { href: '/inbox', label: 'Conversas', icon: MessageCircle },
      { href: '/kanban', label: 'Kanban', icon: LayoutGrid },
    ],
  },
  {
    label: 'Gestão',
    items: [
      { href: '/contacts', label: 'Contatos', icon: Users },
      { href: '/inboxes', label: 'Inboxes', icon: Inbox },
    ],
  },
  {
    label: 'Configurações',
    items: [
      { href: '/settings/templates', label: 'Templates', icon: FileText },
      { href: '/settings/labels', label: 'Etiquetas', icon: Tag, roles: ['ADMIN'] },
      { href: '/settings/members', label: 'Membros', icon: UserCog, roles: ['ADMIN'] },
    ],
  },
];

interface User {
  id: string;
  name?: string | null;
  email: string;
}

interface SidebarProps {
  user: User;
  workspace?: { name: string; role: Role } | null;
}

export function Sidebar({ user, workspace }: SidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const wsState = useRealtimeStore((s) => s.state);
  const role = workspace?.role;

  const initials = (user.name ?? user.email)
    .split(/[\s.@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('');

  async function handleSignOut() {
    await signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-card">
      {/* Brand + workspace */}
      <div className="border-b px-4 py-3.5">
        <Link href="/dashboard" className="block">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <span className="text-xs font-bold">N</span>
            </div>
            <span className="font-semibold tracking-tight">Neura AI</span>
          </div>
        </Link>
        {workspace && (
          <div className="mt-2 flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{workspace.name}</p>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {workspace.role.toLowerCase()}
              </p>
            </div>
            <div
              title={
                wsState === 'open'
                  ? 'Tempo real conectado'
                  : wsState === 'connecting'
                    ? 'Conectando…'
                    : 'Desconectado'
              }
            >
              {wsState === 'open' ? (
                <Wifi className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <WifiOff className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
        {groups.map((group, idx) => {
          const visibleItems = group.items.filter(
            (item) => !item.roles || (role && item.roles.includes(role)),
          );
          if (visibleItems.length === 0) return null;
          return (
            <div key={idx}>
              {group.label && (
                <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </p>
              )}
              <ul className="space-y-0.5">
                {visibleItems.map((item) => {
                  const Icon = item.icon;
                  const active =
                    pathname === item.href || pathname.startsWith(item.href + '/');
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={cn(
                          'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
                          active
                            ? 'bg-accent font-medium text-accent-foreground'
                            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      {/* User footer */}
      <div className="border-t p-2">
        <div className="flex items-center gap-2 rounded-md p-1.5 hover:bg-muted/50">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
            {initials || '?'}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{user.name ?? 'Sem nome'}</p>
            <p className="truncate text-[11px] text-muted-foreground">{user.email}</p>
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            title="Sair"
            className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
