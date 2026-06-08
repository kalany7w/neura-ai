'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';

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

export default function CalendarPage() {
  const [ref, setRef] = useState(() => new Date());
  const year = ref.getFullYear();
  const month = ref.getMonth();

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const from = firstDay.toISOString();
  const to = new Date(year, month + 1, 0, 23, 59, 59).toISOString();

  const { data } = useQuery<{ events: CalEvent[] }>({
    queryKey: ['calendar', year, month],
    queryFn: () => api(`/api/calendar?from=${from}&to=${to}`),
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

  const monthName = ref.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const todayDate = new Date();
  const isCurrentMonth = todayDate.getFullYear() === year && todayDate.getMonth() === month;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Calendário</h1>
          <p className="text-muted-foreground">
            Eventos da equipe — aplicações, manutenções, reparações e tarefas dos cards.
          </p>
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
            Hoje
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-px bg-border rounded-lg overflow-hidden border">
        {['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((d) => (
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
