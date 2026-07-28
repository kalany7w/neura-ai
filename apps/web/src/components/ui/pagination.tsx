'use client';

import { useT } from '@/lib/i18n';

export const PER_PAGE_OPTIONS = [10, 25, 50, 100] as const;
export const DEFAULT_PER_PAGE = 25;

/**
 * Barra de paginação padrão do app: seletor de itens por página + navegação.
 *
 * Quem usa é responsável por voltar para a página 1 quando um filtro muda —
 * senão o usuário fica numa página que já não existe no novo recorte.
 */
export function Pagination({
  page,
  perPage,
  total,
  onPageChange,
  onPerPageChange,
  className = '',
}: {
  page: number;
  perPage: number;
  total: number;
  onPageChange: (p: number) => void;
  onPerPageChange: (n: number) => void;
  className?: string;
}) {
  const { t } = useT();
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (total === 0) return null;

  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 pt-4 ${className}`}>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>{t('common.per_page')}</span>
        <select
          value={perPage}
          onChange={(e) => {
            onPerPageChange(Number(e.target.value));
            onPageChange(1);
          }}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          aria-label={t('common.per_page')}
        >
          {PER_PAGE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span className="tabular-nums">
          {t('common.page_of').replace('{page}', String(page)).replace('{total}', String(totalPages))}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="rounded-md border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('common.previous')}
        </button>
        <button
          type="button"
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          className="rounded-md border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('common.next')}
        </button>
      </div>
    </div>
  );
}

/**
 * Paginação client-side para listas que já vêm inteiras da API (configurações,
 * relatórios). Devolve a fatia da página atual e reposiciona sozinha quando a
 * lista encolhe — filtrar estando na página 5 não pode deixar a tela vazia.
 */
export function usePaginatedList<T>(items: T[], perPage: number, page: number) {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const paginaValida = Math.min(page, totalPages);
  const inicio = (paginaValida - 1) * perPage;
  return {
    slice: items.slice(inicio, inicio + perPage),
    totalPages,
    paginaValida,
  };
}
