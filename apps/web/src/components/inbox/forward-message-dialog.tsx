'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Forward, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface ConversationListItem {
  id: string;
  contact: { id: string; name: string | null; phoneNumber: string };
  inbox: { id: string; name: string; status?: string };
  status?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  // Aceita 1 ID (compatível) OU array (batch). null/[] desabilita o submit.
  messageId?: string | null;
  messageIds?: string[];
  excludeConversationId?: string;
  onForwarded?: (sentConversationIds: string[]) => void;
}

export function ForwardMessageDialog({
  open,
  onOpenChange,
  messageId,
  messageIds,
  excludeConversationId,
  onForwarded,
}: Props) {
  const { t } = useT();
  const ids: string[] =
    messageIds && messageIds.length > 0 ? messageIds : messageId ? [messageId] : [];
  const isBatch = ids.length > 1;

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setSelected(new Set());
      setSearch('');
    }
  }, [open]);

  const params = new URLSearchParams({ perPage: '50' });
  if (search.trim()) params.set('search', search.trim());

  const { data, isLoading } = useQuery<{ items: ConversationListItem[] }>({
    queryKey: ['conversations-forward-picker', search],
    queryFn: () => api(`/api/conversations?${params.toString()}`),
    enabled: open,
  });

  const items = (data?.items ?? []).filter((c) => c.id !== excludeConversationId);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (ids.length === 0 || selected.size === 0 || submitting) return;
    setSubmitting(true);
    try {
      if (isBatch) {
        const res = await api<{
          sent: Array<{ conversationId: string; messageCount: number }>;
          skipped: Array<{ reason: string }>;
          invalidMessages: string[];
          totalMessages: number;
        }>('/api/messages/forward-batch', {
          method: 'POST',
          body: JSON.stringify({
            messageIds: ids,
            conversationIds: Array.from(selected),
          }),
        });
        if (res.sent.length > 0) {
          toast.success(
            t('c_inbox_forward_message_dialog.toast_forwarded_batch', {
              n: res.totalMessages,
              count: res.sent.length,
            }),
          );
        }
        if (res.skipped.length > 0) {
          toast.error(t('c_inbox_forward_message_dialog.toast_skipped', { n: res.skipped.length }));
        }
        if (res.invalidMessages.length > 0) {
          toast.error(
            t('c_inbox_forward_message_dialog.toast_invalid', { n: res.invalidMessages.length }),
          );
        }
        onForwarded?.(res.sent.map((s) => s.conversationId));
      } else {
        const res = await api<{ sent: string[]; skipped: Array<{ reason: string }> }>(
          `/api/messages/${ids[0]}/forward`,
          {
            method: 'POST',
            body: JSON.stringify({ conversationIds: Array.from(selected) }),
          },
        );
        if (res.sent.length > 0) {
          toast.success(
            t('c_inbox_forward_message_dialog.toast_forwarded_single', { count: res.sent.length }),
          );
        }
        if (res.skipped.length > 0) {
          toast.error(t('c_inbox_forward_message_dialog.toast_skipped', { n: res.skipped.length }));
        }
        onForwarded?.(res.sent);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t('c_inbox_forward_message_dialog.toast_error'),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Forward className="h-4 w-4" />
            {isBatch
              ? t('c_inbox_forward_message_dialog.title_batch', { n: ids.length })
              : t('c_inbox_forward_message_dialog.title_single')}
          </DialogTitle>
          <DialogDescription>
            {t('c_inbox_forward_message_dialog.select_up_to')}{' '}
            {isBatch
              ? t('c_inbox_forward_message_dialog.desc_batch')
              : t('c_inbox_forward_message_dialog.desc_single')}
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('c_inbox_forward_message_dialog.search_placeholder')}
            className="pl-8"
          />
        </div>

        <div className="flex-1 overflow-y-auto rounded-md border divide-y">
          {isLoading ? (
            <p className="p-3 text-sm text-muted-foreground">{t('action.loading')}</p>
          ) : items.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              {t('c_inbox_forward_message_dialog.empty')}
            </p>
          ) : (
            items.map((c) => {
              const isSelected = selected.has(c.id);
              return (
                <label
                  key={c.id}
                  className={`flex cursor-pointer items-center gap-3 p-2.5 transition-colors ${
                    isSelected ? 'bg-accent/40' : 'hover:bg-accent/50'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(c.id)}
                    disabled={selected.size >= 10 && !isSelected}
                    className="h-3.5 w-3.5 rounded border-input"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {c.contact.name ?? c.contact.phoneNumber}
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {c.contact.phoneNumber} · {c.inbox.name}
                    </p>
                  </div>
                </label>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {t('c_inbox_forward_message_dialog.selected_count', { n: selected.size })}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              {t('action.cancel')}
            </Button>
            <Button onClick={submit} disabled={selected.size === 0 || submitting}>
              {submitting
                ? t('c_inbox_forward_message_dialog.submitting')
                : t('c_inbox_forward_message_dialog.submit')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
