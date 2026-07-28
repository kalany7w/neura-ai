'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { OfflineBanner } from '@/components/offline-banner';

/**
 * Casca do app: sidebar + conteúdo.
 *
 * A sidebar tem largura fixa de 240px. Em telas estreitas isso não sobra espaço
 * para o conteúdo (num aparelho de 390px restavam 150px e a tela de Conversas
 * saía cortada), então abaixo de `md` ela vira gaveta sobreposta, aberta pelo
 * botão de menu do cabeçalho. É a mesma instância do componente nos dois modos —
 * só muda o posicionamento — para não duplicar estado nem requisições.
 */
export function AppShell({
  sidebar,
  header,
  children,
}: {
  sidebar: ReactNode;
  header: ReactNode;
  children: ReactNode;
}) {
  const [aberto, setAberto] = useState(false);
  const pathname = usePathname();
  const { t } = useT();

  // Navegou: a gaveta não pode ficar cobrindo a tela nova.
  useEffect(() => {
    setAberto(false);
  }, [pathname]);

  // Esc fecha, como em qualquer overlay.
  useEffect(() => {
    if (!aberto) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAberto(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [aberto]);

  return (
    <div className="flex h-screen overflow-hidden">
      {aberto && (
        <button
          type="button"
          aria-label={t('common.close')}
          onClick={() => setAberto(false)}
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
        />
      )}

      <div
        className={`fixed inset-y-0 left-0 z-50 flex transition-transform duration-200 md:static md:z-auto md:translate-x-0 ${
          aberto ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {sidebar}
      </div>

      <main className="flex-1 overflow-y-auto">
        <OfflineBanner />
        <div className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">
          <button
            type="button"
            onClick={() => setAberto(true)}
            aria-label={t('common.open_menu')}
            className="-ml-1 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex flex-1 items-center justify-between gap-2">{header}</div>
        </div>
        <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">{children}</div>
      </main>
    </div>
  );
}
