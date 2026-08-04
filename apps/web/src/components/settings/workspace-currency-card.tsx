'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useWorkspaceCurrency } from '@/hooks/use-workspace-currency';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const CURRENCIES = ['USD', 'BRL', 'PYG', 'EUR', 'ARS'] as const;

/**
 * Seletor da moeda do workspace (admin). Persiste em settings.currency via
 * PATCH /api/workspaces/me/settings e revalida o cache ['workspaces'] pra que
 * dashboard/relatórios re-formatem os valores na hora.
 */
export function WorkspaceCurrencyCard() {
  const { t } = useT();
  const qc = useQueryClient();
  const current = useWorkspaceCurrency();
  const [saving, setSaving] = useState(false);

  async function change(next: string) {
    if (next === current || saving) return;
    setSaving(true);
    try {
      await api('/api/workspaces/me/settings', {
        method: 'PATCH',
        body: JSON.stringify({ currency: next }),
      });
      await qc.invalidateQueries({ queryKey: ['workspaces'] });
      toast.success(t('settings_currency.saved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings_currency.title')}</CardTitle>
        <CardDescription>{t('settings_currency.desc')}</CardDescription>
      </CardHeader>
      <CardContent>
        <select
          value={current}
          disabled={saving}
          onChange={(e) => change(e.target.value)}
          className="h-9 w-full max-w-xs rounded-md border bg-background px-3 text-sm"
        >
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {t(`settings_currency.opt_${c}`)}
            </option>
          ))}
        </select>
      </CardContent>
    </Card>
  );
}
