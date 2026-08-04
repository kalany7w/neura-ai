'use client';

import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Tag, Trash2, X } from 'lucide-react';
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

interface Props {
  selectedIds: string[];
  labels: LabelItem[];
  onClear: () => void;
}

export function ContactsBulkActionsBar({ selectedIds, labels, onClear }: Props) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { t } = useT();

  async function run(payload: Record<string, unknown>) {
    try {
      const res = await api<{ affected: number }>(`/api/contacts/bulk`, {
        method: 'POST',
        body: JSON.stringify({ ...payload, contactIds: selectedIds }),
      });
      toast.success(t('c_contacts_bulk_actions_bar.updated_toast', { n: res.affected }));
      onClear();
      await qc.invalidateQueries({ queryKey: ['contacts'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  async function remove() {
    if (
      !(await confirm({
        title: t('c_contacts_bulk_actions_bar.delete_title', { n: selectedIds.length }),
        description: t('c_contacts_bulk_actions_bar.delete_description'),
        confirmLabel: t('action.delete'),
        destructive: true,
      }))
    )
      return;
    run({ action: 'delete' });
  }

  if (selectedIds.length === 0) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-xl border bg-card px-3 py-2 shadow-lg ring-1 ring-foreground/5">
      <span className="rounded-full bg-foreground px-2.5 py-0.5 text-xs font-bold text-background">
        {selectedIds.length}
      </span>
      <span className="text-sm font-medium">{t('c_contacts_bulk_actions_bar.selected')}</span>
      <div className="ml-2 h-5 w-px bg-border" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline">
            <Tag className="h-3.5 w-3.5" />
            {t('c_contacts_bulk_actions_bar.apply_label')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
          <DropdownMenuLabel>{t('c_contacts_bulk_actions_bar.apply')}</DropdownMenuLabel>
          {labels.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {t('c_contacts_bulk_actions_bar.no_labels')}
            </p>
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
          <DropdownMenuLabel>
            {t('c_contacts_bulk_actions_bar.remove_label_header')}
          </DropdownMenuLabel>
          {labels.map((l) => (
            <DropdownMenuItem
              key={`u-${l.id}`}
              onSelect={() => run({ action: 'unapply_label', labelId: l.id })}
            >
              <span
                className="h-3 w-3 rounded-full opacity-50"
                style={{ backgroundColor: l.color }}
              />
              {t('c_contacts_bulk_actions_bar.remove_named', { name: l.name })}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        size="sm"
        variant="ghost"
        onClick={remove}
        title={t('c_contacts_bulk_actions_bar.delete_selected')}
      >
        <Trash2 className="h-3.5 w-3.5 text-destructive" />
      </Button>

      <div className="ml-2 h-5 w-px bg-border" />
      <Button
        size="sm"
        variant="ghost"
        onClick={onClear}
        title={t('c_contacts_bulk_actions_bar.clear_selection')}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
