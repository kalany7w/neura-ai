'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useRealtimeListener } from '@/hooks/use-realtime-listener';
import { useT } from '@/lib/i18n';

interface CalEvent {
  id: string;
  title: string;
  eventDate: string;
  // TASK = tarefa vinculada a um card (criada via TasksSection no card-detail).
  // Compartilha o mesmo modelo CalendarEvent — aparece aqui igual aos outros tipos.
  type: 'APPLICATION' | 'MAINTENANCE' | 'REPAIR' | 'SALE_FOLLOWUP' | 'TASK' | 'OTHER';
  status: 'SCHEDULED' | 'DONE' | 'CANCELLED';
  assignedUser: { id: string; name: string | null } | null;
  contact: { id: string; name: string | null } | null;
  cardId?: string | null;
}

const TYPE_COLOR: Record<CalEvent['type'], string> = {
  APPLICATION: '#16a34a',
  MAINTENANCE: '#f59e0b',
  REPAIR: '#ef4444',
  SALE_FOLLOWUP: '#3b82f6',
  TASK: '#8b5cf6', // violet — distingue tarefa do card de outros eventos do calendário
  OTHER: '#71717a',
};

const TYPE_LABEL: Record<CalEvent['type'], string> = {
  APPLICATION: 'Aplicação',
  MAINTENANCE: 'Manutenção',
  REPAIR: 'Reparação',
  SALE_FOLLOWUP: 'Follow-up',
  TASK: 'Tarefa',
  OTHER: 'Outro',
};

interface WorkspaceMeta {
  workspaces: Array<{ id: string; name: string; slug: string }>;
  activeWorkspaceId: string | null;
}

export default function CalendarPage() {
  const qc = useQueryClient();
  const { t, lang } = useT();
  const [ref, setRef] = useState(() => new Date());
  const year = ref.getFullYear();
  const month = ref.getMonth();

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const from = firstDay.toISOString();
  const to = new Date(year, month + 1, 0, 23, 59, 59).toISOString();

  // Workspace ativo — usado na queryKey pra que ao trocar de empresa o cache
  // do React Query NÃO sirva eventos do workspace anterior. Backend já isola
  // por workspaceId; isso é defesa em profundidade no cliente.
  const { data: wsData } = useQuery<WorkspaceMeta>({
    queryKey: ['workspaces'],
    queryFn: () => api('/api/workspaces'),
  });
  const activeWorkspaceId = wsData?.activeWorkspaceId ?? null;
  const activeWorkspace = wsData?.workspaces.find((w) => w.id === activeWorkspaceId);

  const { data } = useQuery<{ events: CalEvent[] }>({
    // activeWorkspaceId na key: troca de empresa → nova key → refetch limpo
    // (não mostra eventos da empresa anterior nem que por 1 frame).
    queryKey: ['calendar', activeWorkspaceId, year, month],
    queryFn: () => api(`/api/calendar?from=${from}&to=${to}`),
    enabled: !!activeWorkspaceId,
  });

  // Realtime: invalida quando outro user da MESMA empresa cria/edita/exclui evento.
  // Eventos vêm filtrados pelo workspaceId do backend, então só dispara pra este ws.
  useRealtimeListener((evt) => {
    if (
      evt.event === 'calendar_event.created' ||
      evt.event === 'calendar_event.updated' ||
      evt.event === 'calendar_event.deleted'
    ) {
      qc.invalidateQueries({ queryKey: ['calendar', activeWorkspaceId] });
    }
  });

  const startOffset = firstDay.getDay();
  const daysInMonth = lastDay.getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const eventsByDay = new Map<number, CalEvent[]>();
  (data?.events ?? []).forEach((ev) => {
    const day = new Date(ev.eventDate).getDate();
    const arr = eventsByDay.get(day) ?? [];
    arr.push(ev);
    eventsByDay.set(day, arr);
  });

  const locale = lang === 'es' ? 'es-PY' : 'pt-BR';
  const monthName = ref.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
  const todayDate = new Date();
  const isCurrentMonth = todayDate.getFullYear() === year && todayDate.getMonth() === month;
  // Dias da semana traduzidos (Dom/Seg/... ou Dom/Lun/...)
  const weekdays = lang === 'es'
    ? ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']
    : ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-bold">{t('page.calendar.title')}</h1>
            {activeWorkspace && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary"
                title={t('page.calendar.subtitle')}
              >
                <Building2 className="h-3 w-3" />
                {activeWorkspace.name}
              </span>
            )}
          </div>
          <p className="text-muted-foreground">{t('page.calendar.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setRef(new Date(year, month - 1, 1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="font-medium capitalize min-w-40 text-center">{monthName}</span>
          <Button variant="outline" size="sm" onClick={() => setRef(new Date(year, month + 1, 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setRef(new Date())}>
            {t('action.today')}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-px bg-border rounded-lg overflow-hidden border">
        {weekdays.map((d) => (
          <div key={d} className="bg-card p-2 text-center text-xs font-semibold text-muted-foreground">
            {d}
          </div>
        ))}
        {cells.map((day, idx) => {
          const dayEvents = day ? eventsByDay.get(day) ?? [] : [];
          const isToday = isCurrentMonth && day === todayDate.getDate();
          return (
            <div key={idx} className={`bg-card min-h-24 p-1.5 ${day ? '' : 'bg-muted/30'}`}>
              {day && (
                <>
                  <div
                    className={`text-xs font-medium mb-1 ${
                      isToday
                        ? 'inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground'
                        : 'text-muted-foreground'
                    }`}
                  >
                    {day}
                  </div>
                  <div className="space-y-1">
                    {dayEvents.slice(0, 3).map((ev) => (
                      <div
                        key={ev.id}
                        className="text-[10px] rounded px-1 py-0.5 truncate text-white"
                        style={{
                          backgroundColor: TYPE_COLOR[ev.type],
                          opacity: ev.status === 'DONE' ? 0.5 : 1,
                        }}
                        title={`${TYPE_LABEL[ev.type]}: ${ev.title}${ev.assignedUser?.name ? ' · ' + ev.assignedUser.name : ''}`}
                      >
                        {ev.title}
                      </div>
                    ))}
                    {dayEvents.length > 3 && (
                      <div className="text-[9px] text-muted-foreground">
                        +{dayEvents.length - 3} mais
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
