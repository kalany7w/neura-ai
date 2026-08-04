'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  BookOpen,
  Folder,
  Plus,
  Trash2,
  Search as SearchIcon,
  Sparkles,
  Archive,
  FileText,
  RotateCw,
  Send,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useT, localeFor } from '@/lib/i18n';
import { useConfirm } from '@/components/confirm-provider';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

function DialogFooter({ children }: { children: React.ReactNode }) {
  return <div className="flex justify-end gap-2 pt-2">{children}</div>;
}

type ArticleStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

interface Category {
  id: string;
  name: string;
  slug: string;
  color: string;
  position: number;
  _count?: { articles: number };
}

interface ArticleListItem {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  status: ArticleStatus;
  viewCount: number;
  categoryId: string | null;
  embeddingUpdatedAt: string | null;
  updatedAt: string;
  createdAt: string;
}

interface ArticleDetail extends ArticleListItem {
  body: string;
  category: { id: string; name: string; color: string } | null;
}

interface Stats {
  total: number;
  published: number;
  drafts: number;
  archived: number;
  withEmbedding: number;
}

const STATUS_KEY: Record<ArticleStatus, string> = {
  DRAFT: 'settings_kb.status_draft',
  PUBLISHED: 'settings_kb.status_published',
  ARCHIVED: 'settings_kb.status_archived',
};

const STATUS_COLOR: Record<ArticleStatus, string> = {
  DRAFT: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  PUBLISHED: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  ARCHIVED: 'bg-muted text-muted-foreground',
};

