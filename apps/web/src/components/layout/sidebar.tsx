'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { realtimeClient } from '@/lib/ws-client';
import {
  LayoutDashboard,
  MessageCircle,
  LayoutGrid,
  CalendarDays,
  Users,
  Inbox,
  FileText,
  Tag,
  UserCog,
  LogOut,
  Wifi,
  WifiOff,
  Settings,
  Zap,
  Bot,
  BarChart3,
  Key,
  ScrollText,
  Timer,
  BookOpen,
  Smile,
  MessageSquarePlus,
  Upload,
} from 'lucide-react';
import { signOut } from '@/lib/auth-client';
import { useRealtimeStore } from '@/lib/realtime-store';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { ThemeToggle } from '@/components/theme-toggle';
import { TeamPresence } from '@/components/layout/team-presence';
import { LanguageSwitcher } from '@/components/layout/language-switcher';
import { useT } from '@/lib/i18n';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Check, ChevronDown, Plus } from 'lucide-react';

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

// NavItem.label = chave i18n. O render usa t(label) — se sem tradução, retorna
// a própria chave (mostra fallback claro tipo "sidebar.dashboard"), facilitando
// detectar strings não-traduzidas em dev.
const groups: NavGroup[] = [
  {
    items: [{ href: '/dashboard', label: 'sidebar.dashboard', icon: LayoutDashboard }],
  },
  {
    label: 'sidebar.group.operation',
    items: [
      { href: '/inbox', label: 'sidebar.conversations', icon: MessageCircle },
      { href: '/kanban', label: 'sidebar.kanban', icon: LayoutGrid },
      { href: '/calendar', label: 'sidebar.calendar', icon: CalendarDays },
    ],
  },
  {
    label: 'sidebar.group.management',
    items: [
      { href: '/contacts', label: 'sidebar.contacts', icon: Users },
      { href: '/inboxes', label: 'sidebar.inboxes', icon: Inbox },
      { href: '/reports', label: 'sidebar.reports', icon: BarChart3 },
    ],
  },
  {
    label: 'sidebar.group.settings',
    items: [
      { href: '/settings/templates', label: 'sidebar.templates', icon: FileText },
      {
        href: '/settings/welcome-flows',
        label: 'sidebar.welcome_flows',
        icon: MessageSquarePlus,
        roles: ['ADMIN', 'SUPERVISOR'],
      },
      { href: '/settings/kb', label: 'sidebar.kb', icon: BookOpen, roles: ['ADMIN', 'SUPERVISOR'] },
      { href: '/settings/labels', label: 'sidebar.labels', icon: Tag, roles: ['ADMIN'] },
      {
        href: '/settings/members',
        label: 'sidebar.members',
        icon: UserCog,
        roles: ['ADMIN', 'SUPERVISOR'],
      },
      { href: '/settings/automations', label: 'sidebar.automations', icon: Bot, roles: ['ADMIN'] },
      { href: '/settings/sla', label: 'sidebar.sla', icon: Timer, roles: ['ADMIN', 'SUPERVISOR'] },
      {
        href: '/settings/csat',
        label: 'sidebar.csat',
        icon: Smile,
        roles: ['ADMIN', 'SUPERVISOR'],
      },
      {
        href: '/settings/integrations',
        label: 'sidebar.integrations',
        icon: Zap,
        roles: ['ADMIN'],
      },
      { href: '/settings/import', label: 'sidebar.import', icon: Upload, roles: ['ADMIN'] },
      {
        href: '/settings/custom-attributes',
        label: 'sidebar.custom_attributes',
        icon: Tag,
        roles: ['ADMIN'],
      },
      { href: '/settings/api-keys', label: 'sidebar.api_keys', icon: Key, roles: ['ADMIN'] },
      { href: '/settings/audit', label: 'sidebar.audit', icon: ScrollText, roles: ['ADMIN'] },
    ],
  },
];

interface User {
  id: string;
  name?: string | null;
  email: string;
}

