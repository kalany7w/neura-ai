'use client';

import { Languages, Check } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useT, type Lang } from '@/lib/i18n';

const OPTIONS: Array<{ code: Lang; label: string; native: string }> = [
  { code: 'pt', label: 'Português (BR)', native: 'PT' },
  { code: 'es', label: 'Español', native: 'ES' },
];

/**
 * Switcher de idioma — botão compacto no footer da sidebar, ao lado do ThemeToggle.
 * Mostra o código do idioma atual (PT / ES) no botão; dropdown lista as opções
 * com nome nativo + check no ativo. Persiste em localStorage via useT.
 */
export function LanguageSwitcher() {
  const { lang, setLang, t } = useT();
  const current = OPTIONS.find((o) => o.code === lang) ?? OPTIONS[0]!;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={t('user.language')}
          aria-label={t('user.language')}
          className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-semibold uppercase text-muted-foreground hover:bg-background hover:text-foreground"
        >
          <Languages className="h-3.5 w-3.5" />
          {current.native}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>{t('user.language')}</DropdownMenuLabel>
        {OPTIONS.map((o) => (
          <DropdownMenuItem
            key={o.code}
            onSelect={() => setLang(o.code)}
            className={o.code === lang ? 'bg-accent/60' : ''}
          >
            <span className="flex-1">{o.label}</span>
            {o.code === lang && <Check className="ml-auto h-3.5 w-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