export default function KbPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { t, lang } = useT();
  const [selectedCategory, setSelectedCategory] = useState<string | 'all' | 'uncategorized'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | ArticleStatus>('all');
  const [q, setQ] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [catDialogOpen, setCatDialogOpen] = useState(false);

  const statsQ = useQuery<Stats>({
    queryKey: ['kb-stats'],
    queryFn: () => api('/api/kb/stats'),
  });

  const catsQ = useQuery<{ categories: Category[] }>({
    queryKey: ['kb-categories'],
    queryFn: () => api('/api/kb/categories'),
  });

  const articlesQ = useQuery<{ articles: ArticleListItem[] }>({
    queryKey: ['kb-articles', statusFilter, selectedCategory, q],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (selectedCategory !== 'all' && selectedCategory !== 'uncategorized') {
        params.set('categoryId', selectedCategory);
      }
      if (q.trim()) params.set('q', q.trim());
      const qs = params.toString();
      return api(`/api/kb/articles${qs ? '?' + qs : ''}`);
    },
  });

  const filteredArticles = useMemo(() => {
    const arr = articlesQ.data?.articles ?? [];
    if (selectedCategory === 'uncategorized') {
      return arr.filter((a) => !a.categoryId);
    }
    return arr;
  }, [articlesQ.data, selectedCategory]);

  async function removeCategory(cat: Category) {
    const count = cat._count?.articles ?? 0;
    const desc =
      count > 0
        ? t(
            count > 1
              ? 'settings_kb.category_articles_will_lose_many'
              : 'settings_kb.category_articles_will_lose_one',
            { n: count },
          )
        : t('settings_kb.category_no_articles');
    if (
      !(await confirm({
        title: t('settings_kb.remove_category_confirm', { name: cat.name }),
        description: desc,
        confirmLabel: t('settings_kb.remove'),
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/kb/categories/${cat.id}`, { method: 'DELETE' });
      toast.success(t('settings_kb.category_removed'));
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['kb-categories'] }),
        qc.invalidateQueries({ queryKey: ['kb-articles'] }),
      ]);
      if (selectedCategory === cat.id) setSelectedCategory('all');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  async function archiveArticle(a: ArticleListItem) {
    try {
      await api(`/api/kb/articles/${a.id}/archive`, { method: 'POST' });
      toast.success(t('settings_kb.article_archived'));
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['kb-articles'] }),
        qc.invalidateQueries({ queryKey: ['kb-stats'] }),
      ]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  async function publishArticle(a: ArticleListItem) {
    try {
      await api(`/api/kb/articles/${a.id}/publish`, { method: 'POST' });
      toast.success(t('settings_kb.published_embedding_queued'));
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['kb-articles'] }),
        qc.invalidateQueries({ queryKey: ['kb-stats'] }),
      ]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  async function reembedArticle(a: ArticleListItem) {
    try {
      await api(`/api/kb/articles/${a.id}/reembed`, { method: 'POST' });
      toast.success(t('settings_kb.reembed_queued'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  async function removeArticle(a: ArticleListItem) {
    if (
      !(await confirm({
        title: t('settings_kb.delete_article_confirm', { title: a.title }),
        description: t('settings_kb.action_irreversible'),
        confirmLabel: t('action.delete'),
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/kb/articles/${a.id}`, { method: 'DELETE' });
      toast.success(t('settings_kb.deleted'));
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['kb-articles'] }),
        qc.invalidateQueries({ queryKey: ['kb-stats'] }),
      ]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  function openNewArticle() {
    setEditingId(null);
    setEditorOpen(true);
  }

  function openEditArticle(id: string) {
    setEditingId(id);
    setEditorOpen(true);
  }

  const stats = statsQ.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold">
            <BookOpen className="h-7 w-7 text-indigo-500" />
            {t('page.kb.title')}
          </h1>
          <p className="mt-1 max-w-2xl text-muted-foreground">{t('page.kb.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setCatDialogOpen(true)}>
            <Folder className="mr-2 h-4 w-4" />
            {t('settings_kb.categories')}
          </Button>
          <Button onClick={openNewArticle}>
            <Plus className="mr-2 h-4 w-4" />
            {t('settings_kb.new_article')}
          </Button>
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <StatCard label={t('settings_kb.stat_total')} value={stats.total} />
          <StatCard
            label={t('settings_kb.stat_published')}
            value={stats.published}
            accent="emerald"
          />
          <StatCard label={t('settings_kb.stat_drafts')} value={stats.drafts} accent="amber" />
          <StatCard label={t('settings_kb.stat_archived')} value={stats.archived} />
          <StatCard
            label={t('settings_kb.stat_with_embedding')}
            value={stats.withEmbedding}
            sub={
              stats.published > 0
                ? Math.round((stats.withEmbedding / stats.published) * 100) + '%'
                : '—'
            }
            accent="indigo"
          />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[200px_1fr]">
        {/* Sidebar de categorias */}
        <aside className="space-y-1">
          <SidebarItem
            label={t('settings_kb.filter_all')}
            count={stats?.total ?? 0}
            active={selectedCategory === 'all'}
            onClick={() => setSelectedCategory('all')}
          />
          <SidebarItem
            label={t('settings_kb.uncategorized')}
            active={selectedCategory === 'uncategorized'}
            onClick={() => setSelectedCategory('uncategorized')}
            muted
          />
          <div className="border-t my-2" />
          {(catsQ.data?.categories ?? []).map((c) => (
            <div key={c.id} className="group relative">
              <SidebarItem
                label={c.name}
                color={c.color}
                count={c._count?.articles ?? 0}
                active={selectedCategory === c.id}
                onClick={() => setSelectedCategory(c.id)}
              />
              <button
                onClick={() => removeCategory(c)}
                className="absolute right-1 top-1.5 hidden rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:block"
                title={t('settings_kb.delete_category')}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
          {catsQ.data?.categories.length === 0 && (
            <p className="px-2 text-[11px] text-muted-foreground">
              {t('settings_kb.no_categories_hint')}
            </p>
          )}
        </aside>

        {/* Lista de artigos */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
            <div className="relative min-w-[200px] flex-1">
              <SearchIcon className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder={t('settings_kb.search_placeholder')}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="pl-8"
              />
            </div>
            <div className="flex gap-1.5">
              {(['all', 'PUBLISHED', 'DRAFT', 'ARCHIVED'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatusFilter(s)}
                  className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    statusFilter === s
                      ? 'border-foreground bg-accent text-foreground'
                      : 'text-muted-foreground hover:bg-accent/50'
                  }`}
                >
                  {s === 'all' ? t('settings_kb.status_all') : t(STATUS_KEY[s])}
                </button>
              ))}
            </div>
          </div>

          {articlesQ.isLoading ? (
            <p className="text-sm text-muted-foreground">{t('action.loading')}</p>
          ) : filteredArticles.length === 0 ? (
            <div className="rounded-lg border-2 border-dashed py-12 text-center">
              <BookOpen className="mx-auto h-10 w-10 text-muted-foreground/40" />
              <p className="mt-3 font-medium">{t('settings_kb.no_articles')}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {q
                  ? t('settings_kb.try_other_search')
                  : statusFilter === 'all'
                    ? t('settings_kb.create_first')
                    : t('settings_kb.no_articles_status', {
                        status: t(STATUS_KEY[statusFilter as ArticleStatus]).toLowerCase(),
                      })}
              </p>
              {!q && statusFilter === 'all' && (
                <Button onClick={openNewArticle} className="mt-4">
                  <Plus className="mr-2 h-4 w-4" />
                  {t('settings_kb.create_article')}
                </Button>
              )}
            </div>
          ) : (
            <ul className="space-y-2">
              {filteredArticles.map((a) => (
                <li
                  key={a.id}
                  className="group rounded-lg border bg-card p-3 hover:border-foreground/30"
                >
                  <div className="flex items-start gap-3">
                    <button
                      onClick={() => openEditArticle(a.id)}
                      className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                    >
                      <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <p className="font-medium">{a.title}</p>
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_COLOR[a.status]}`}
                          >
                            {t(STATUS_KEY[a.status])}
                          </span>
                          {a.status === 'PUBLISHED' && a.embeddingUpdatedAt && (
                            <span
                              title={t('settings_kb.embedding_generated_at', {
                                date: new Date(a.embeddingUpdatedAt).toLocaleString(
                                  localeFor(lang),
                                ),
                              })}
                              className="inline-flex items-center gap-0.5 rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:text-indigo-300"
                            >
                              <Sparkles className="h-2.5 w-2.5" />
                              {t('settings_kb.ai_ready')}
                            </span>
                          )}
                          {a.status === 'PUBLISHED' && !a.embeddingUpdatedAt && (
                            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                              {t('settings_kb.embedding_pending')}
                            </span>
                          )}
                        </div>
                        {a.excerpt && (
                          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                            {a.excerpt}
                          </p>
                        )}
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          {t('settings_kb.updated', {
                            date: new Date(a.updatedAt).toLocaleString(localeFor(lang)),
                          })}
                          {a.viewCount > 0 &&
                            ` · ${t(
                              a.viewCount > 1 ? 'settings_kb.views_many' : 'settings_kb.views_one',
                              { n: a.viewCount },
                            )}`}
                        </p>
                      </div>
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
                      {a.status === 'DRAFT' && (
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => publishArticle(a)}
                          title={t('settings_kb.publish')}
                        >
                          <Send className="h-4 w-4" />
                        </Button>
                      )}
                      {a.status === 'PUBLISHED' && (
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => reembedArticle(a)}
                          title={t('settings_kb.reembed')}
                        >
                          <RotateCw className="h-4 w-4" />
                        </Button>
                      )}
                      {a.status !== 'ARCHIVED' && (
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => archiveArticle(a)}
                          title={t('settings_kb.archive')}
                        >
                          <Archive className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => removeArticle(a)}
                        title={t('action.delete')}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <ArticleEditorDialog
        open={editorOpen}
        articleId={editingId}
        categories={catsQ.data?.categories ?? []}
        onClose={() => setEditorOpen(false)}
        onSaved={async () => {
          await Promise.all([
            qc.invalidateQueries({ queryKey: ['kb-articles'] }),
            qc.invalidateQueries({ queryKey: ['kb-stats'] }),
          ]);
        }}
      />

      <CategoriesDialog
        open={catDialogOpen}
        onClose={() => setCatDialogOpen(false)}
        categories={catsQ.data?.categories ?? []}
        onChanged={() => qc.invalidateQueries({ queryKey: ['kb-categories'] })}
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: number;
  sub?: string;
  accent?: 'emerald' | 'amber' | 'indigo';
}) {
  const colors: Record<string, string> = {
    emerald: 'text-emerald-600 dark:text-emerald-400',
    amber: 'text-amber-600 dark:text-amber-400',
    indigo: 'text-indigo-600 dark:text-indigo-400',
  };
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5">
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-2xl font-bold ${accent ? colors[accent] : ''}`}>{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function SidebarItem({
  label,
  count,
  active,
  onClick,
  color,
  muted,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
  color?: string;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors ${
        active
          ? 'bg-accent font-medium text-accent-foreground'
          : muted
            ? 'text-muted-foreground hover:bg-accent/50'
            : 'text-foreground hover:bg-accent/50'
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        {color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />}
        <span className="truncate">{label}</span>
      </span>
      {count !== undefined && count > 0 && (
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {count}
        </span>
      )}
    </button>
  );
}

// ============================================
// Editor de artigo (Dialog full)
// ============================================

function ArticleEditorDialog({
  open,
  articleId,
  categories,
  onClose,
  onSaved,
}: {
  open: boolean;
  articleId: string | null;
  categories: Category[];
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const { t } = useT();
  const detailQ = useQuery<{ article: ArticleDetail }>({
    queryKey: ['kb-article', articleId],
    queryFn: () => api(`/api/kb/articles/${articleId}`),
    enabled: !!articleId && open,
  });

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [categoryId, setCategoryId] = useState<string>('');
  const [status, setStatus] = useState<ArticleStatus>('DRAFT');
  const [submitting, setSubmitting] = useState(false);

  // Sincroniza form com artigo carregado (edit) ou reseta (new article).
  // Roda quando dialog abre, id muda, ou query resolve. useEffect evita
  // setState-during-render antipattern.
  const article = detailQ.data?.article;
  useEffect(() => {
    if (!open) return;
    if (articleId && article && article.id === articleId) {
      setTitle(article.title);
      setBody(article.body);
      setCategoryId(article.categoryId ?? '');
      setStatus(article.status);
    } else if (!articleId) {
      setTitle('');
      setBody('');
      setCategoryId('');
      setStatus('DRAFT');
    }
  }, [open, articleId, article]);

  async function save() {
    if (!title.trim()) {
      toast.error(t('settings_kb.title_required'));
      return;
    }
    if (!body.trim()) {
      toast.error(t('settings_kb.body_required'));
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        title: title.trim(),
        body,
        categoryId: categoryId || null,
        status,
      };
      if (articleId) {
        await api(`/api/kb/articles/${articleId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        toast.success(t('settings_kb.article_updated'));
      } else {
        await api('/api/kb/articles', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        toast.success(
          status === 'PUBLISHED'
            ? t('settings_kb.published_embedding_queued')
            : t('settings_kb.draft_saved'),
        );
      }
      await onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'category_not_found') {
        toast.error(t('settings_kb.invalid_category'));
      } else {
        toast.error(err instanceof Error ? err.message : t('common.error'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {articleId ? t('settings_kb.edit_article') : t('settings_kb.new_article')}
          </DialogTitle>
          <DialogDescription>{t('settings_kb.editor_description')}</DialogDescription>
        </DialogHeader>

        {articleId && detailQ.isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('action.loading')}</p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="kb-title">{t('settings_kb.title_label')}</Label>
              <Input
                id="kb-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('settings_kb.title_placeholder')}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="kb-category">{t('settings_kb.category_label')}</Label>
                <select
                  id="kb-category"
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">{t('settings_kb.no_category_option')}</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="kb-status">{t('common.status')}</Label>
                <select
                  id="kb-status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as ArticleStatus)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="DRAFT">{t('settings_kb.status_draft_option')}</option>
                  <option value="PUBLISHED">{t('settings_kb.status_published_option')}</option>
                  <option value="ARCHIVED">{t('settings_kb.status_archived_option')}</option>
                </select>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-end justify-between">
                <Label htmlFor="kb-body">{t('settings_kb.body_label')}</Label>
                <p className="text-[10px] text-muted-foreground">
                  {t('settings_kb.char_count', { n: body.length })}
                </p>
              </div>
              <textarea
                id="kb-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={14}
                placeholder={t('settings_kb.body_placeholder')}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm resize-y"
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button onClick={save} disabled={submitting}>
            {submitting
              ? t('action.saving')
              : articleId
                ? t('settings_kb.save_changes')
                : status === 'PUBLISHED'
                  ? t('settings_kb.create_and_publish')
                  : t('settings_kb.save_draft')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================
// Dialog de categorias (CRUD inline)
// ============================================

function CategoriesDialog({
  open,
  onClose,
  categories,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  categories: Category[];
  onChanged: () => void;
}) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [color, setColor] = useState('#6366f1');
  const [submitting, setSubmitting] = useState(false);

  async function create() {
    if (!name.trim()) {
      toast.error(t('settings_kb.name_required'));
      return;
    }
    setSubmitting(true);
    try {
      await api('/api/kb/categories', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), color }),
      });
      toast.success(t('settings_kb.category_created'));
      setName('');
      setColor('#6366f1');
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'name_taken') {
        toast.error(t('settings_kb.name_taken'));
      } else {
        toast.error(err instanceof Error ? err.message : t('common.error'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings_kb.categories_dialog_title')}</DialogTitle>
          <DialogDescription>{t('settings_kb.categories_dialog_description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 rounded-md border bg-muted/30 p-3">
          <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {t('settings_kb.new_category')}
          </Label>
          <div className="flex gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('settings_kb.category_name_placeholder')}
              className="flex-1"
            />
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-9 w-12 cursor-pointer rounded-md border bg-background"
              title={t('settings_kb.color')}
            />
            <Button onClick={create} disabled={submitting}>
              {submitting ? '…' : t('action.add')}
            </Button>
          </div>
        </div>

        <div className="max-h-[300px] space-y-1 overflow-y-auto">
          {categories.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {t('settings_kb.no_categories')}
            </p>
          ) : (
            categories.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between rounded-md border bg-card px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: c.color }} />
                  <span className="truncate text-sm">{c.name}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {t('settings_kb.articles_count', { n: c._count?.articles ?? 0 })}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('action.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
