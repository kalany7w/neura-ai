'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Search, Plus, Phone, Upload } from 'lucide-react';
import { ImportContactsDialog } from '@/components/contacts/import-contacts-dialog';
import { ContactsBulkActionsBar } from '@/components/contacts/bulk-actions-bar';
import { toast } from 'sonner';
import { z } from 'zod';
import { api, ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

interface ContactItem {
  id: string;
  name: string | null;
  phoneNumber: string;
  avatarUrl: string | null;
  updatedAt: string;
  labels: Array<{ label: { id: string; name: string; color: string } }>;
}

interface LabelItem {
  id: string;
  name: string;
  color: string;
}

const createSchema = z.object({
  phoneNumber: z.string().regex(/^\+\d{8,15}$/, 'Formato E.164: +5511999999999'),
  name: z.string().min(1).max(120).optional(),
});
type CreateInput = z.infer<typeof createSchema>;

export default function ContactsPage() {
  const qc = useQueryClient();
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [labelId, setLabelId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [importOpen, setImportOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const perPage = 25;

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  const params = new URLSearchParams({ page: String(page), perPage: String(perPage) });
  if (search) params.set('search', search);
  if (labelId) params.set('labelId', labelId);

  const { data, isLoading } = useQuery<{
    items: ContactItem[];
    total: number;
    page: number;
    perPage: number;
  }>({
    queryKey: ['contacts', search, labelId, page],
    queryFn: () => api(`/api/contacts?${params.toString()}`),
  });

  const { data: labelsData } = useQuery<{ labels: LabelItem[] }>({
    queryKey: ['labels'],
    queryFn: () => api('/api/labels'),
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateInput>({ resolver: zodResolver(createSchema) });
  const [submitting, setSubmitting] = useState(false);

  async function onCreate(values: CreateInput) {
    setSubmitting(true);
    try {
      await api('/api/contacts', { method: 'POST', body: JSON.stringify(values) });
      toast.success(t('contacts.toast_created'));
      reset();
      setOpen(false);
      await qc.invalidateQueries({ queryKey: ['contacts'] });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'phone_taken') {
        toast.error(t('contacts.toast_phone_taken'));
      } else {
        toast.error(err instanceof Error ? err.message : t('contacts.toast_create_error'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / perPage)) : 1;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">{t('page.contacts.title')}</h1>
          <p className="text-muted-foreground">{t('page.contacts.subtitle')}</p>
        </div>
        <div className="flex gap-2">
        <Button variant="outline" onClick={() => setImportOpen(true)}>
          <Upload className="h-4 w-4" />
          {t('contacts.import_csv')}
        </Button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4" />
              {t('contacts.new')}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('contacts.new')}</DialogTitle>
              <DialogDescription>{t('contacts.new_desc')}</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit(onCreate)} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="phoneNumber">{t('contacts.phone_label')}</Label>
                <Input
                  id="phoneNumber"
                  placeholder="+5511999999999"
                  {...register('phoneNumber')}
                />
                {errors.phoneNumber && (
                  <p className="text-xs text-destructive">{errors.phoneNumber.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="name">{t('contacts.name_optional')}</Label>
                <Input id="name" {...register('name')} />
              </div>
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? t('contacts.creating') : t('action.create')}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <ImportContactsDialog open={importOpen} onOpenChange={setImportOpen} />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-64 max-w-md">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder={t('contacts.search_placeholder')}
            className="pl-8"
          />
        </div>
        {labelsData?.labels && labelsData.labels.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setLabelId(null)}
              className={`rounded-full px-3 py-1 text-xs ${
                !labelId ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              }`}
            >
              {t('contacts.all_labels')}
            </button>
            {labelsData.labels.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => setLabelId(l.id === labelId ? null : l.id)}
                style={{ backgroundColor: labelId === l.id ? l.color : undefined }}
                className={`rounded-full px-3 py-1 text-xs ${
                  labelId === l.id ? 'text-white' : 'bg-muted text-muted-foreground'
                }`}
              >
                {l.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border bg-card divide-y">
        {isLoading ? (
          <p className="p-6 text-sm text-muted-foreground">{t('action.loading')}</p>
        ) : !data?.items.length ? (
          <p className="p-6 text-sm text-muted-foreground">{t('contacts.empty')}</p>
        ) : (
          <>
            {data.items.length > 0 && (
              <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={data.items.every((c) => selectedIds.has(c.id))}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedIds((prev) => {
                        const next = new Set(prev);
                        for (const c of data.items) next.add(c.id);
                        return next;
                      });
                    } else {
                      setSelectedIds((prev) => {
                        const next = new Set(prev);
                        for (const c of data.items) next.delete(c.id);
                        return next;
                      });
                    }
                  }}
                  className="h-3.5 w-3.5 rounded border-input"
                />
                <span>
                  {selectedIds.size > 0
                    ? t('contacts.selected_count', { n: selectedIds.size })
                    : t('contacts.select_page')}
                </span>
              </div>
            )}
            {data.items.map((contact) => {
              const isSelected = selectedIds.has(contact.id);
              return (
                <div
                  key={contact.id}
                  className={`group flex items-center gap-3 p-4 transition-colors ${
                    isSelected ? 'bg-accent/40' : 'hover:bg-accent/50'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(contact.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="h-3.5 w-3.5 shrink-0 rounded border-input"
                  />
                  <Link
                    href={`/contacts/${contact.id}`}
                    className="flex flex-1 items-center justify-between gap-4"
                  >
                    <div>
                      <p className="font-medium">{contact.name ?? contact.phoneNumber}</p>
                      <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                        <Phone className="h-3 w-3" />
                        {contact.phoneNumber}
                      </p>
                    </div>
                    {contact.labels.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {contact.labels.map((cl) => (
                          <span
                            key={cl.label.id}
                            style={{ backgroundColor: cl.label.color }}
                            className="rounded-full px-2 py-0.5 text-xs text-white"
                          >
                            {cl.label.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </Link>
                </div>
              );
            })}
          </>
        )}
      </div>

      <ContactsBulkActionsBar
        selectedIds={Array.from(selectedIds)}
        labels={labelsData?.labels ?? []}
        onClear={clearSelection}
      />

      {data && data.total > perPage && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-muted-foreground">
            {t('contacts.pagination', { total: data.total, page: data.page, pages: totalPages })}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded border px-3 py-1 disabled:opacity-50"
            >
              {t('contacts.prev')}
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="rounded border px-3 py-1 disabled:opacity-50"
            >
              {t('contacts.next')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
