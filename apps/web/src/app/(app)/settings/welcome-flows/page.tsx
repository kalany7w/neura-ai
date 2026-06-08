'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronRight,
  MessageSquarePlus,
  Circle,
  CircleCheck,
  CircleAlert,
  Plus,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';

interface InboxItem {
  id: string;
  name: string;
  type: 'WHATSAPP' | 'TELEGRAM' | 'EMAIL' | 'WEBCHAT';
  status: string;
  welcomeFlow?: {
    id: string;
    enabled: boolean;
    optionsCount: number;
  } | null;
}

export default function WelcomeFlowsListPage() {
  const { t } = useT();
  const { data, isLoading } = useQuery<{ inboxes: InboxItem[] }>({
    queryKey: ['welcome-flows-list'],
    queryFn: () => api('/api/inboxes?includeWelcomeFlow=true'),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">{t('page.welcome_flows.title')}</h1>
        <p className="text-muted-foreground">{t('page.welcome_flows.subtitle')}</p>
      </div>

      {isLoading && <p className="text-muted-foreground">Carregando…</p>}

      {data?.inboxes && data.inboxes.length === 0 && (
        <div className="rounded-lg border-2 border-dashed bg-card p-12 text-center">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-4">
            <MessageSquarePlus className="h-6 w-6 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold mb-1">Nenhuma inbox configurada</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Crie uma inbox primeiro pra configurar o fluxo de boas-vindas.
          </p>
          <Link href="/inboxes">
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Criar inbox
            </Button>
          </Link>
        </div>
      )}

      <div className="space-y-2">
        {data?.inboxes.map((inbox) => {
          const flow = inbox.welcomeFlow;
          const statusIcon = !flow ? (
            <Circle className="h-4 w-4 text-muted-foreground" />
          ) : flow.enabled ? (
            <CircleCheck className="h-4 w-4 text-emerald-500" />
          ) : (
            <CircleAlert className="h-4 w-4 text-amber-500" />
          );
          const statusText = !flow
            ? 'não configurado'
            : flow.enabled
              ? `ativo · ${flow.optionsCount} opções`
              : 'desativado';

          return (
            <Link
              key={inbox.id}
              href={`/settings/welcome-flows/${inbox.id}`}
              className="flex items-center justify-between rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50"
            >
              <div className="flex items-center gap-3">
                <MessageSquarePlus className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="font-medium">{inbox.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {inbox.type} · {inbox.status}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5 text-xs">
                  {statusIcon}
                  <span className="text-muted-foreground">{statusText}</span>
                </div>
                <Button variant="ghost" size="sm">
                  Editar
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