interface WorkspaceOption {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

interface SidebarProps {
  user: User;
  workspace?: { name: string; role: Role } | null;
  workspaces?: WorkspaceOption[];
  activeWorkspaceId?: string;
}

function RealtimeDot({ state }: { state: string }) {
  const { t } = useT();
  return (
    <div
      title={
        state === 'open'
          ? t('c_layout_sidebar.realtime_connected')
          : state === 'connecting'
            ? t('c_layout_sidebar.realtime_connecting')
            : t('c_layout_sidebar.realtime_disconnected')
      }
    >
      {state === 'open' ? (
        <Wifi className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <WifiOff className="h-3.5 w-3.5 text-muted-foreground" />
      )}
    </div>
  );
}

export function Sidebar({ user, workspace, workspaces, activeWorkspaceId }: SidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const wsState = useRealtimeStore((s) => s.state);
  const role = workspace?.role;
  const hasMultiple = (workspaces?.length ?? 0) > 1;
  const { t } = useT();
  const queryClient = useQueryClient();
  const [isSwitching, setIsSwitching] = useState(false);

  async function switchWorkspace(wsId: string) {
    if (wsId === activeWorkspaceId || isSwitching) return;
    setIsSwitching(true);
    try {
      await api('/api/workspaces/switch', {
        method: 'POST',
        body: JSON.stringify({ workspaceId: wsId }),
      });
      toast.success(t('workspace.switched'));
      // Limpa o cache (dados são por-workspace) e revalida — sem reload de página.
      queryClient.clear();
      // O servidor escopa as subscriptions do WS no upgrade (activeWorkspaceId da
      // sessão) — reconecta pra sair dos canais do workspace antigo e entrar nos novos.
      realtimeClient.disconnect();
      realtimeClient.connect();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('workspace.switch_error'));
    } finally {
      setIsSwitching(false);
    }
  }

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
          <div className="mt-2">
            {hasMultiple ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5 hover:bg-muted"
                  >
                    <div className="min-w-0 flex-1 text-left">
                      <p className="truncate text-xs font-medium">{workspace.name}</p>
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        {workspace.role.toLowerCase()}
                      </p>
                    </div>
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                    <RealtimeDot state={wsState} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuLabel>{t('workspace.your_workspaces')}</DropdownMenuLabel>
                  {workspaces!.map((w) => (
                    <DropdownMenuItem
                      key={w.id}
                      onSelect={() => switchWorkspace(w.id)}
                      className={w.id === activeWorkspaceId ? 'bg-accent/60' : ''}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{w.name}</p>
                        <p className="text-[10px] uppercase text-muted-foreground">
                          {w.role.toLowerCase()}
                        </p>
                      </div>
                      {w.id === activeWorkspaceId && <Check className="h-3.5 w-3.5" />}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => router.push('/onboarding')}>
                    <Plus className="h-3.5 w-3.5" />
                    {t('workspace.new')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{workspace.name}</p>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {workspace.role.toLowerCase()}
                  </p>
                </div>
                <RealtimeDot state={wsState} />
              </div>
            )}
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
                  {t(group.label)}
                </p>
              )}
              <ul className="space-y-0.5">
                {visibleItems.map((item) => {
                  const Icon = item.icon;
                  const active = pathname === item.href || pathname.startsWith(item.href + '/');
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
                        <span className="truncate">{t(item.label)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      {/* Team presence (acima do user footer) */}
      {user.id && (
        <div className="px-3 pb-2">
          <TeamPresence currentUserId={user.id} />
        </div>
      )}

      {/* User footer */}
      <div className="border-t p-2">
        <div className="flex items-center gap-1 rounded-md p-1 hover:bg-muted/50">
          <Link
            href="/settings/profile"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1.5 hover:bg-muted"
            title={t('c_layout_sidebar.my_profile')}
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
              {initials || '?'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {user.name ?? t('c_layout_sidebar.no_name')}
              </p>
              <p className="truncate text-[11px] text-muted-foreground">{user.email}</p>
            </div>
          </Link>
          <LanguageSwitcher />
          <ThemeToggle />
          <Link
            href="/settings/profile"
            title={t('c_layout_sidebar.profile_settings')}
            className="rounded p-1.5 text-muted-foreground hover:bg-background hover:text-foreground"
          >
            <Settings className="h-4 w-4" />
          </Link>
          <button
            type="button"
            onClick={handleSignOut}
            title={t('user.sign_out')}
            className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
