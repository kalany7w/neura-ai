'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '@/components/theme-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const Icon = resolvedTheme === 'dark' ? Moon : Sun;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Aparência"
          className="rounded p-1.5 text-muted-foreground hover:bg-background hover:text-foreground"
        >
          <Icon className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Aparência</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => setTheme('light')}>
          <Sun className="h-3.5 w-3.5" />
          Claro
          {theme === 'light' && <span className="ml-auto text-[10px] text-muted-foreground">✓</span>}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setTheme('dark')}>
          <Moon className="h-3.5 w-3.5" />
          Escuro
          {theme === 'dark' && <span className="ml-auto text-[10px] text-muted-foreground">✓</span>}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setTheme('system')}>
          <Monitor className="h-3.5 w-3.5" />
          Sistema
          {theme === 'system' && (
            <span className="ml-auto text-[10px] text-muted-foreground">✓</span>
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
