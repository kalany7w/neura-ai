'use client';

import { useEffect, useState } from 'react';
import { CalendarClock, X } from 'lucide-react';
import { realtimeClient } from '@/lib/ws-client';
import { Button } from '@/components/ui/button';
import { ScheduleEventDialog } from './schedule-event-dialog';

interface Suggestion {
  conversationId: string;
  suggestedDate: string;
  suggestedTitle: string;
  suggestedType: 'APPLICATION' | 'MAINTENANCE' | 'REPAIR' | 'SALE_FOLLOWUP' | 'OTHER';
}

export function ScheduleSuggestionBanner({
  conversationId,
  contactId,
}: {
  conversationId: string;
  contactId: string;
}) {
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    const unsub = realtimeClient.on((evt) => {
      if (evt.event === 'calendar.suggestion') {
        const p = evt.payload as Suggestion;
        if (p.conversationId === conversationId) {
          setSuggestion(p);
        }
      }
    });
    return unsub;
  }, [conversationId]);

  if (!suggestion) return null;

  const dateForInput =
    suggestion.suggestedDate.length === 10
      ? `${suggestion.suggestedDate}T09:00`
      : suggestion.suggestedDate.slice(0, 16);

  return (
    <>
      <div className="flex items-center gap-2 rounded-md border border-violet-300 bg-violet-50 px-3 py-2 text-sm">
        <CalendarClock className="h-4 w-4 text-violet-600 shrink-0" />
        <span className="flex-1 text-violet-900">
          Detectei uma data nessa conversa: <strong>{suggestion.suggestedTitle}</strong> em{' '}
          {new Date(suggestion.suggestedDate).toLocaleDateString('pt-BR')}. Agendar no calendário?
        </span>
        <Button type="button" size="sm" onClick={() => setDialogOpen(true)}>
          Agendar
        </Button>
        <button
          type="button"
          onClick={() => setSuggestion(null)}
          className="text-violet-400 hover:text-violet-700"
          aria-label="Dispensar"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <ScheduleEventDialog
        conversationId={conversationId}
        contactId={contactId}
        defaultDate={dateForInput}
        defaultTitle={suggestion.suggestedTitle}
        defaultType={suggestion.suggestedType}
        openExternal={dialogOpen}
        onOpenChange={(o) => {
          setDialogOpen(o);
          if (!o) setSuggestion(null);
        }}
      />
    </>
  );
}
