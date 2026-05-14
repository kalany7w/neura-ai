'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';

interface SeriesDay {
  date: string;
  conversations: number;
  inbound: number;
  outbound: number;
}

type Metric = 'conversations' | 'messages';

const METRIC_OPTIONS: Array<{ value: Metric; label: string }> = [
  { value: 'conversations', label: 'Conversas iniciadas' },
  { value: 'messages', label: 'Mensagens (in / out)' },
];

function dayShortLabel(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

export function DashboardTimeseriesChart() {
  const [metric, setMetric] = useState<Metric>('conversations');

  const { data } = useQuery<{ days: SeriesDay[] }>({
    queryKey: ['dashboard-timeseries', 14],
    queryFn: () => api('/api/dashboard/timeseries?days=14'),
    refetchInterval: 5 * 60_000,
  });

  if (!data) {
    return (
      <div className="rounded-lg border bg-card p-5">
        <p className="text-sm text-muted-foreground">Carregando gráfico…</p>
      </div>
    );
  }

  const max = Math.max(
    1,
    ...data.days.map((d) =>
      metric === 'conversations' ? d.conversations : Math.max(d.inbound, d.outbound),
    ),
  );
  const totalLeft =
    metric === 'conversations'
      ? data.days.reduce((sum, d) => sum + d.conversations, 0)
      : data.days.reduce((sum, d) => sum + d.inbound + d.outbound, 0);

  // SVG dimensions: 100 unidades x 40 unidades (scale via viewBox)
  const W = 800;
  const H = 200;
  const PAD_X = 32;
  const PAD_Y = 16;
  const innerW = W - PAD_X * 2;
  const innerH = H - PAD_Y * 2;
  const stepX = innerW / Math.max(1, data.days.length - 1);

  function yFor(v: number): number {
    return PAD_Y + innerH - (v / max) * innerH;
  }

  // Linha de conversations
  const linePath = data.days
    .map((d, i) => `${i === 0 ? 'M' : 'L'} ${PAD_X + i * stepX} ${yFor(d.conversations)}`)
    .join(' ');
  const areaPath =
    linePath +
    ` L ${PAD_X + (data.days.length - 1) * stepX} ${PAD_Y + innerH} L ${PAD_X} ${PAD_Y + innerH} Z`;

  const inboundPath = data.days
    .map((d, i) => `${i === 0 ? 'M' : 'L'} ${PAD_X + i * stepX} ${yFor(d.inbound)}`)
    .join(' ');
  const outboundPath = data.days
    .map((d, i) => `${i === 0 ? 'M' : 'L'} ${PAD_X + i * stepX} ${yFor(d.outbound)}`)
    .join(' ');

  // Gridlines (4 horizontais)
  const gridYs = Array.from({ length: 5 }, (_, i) => PAD_Y + (innerH * i) / 4);

  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Volume — últimos 14 dias
          </h2>
          <p className="mt-0.5 text-2xl font-bold">{totalLeft.toLocaleString('pt-BR')}</p>
        </div>
        <div className="flex gap-1 rounded-md bg-muted p-1 text-xs">
          {METRIC_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setMetric(o.value)}
              className={`rounded px-2.5 py-1 transition ${
                metric === o.value
                  ? 'bg-background font-medium shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-4 h-48 w-full"
        preserveAspectRatio="none"
      >
        {/* Gridlines */}
        {gridYs.map((y, i) => (
          <line
            key={i}
            x1={PAD_X}
            x2={W - PAD_X}
            y1={y}
            y2={y}
            stroke="currentColor"
            strokeOpacity={0.08}
            strokeWidth={1}
          />
        ))}

        {metric === 'conversations' ? (
          <>
            <path d={areaPath} fill="hsl(217, 91%, 60%)" fillOpacity={0.15} />
            <path
              d={linePath}
              fill="none"
              stroke="hsl(217, 91%, 60%)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {data.days.map((d, i) => (
              <circle
                key={d.date}
                cx={PAD_X + i * stepX}
                cy={yFor(d.conversations)}
                r={2.5}
                fill="hsl(217, 91%, 60%)"
              >
                <title>
                  {dayShortLabel(d.date)}: {d.conversations}
                </title>
              </circle>
            ))}
          </>
        ) : (
          <>
            <path
              d={inboundPath}
              fill="none"
              stroke="hsl(160, 84%, 39%)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d={outboundPath}
              fill="none"
              stroke="hsl(262, 83%, 58%)"
              strokeWidth={2}
              strokeDasharray="4 3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {data.days.map((d, i) => (
              <g key={d.date}>
                <circle
                  cx={PAD_X + i * stepX}
                  cy={yFor(d.inbound)}
                  r={2.5}
                  fill="hsl(160, 84%, 39%)"
                >
                  <title>
                    {dayShortLabel(d.date)} — recebidas: {d.inbound}
                  </title>
                </circle>
                <circle
                  cx={PAD_X + i * stepX}
                  cy={yFor(d.outbound)}
                  r={2.5}
                  fill="hsl(262, 83%, 58%)"
                >
                  <title>
                    {dayShortLabel(d.date)} — enviadas: {d.outbound}
                  </title>
                </circle>
              </g>
            ))}
          </>
        )}

        {/* X labels — primeiro, meio, último */}
        {[0, Math.floor(data.days.length / 2), data.days.length - 1]
          .filter((i) => data.days[i])
          .map((i) => {
            const d = data.days[i]!;
            return (
              <text
                key={i}
                x={PAD_X + i * stepX}
                y={H - 2}
                textAnchor="middle"
                className="fill-current text-[9px] text-muted-foreground"
                opacity={0.6}
              >
                {dayShortLabel(d.date)}
              </text>
            );
          })}

        {/* Y max label */}
        <text
          x={PAD_X - 4}
          y={PAD_Y + 4}
          textAnchor="end"
          className="fill-current text-[9px] text-muted-foreground"
          opacity={0.6}
        >
          {max}
        </text>
      </svg>

      {metric === 'messages' && (
        <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            Recebidas
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-violet-500" />
            Enviadas
          </span>
        </div>
      )}
    </div>
  );
}
