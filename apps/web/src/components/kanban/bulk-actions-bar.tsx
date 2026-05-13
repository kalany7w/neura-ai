'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  AlarmClock,
  Tag,
  Trash2,
  UserCheck,
  UserX,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface Stage {
  id: string;
  name: string;
  color: string;
  outcome: 'POSITIVE' | 'NEGATIVE' | 'RISK' | null;
}

interface Member {
  userId: string;
  user: { name: string | null; email: string };
}

interface LabelItem {
  id: string;
  name: string;
  color: string;
}

const SNOOZE_PRESETS: Array<{ label: string; minutes: number }> = [
  { label: '15 min', minutes: 15 },
  { label: '1 hora', minutes: 60 },
  { label: '4 horas', minutes: 240 },
  { label: 'Amanhã', minutes: 60 * 24 },
  { label: '1 semana', minutes: 60 * 24 * 7 },
];

function initialsFrom(s: string | null | undefined): string {
  if (!s) return '?';
  return s
    .split(/[\s.@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

export function BulkActionsBar({
  selectedIds,
  stages,
  members,
  labels,
  onClear,
  funnelId,
}: {
  selectedIds: string[];
  stages: Stage[];
  members: Member[];
  labels: LabelItem[];
  onClear: () => void;
  funnelId: string;
}) {
  const qc = useQueryClient();

  async function run(payload: Record<string, unknown>) {
    try {
      const res = await api<{ affected: number }>(`/api/kanban/cards/bulk`, {
        method: 'POST',
        body: JSON.stringify({ ...payload, cardIds: selectedIds }),
      });
      toast.success(`${res.affected} card(s) atualizado(s)`);
      onClear();
      await qc.invalidateQueries({ queryKey: ['cards', funnelId] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  function move(stageId: string) {
    run({ action: 'move', stageId });
  }
  function assign(assignedAgentId: string | null) {
    run({ action: 'assign', assignedAgentId });
  }
  function snooze(minutes: number) {
    run({ action: 'snooze', minutes });
  }
  function applyLabel(labelId: string) {
    run({ action: 'apply_label', labelId });
  }
  async function remove() {
    if (!confirm(`Excluir ${selectedIds.length} card(s) selecionados? Esta ação é definitiva.`)) {
      return;
    }
    run({ action: 'delete' });
  }

  if (selectedIds.length === 0) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-xl border bg-card px-3 py-2 shadow-lg ring-1 ring-foreground/5 flex items-center gap-2">
      <span className="rounded-full bg-foreground px-2.5 py-0.5 text-xs font-bold text-background">
        {selectedIds.length}
      </span>
      <span className="text-sm font-medium">selecionado(s)</span>

      <div className="ml-2 h-5 w-px bg-border" />

      {/* Mover */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline">
            Mover pra…
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Stage destino</DropdownMenuLabel>
          {stages.map((s) => (
            <DropdownMenuItem key={s.id} onSelect={() => move(s.id)}>
              <span
                className="h-2 w-2 rounded-full"
                style={{
                  backgroundColor:
                    s.outcome === 'POSITIVE'
                      ? '#10b981'
                      : s.outcome === 'NEGATIVE'
                        ? '#ef4444'
                        : s.outcome === 'RISK'
                          ? '#f59e0b'
                          : s.color,
                }}
              />
              {s.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Atribuir */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline">
            <UserCheck className="h-3.5 w-3.5" />
            Atribuir
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="max-h-72 overflow-y-auto">
          <DropdownMenuItem onSelect={() => assign(null)}>
            <UserX className="h-3.5 w-3.5" />
            Remover atribuição
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {members.map((m) => (
            <DropdownMenuItem key={m.userId} onSelect={() => assign(m.userId)}>
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-[9px] font-semibold uppercase text-white">
                {initialsFrom(m.user.name ?? m.user.email)}
              </span>
              {m.user.name ?? m.user.email}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Adiar */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline">
            <AlarmClock className="h-3.5 w-3.5" />
            Adiar
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {SNOOZE_PRESETS.map((p) => (
            <DropdownMenuItem key={p.minutes} onSelect={() => snooze(p.minutes)}>
              {p.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Etiqueta */}
      {labels.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline">
              <Tag className="h-3.5 w-3.5" />
              Etiqueta
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="max-h-72 overflow-y-auto">
            {labels.map((l) => (
              <DropdownMenuItem key={l.id} onSelect={() => applyLabel(l.id)}>
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} />
                {l.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <Button size="sm" variant="ghost" onClick={remove} className="text-destructive">
        <Trash2 className="h-3.5 w-3.5" />
        Excluir
      </Button>

      <div className="ml-1 h-5 w-px bg-border" />

      <Button size="sm" variant="ghost" onClick={onClear} title="Cancelar seleção">
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
