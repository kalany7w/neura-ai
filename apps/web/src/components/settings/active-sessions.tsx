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
import { useT, formatRelativeTime } from '@/lib/i18n';

type TFn = (key: string, vars?: Record<string, string | number>) => string;

interface Sess {
  id: string;
  token: string;
  createdAt: string;
  expiresAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

function parseUA(
  ua: string | null | undefined,
  t: TFn,
): { browser: string; os: string; mobile: boolean } {
  if (!ua)
    return {
      browser: t('c_settings_active_sessions.browser_default'),
      os: t('c_settings_active_sessions.unknown'),
      mobile: false,
    };
  const lower = ua.toLowerCase();
  let browser = t('c_settings_active_sessions.browser_default');
  if (lower.includes('edg/') || lower.includes('edge/')) browser = 'Edge';
  else if (lower.includes('chrome/') && !lower.includes('chromium/')) browser = 'Chrome';
  else if (lower.includes('firefox/')) browser = 'Firefox';
  else if (lower.includes('safari/') && !lower.includes('chrome/')) browser = 'Safari';
  else if (lower.includes('opera/') || lower.includes('opr/')) browser = 'Opera';

  let os = t('c_settings_active_sessions.unknown');
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

export function ActiveSessions() {
  const { t, lang } = useT();
  const confirm = useConfirm();
  const [sessions, setSessions] = useState<Sess[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [revokingToken, setRevokingToken] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await authClient.listSessions();
      if (res.error) throw new Error(res.error.message ?? t('common.error'));
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
      toast.error(
        err instanceof Error ? err.message : t('c_settings_active_sessions.list_error'),
      );
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
        title: t('c_settings_active_sessions.confirm_revoke_title'),
        description: t('c_settings_active_sessions.confirm_revoke_desc'),
        confirmLabel: t('c_settings_active_sessions.revoke'),
        destructive: true,
      }))
    )
      return;
    setRevokingToken(s.token);
    try {
      const res = await authClient.revokeSession({ token: s.token });
      if (res.error) throw new Error(res.error.message ?? t('common.error'));
      toast.success(t('c_settings_active_sessions.revoked'));
      await load();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t('c_settings_active_sessions.revoke_error'),
      );
    } finally {
      setRevokingToken(null);
    }
  }

  async function revokeOthers() {
    if (
      !(await confirm({
        title: t('c_settings_active_sessions.confirm_others_title'),
        description: t('c_settings_active_sessions.confirm_others_desc'),
        confirmLabel: t('c_settings_active_sessions.revoke_others'),
        destructive: true,
      }))
    )
      return;
    try {
      const res = await authClient.revokeOtherSessions();
      if (res.error) throw new Error(res.error.message ?? t('common.error'));
      toast.success(t('c_settings_active_sessions.others_revoked'));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  const currentUA = typeof window !== 'undefined' ? window.navigator.userAgent : '';

  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold">
          <Monitor className="h-4 w-4" />
          {t('c_settings_active_sessions.title')}
        </h2>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          {sessions && sessions.length > 1 && (
            <Button size="sm" variant="outline" onClick={() => void revokeOthers()}>
              {t('c_settings_active_sessions.revoke_others')}
            </Button>
          )}
        </div>
      </div>

      {loading && !sessions ? (
        <p className="text-sm text-muted-foreground">{t('action.loading')}</p>
      ) : !sessions || sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('c_settings_active_sessions.empty')}
        </p>
      ) : (
        <ul className="divide-y">
          {sessions.map((s) => {
            const parsed = parseUA(s.userAgent, t);
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
                        {t('c_settings_active_sessions.this_device')}
                      </span>
                    )}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {s.ipAddress ?? t('c_settings_active_sessions.no_ip')} ·{' '}
                    {t('c_settings_active_sessions.created', {
                      rel: formatRelativeTime(s.createdAt, lang),
                    })}
                  </p>
                </div>
                {!isCurrent && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void revoke(s)}
                    disabled={revokingToken === s.token}
                    title={t('c_settings_active_sessions.revoke')}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
