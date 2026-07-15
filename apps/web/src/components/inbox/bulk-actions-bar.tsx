'use client';

import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Archive,
  ArchiveRestore,
  CircleDot,
  Tag,
  UserCheck,
  UserMinus,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface LabelItem {
  id: string;
  name: string;
  color: string;
}

interface AgentRef {
  userId: string;
  name: string | null;
  email: string;
}

type Role = 'ADMIN' | 'SUPERVISOR' | 'AGENT';

interface Props {
  selectedIds: string[];
  labels: LabelItem[];
  agents: AgentRef[];
  role: Role;
  tab: 'ARCHIVED' | string;
  onClear: () => void;
}

const STATUS_OPTS: Array<{ value: 'OPEN' | 'PENDING' | 'RESOLVED' | 'SNOOZED'; labelKey: string }> = [
  { value: 'OPEN', labelKey: 'c_inbox_bulk_actions_bar.status_open' },
  { value: 'PENDING', labelKey: 'c_inbox_bulk_actions_bar.status_pending' },
  { value: 'RESOLVED', labelKey: 'c_inbox_bulk_actions_bar.status_resolved' },
];

export function InboxBulkActionsBar({
  selectedIds,
  labels,
  agents,
  role,
  tab,
  onClear,
}: Props) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { t } = useT();
  const canManageStatus = role !== 'AGENT';

  async function run(payload: Record<string, unknown>, successMsg?: string) {
    try {
      const res = await api<{ affected: number }>(`/api/conversations/bulk`, {
        method: 'POST',
        body: JSON.stringify({ ...payload, conversationIds: selectedIds }),
      });
      toast.success(successMsg ?? t('c_inbox_bulk_actions_bar.updated_toast', { n: res.affected }));
      onClear();
      await qc.invalidateQueries({ queryKey: ['conversations'] });
      await qc.invalidateQueries({ queryKey: ['conversations-counts'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  async function archive() {
    if (
      !(await confirm({
        title: t('c_inbox_bulk_actions_bar.archive_confirm_title', { n: selectedIds.length }),
        description: t('c_inbox_bulk_actions_bar.archive_confirm_desc'),
        confirmLabel: t('c_inbox_bulk_actions_bar.archive'),
      }))
    )
      return;
    run({ action: 'archive' }, t('c_inbox_bulk_actions_bar.archived_toast', { n: selectedIds.length }));
  }

  function unarchive() {
    run({ action: 'unarchive' }, t('c_inbox_bulk_actions_bar.unarchived_toast', { n: selectedIds.length }));
  }

  if (selectedIds.length === 0) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex flex-wrap items-center gap-2 rounded-xl border bg-card px-3 py-2 shadow-lg ring-1 ring-foreground/5 -translate-x-1/2">
      <span className="rounded-full bg-foreground px-2.5 py-0.5 text-xs font-bold text-background">
        {selectedIds.length}
      </span>
      <span className="text-sm font-medium">{t('c_inbox_bulk_actions_bar.selected')}</span>
      <div className="ml-2 h-5 w-px bg-border" />

      {/* Atribuir agente */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline">
            <UserCheck className="h-3.5 w-3.5" />
            {t('c_inbox_bulk_actions_bar.assign_agent')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
          <DropdownMenuItem onSelect={() => run({ action: 'assign_agent', agentId: null })}>
            <UserMinus className="h-3.5 w-3.5" />
            {t('c_inbox_bulk_actions_bar.no_agent')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {agents.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('c_inbox_bulk_actions_bar.no_agents')}</p>
          ) : (
            agents.map((a) => (
              <DropdownMenuItem
                key={a.userId}
                onSelect={() => run({ action: 'assign_agent', agentId: a.userId })}
              >
                <UserCheck className="h-3.5 w-3.5" />
                {a.name?.trim() || a.email}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Etiquetas */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline">
            <Tag className="h-3.5 w-3.5" />
            {t('c_inbox_bulk_actions_bar.label')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
          <DropdownMenuLabel>{t('c_inbox_bulk_actions_bar.apply')}</DropdownMenuLabel>
          {labels.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('c_inbox_bulk_actions_bar.no_labels')}</p>
          ) : (
            labels.map((l) => (
              <DropdownMenuItem
                key={l.id}
                onSelect={() => run({ action: 'apply_label', labelId: l.id })}
              >
                <span className="h-3 w-3 rounded-full" style={{ backgroundColor: l.color }} />
                {l.name}
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t('c_inbox_bulk_actions_bar.remove')}</DropdownMenuLabel>
          {labels.map((l) => (
            <DropdownMenuItem
              key={`u-${l.id}`}
              onSelect={() => run({ action: 'unapply_label', labelId: l.id })}
            >
              <span
                className="h-3 w-3 rounded-full opacity-50"
                style={{ backgroundColor: l.color }}
              />
              {t('c_inbox_bulk_actions_bar.remove_label', { name: l.name })}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Status (não-AGENT) */}
      {canManageStatus && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline">
              <CircleDot className="h-3.5 w-3.5" />
              {t('common.status')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {STATUS_OPTS.map((s) => (
              <DropdownMenuItem
                key={s.value}
                onSelect={() => run({ action: 'set_status', status: s.value })}
              >
                {t(s.labelKey)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Arquivar/Desarquivar (não-AGENT) */}
      {canManageStatus &&
        (tab === 'ARCHIVED' ? (
          <Button size="sm" variant="outline" onClick={unarchive}>
            <ArchiveRestore className="h-3.5 w-3.5" />
            {t('c_inbox_bulk_actions_bar.unarchive')}
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={archive}>
            <Archive className="h-3.5 w-3.5" />
            {t('c_inbox_bulk_actions_bar.archive')}
          </Button>
        ))}

      <div className="ml-2 h-5 w-px bg-border" />
      <Button size="sm" variant="ghost" onClick={onClear} title={t('c_inbox_bulk_actions_bar.clear_selection')}>
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
