'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Search as SearchIcon, Sparkles, Loader2, FileText, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

interface SearchResult {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  categoryId: string | null;
  score: number;
}

interface FullArticle {
  id: string;
  title: string;
  body: string;
  category: { id: string; name: string; color: string } | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialQuery?: string;
  /** Callback chamado quando o agente clica "Inserir conteúdo". */
  onInsert: (text: string) => void;
}

const DEBOUNCE_MS = 300;

export function KbSearchDialog({ open, onOpenChange, initialQuery, onInsert }: Props) {
  const [query, setQuery] = useState(initialQuery ?? '');
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [semantic, setSemantic] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [fullArticle, setFullArticle] = useState<FullArticle | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reset estado quando abrir/fechar
  useEffect(() => {
    if (open) {
      const q = initialQuery ?? '';
      setQuery(q);
      setDebouncedQuery(q);
      setResults([]);
      setExpandedId(null);
      setFullArticle(null);
      setError(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, initialQuery]);

  // Debounce
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  // Search efetivo
  useEffect(() => {
    if (!open) return;
    if (!debouncedQuery.trim()) {
      setResults([]);
      setError(null);
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    api<{ results: SearchResult[]; semantic: boolean }>('/api/kb/search', {
      method: 'POST',
      body: JSON.stringify({ query: debouncedQuery, limit: 6 }),
      signal: ctrl.signal,
    })
      .then((data) => {
        setResults(data.results);
        setSemantic(data.semantic);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof ApiError && err.status === 403) {
          setError('Sem permissão pra consultar a base.');
        } else {
          setError(err instanceof Error ? err.message : 'Erro');
        }
        setResults([]);
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [debouncedQuery, open]);

  async function toggleExpand(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
      setFullArticle(null);
      return;
    }
    setExpandedId(id);
    setFullArticle(null);
    setLoadingFull(true);
    try {
      const res = await api<{ article: FullArticle }>(`/api/kb/articles/${id}`);
      setFullArticle(res.article);
      // Incrementa viewCount em background (não bloqueia UI).
      api(`/api/kb/articles/${id}/view`, { method: 'POST' }).catch(() => {});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao carregar artigo');
      setExpandedId(null);
    } finally {
      setLoadingFull(false);
    }
  }

  function insertCurrent() {
    if (!fullArticle) return;
    onInsert(fullArticle.body);
    toast.success(`"${fullArticle.title}" inserido no composer`);
    onOpenChange(false);
  }

  const hasQuery = debouncedQuery.trim().length > 0;
  const emptyHint = useMemo(() => {
    if (!hasQuery) return 'Digite pra buscar artigos publicados';
    if (loading) return 'Buscando…';
    if (error) return error;
    if (results.length === 0) return 'Nenhum artigo encontrado';
    return null;
  }, [hasQuery, loading, error, results]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-indigo-500" />
            Buscar na base de conhecimento
          </DialogTitle>
          <DialogDescription>
            {semantic ? (
              <span className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400">
                <Sparkles className="h-3 w-3" />
                Busca semântica por IA — encontra artigos pelo significado, não só palavras
                exatas.
              </span>
            ) : (
              'Busca por palavra-chave (IA desabilitada — sem OPENAI_API_KEY).'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Como faço pra cancelar a assinatura?"
            className="pl-9"
          />
          {loading && (
            <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>

        <div className="max-h-[400px] space-y-1.5 overflow-y-auto pr-1">
          {emptyHint && (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <FileText className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">{emptyHint}</p>
              {!hasQuery && (
                <a
                  href="/settings/kb"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  Gerenciar base de conhecimento
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          )}

          {results.map((r) => {
            const expanded = expandedId === r.id;
            const scorePct = Math.round(r.score * 100);
            return (
              <div
                key={r.id}
                className={`rounded-md border transition-colors ${
                  expanded
                    ? 'border-indigo-300 bg-indigo-50/30 dark:border-indigo-800 dark:bg-indigo-950/20'
                    : 'border-border hover:border-foreground/30'
                }`}
              >
                <button
                  onClick={() => toggleExpand(r.id)}
                  className="flex w-full items-start gap-3 p-3 text-left"
                >
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium">{r.title}</p>
                      {semantic && (
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            scorePct >= 70
                              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                              : scorePct >= 50
                                ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                                : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {scorePct}% match
                        </span>
                      )}
                    </div>
                    {r.excerpt && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {r.excerpt}
                      </p>
                    )}
                  </div>
                </button>

                {expanded && (
                  <div className="border-t bg-card/60 px-3 py-3">
                    {loadingFull ? (
                      <p className="text-center text-sm text-muted-foreground">
                        <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                      </p>
                    ) : fullArticle && fullArticle.id === r.id ? (
                      <>
                        <pre className="max-h-[220px] overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-xs">
                          {fullArticle.body}
                        </pre>
                        <div className="mt-3 flex items-center justify-between gap-2">
                          <a
                            href="/settings/kb"
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                          >
                            <ExternalLink className="h-3 w-3" />
                            Abrir editor
                          </a>
                          <Button size="sm" onClick={insertCurrent}>
                            Inserir conteúdo no composer
                          </Button>
                        </div>
                      </>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
