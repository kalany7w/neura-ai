'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Chrome,
  Globe,
  LogOut,
  Monitor,
  RefreshCw,
  Smartphone,
} from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import { Pagination, DEFAULT_PER_PAGE, usePaginatedList } from '@/components/ui/pagination';

interface Sess {
  id: string;
  token: string;
  createdAt: string;
  expiresAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

function parseUA(ua: string | null | undefined): { browser: string; os: string; mobile: boolean } {
  if (!ua) return { browser: 'Navegador', os: 'Desconhecido', mobile: false };
  const lower = ua.toLowerCase();
  let browser = 'Navegador';
  if (lower.includes('edg/') || lower.includes('edge/')) browser = 'Edge';
  else if (lower.includes('chrome/') && !lower.includes('chromium/')) browser = 'Chrome';
  else if (lower.includes('firefox/')) browser = 'Firefox';
  else if (lower.includes('safari/') && !lower.includes('chrome/')) browser = 'Safari';
  else if (lower.includes('opera/') || lower.includes('opr/')) browser = 'Opera';

  let os = 'Desconhecido';
  let mobile = false;
  if (lower.includes('iphone') || lower.includes('ipad')) {
    os = 'iOS';
    mobile = true;
  } else if (lower.includes('android')) {
    os = 'Android';
    mobile = true;
  } else if (lower.includes('windows')) os = 'Windows';
  else if (lower.includes('mac os') || lower.includes('macintosh')) os = 'macOS';
  else if (lower.includes('linux')) os = 'Linux';

  return { browser, os, mobile };
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'agora mesmo';
  if (minutes < 60) return `há ${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `há ${days}d`;
  return new Date(iso).toLocaleDateString('pt-BR');
}

export function ActiveSessions() {
  const confirm = useConfirm();
  const [sessions, setSessions] = useState<Sess[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [revokingToken, setRevokingToken] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState<number>(DEFAULT_PER_PAGE);

  const { slice: sessionsSlice } = usePaginatedList(sessions ?? [], perPage, page);

  async function load() {
    setLoading(true);
    try {
      const res = await authClient.listSessions();
      if (res.error) throw new Error(res.error.message ?? 'Erro');
      const data = (res.data ?? []) as Array<Record<string, unknown>>;
      const mapped: Sess[] = data.map((s) => ({
        id: String(s.id ?? ''),
        token: String(s.token ?? ''),
        createdAt:
          s.createdAt instanceof Date
            ? s.createdAt.toISOString()
            : String(s.createdAt ?? new Date().toISOString()),
        expiresAt:
          s.expiresAt instanceof Date
            ? s.expiresAt.toISOString()
            : String(s.expiresAt ?? new Date().toISOString()),
        ipAddress: (s.ipAddress as string | null | undefined) ?? null,
        userAgent: (s.userAgent as string | null | undefined) ?? null,
      }));
      // Ordena por createdAt desc
      mapped.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setSessions(mapped);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao listar sessões');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function revoke(s: Sess) {
    if (
      !(await confirm({
        title: 'Encerrar esta sessão?',
        description: 'O dispositivo é deslogado imediatamente.',
        confirmLabel: 'Encerrar',
        destructive: true,
      }))
    )
      return;
    setRevokingToken(s.token);
    try {
      const res = await authClient.revokeSession({ token: s.token });
      if (res.error) throw new Error(res.error.message ?? 'Erro');
      toast.success('Sessão encerrada');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao encerrar');
    } finally {
      setRevokingToken(null);
    }
  }

  async function revokeOthers() {
    if (
      !(await confirm({
        title: 'Encerrar todas as outras sessões?',
        description: 'Você fica logado só neste dispositivo. As demais são desconectadas.',
        confirmLabel: 'Encerrar outras',
        destructive: true,
      }))
    )
      return;
    try {
      const res = await authClient.revokeOtherSessions();
      if (res.error) throw new Error(res.error.message ?? 'Erro');
      toast.success('Outras sessões encerradas');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  const currentUA = typeof window !== 'undefined' ? window.navigator.userAgent : '';

  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold">
          <Monitor className="h-4 w-4" />
          Sessões ativas
        </h2>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          {sessions && sessions.length > 1 && (
            <Button size="sm" variant="outline" onClick={() => void revokeOthers()}>
              Encerrar outras
            </Button>
          )}
        </div>
      </div>

      {loading && !sessions ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : !sessions || sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sem sessões ativas.</p>
      ) : (
        <>
        <ul className="divide-y">
          {sessionsSlice.map((s) => {
            const parsed = parseUA(s.userAgent);
            const isCurrent = s.userAgent === currentUA;
            const Icon = parsed.mobile ? Smartphone : parsed.browser === 'Chrome' ? Chrome : Globe;
            return (
              <li key={s.id} className="flex items-center gap-3 py-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {parsed.browser} · {parsed.os}
                    {isCurrent && (
                      <span className="ml-2 rounded-full bg-emerald-100 px-1.5 py-0 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                        Este dispositivo
                      </span>
                    )}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {s.ipAddress ?? 'sem IP'} · Criada {formatRelative(s.createdAt)}
                  </p>
                </div>
                {!isCurrent && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void revoke(s)}
                    disabled={revokingToken === s.token}
                    title="Encerrar"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        <Pagination
          page={page}
          perPage={perPage}
          total={sessions.length}
          onPageChange={setPage}
          onPerPageChange={setPerPage}
        />
        </>
      )}
    </div>
  );
}
