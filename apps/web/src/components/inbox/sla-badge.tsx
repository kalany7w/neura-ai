import { Flame, Thermometer, Snowflake } from 'lucide-react';

type Temperature = 'CALIENTE' | 'TIBIO' | 'FRIO';

const CONFIG: Record<Temperature, { label: string; bg: string; text: string; Icon: typeof Flame }> =
  {
    CALIENTE: { label: 'CALIENTE', bg: 'bg-red-100', text: 'text-red-700', Icon: Flame },
    TIBIO: { label: 'TIBIO', bg: 'bg-amber-100', text: 'text-amber-800', Icon: Thermometer },
    FRIO: { label: 'FRIO', bg: 'bg-slate-100', text: 'text-slate-600', Icon: Snowflake },
  };

export function SlaBadge({ temperature }: { temperature: Temperature }) {
  const cfg = CONFIG[temperature];
  const Icon = cfg.Icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${cfg.bg} ${cfg.text}`}
    >
      <Icon className="h-3 w-3" />
      {cfg.label}
    </span>
  );
}
