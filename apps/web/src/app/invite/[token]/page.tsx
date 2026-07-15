'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { useSession } from '@/lib/auth-client';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function AcceptInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const { t } = useT();
  const { data: session, isPending } = useSession();
  const [isAccepting, setIsAccepting] = useState(false);

  async function accept() {
    setIsAccepting(true);
    try {
      const res = await api<{ workspaceId: string }>('/api/invites/accept', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      toast.success(t('invite_token.accepted'));
      router.push('/dashboard');
      router.refresh();
      return res;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('invite_token.accept_error'));
    } finally {
      setIsAccepting(false);
    }
  }

  if (isPending) return null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t('invite_token.title')}</CardTitle>
          <CardDescription>
            {t('invite_token.description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {session?.user ? (
            <Button onClick={accept} className="w-full" disabled={isAccepting}>
              {isAccepting ? t('invite_token.accepting') : t('invite_token.accept_and_enter')}
            </Button>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {t('invite_token.login_required')}
              </p>
              <Button asChild className="w-full">
                <Link href={`/login?next=/invite/${token}`}>{t('invite_token.login')}</Link>
              </Button>
              <Button asChild variant="outline" className="w-full">
                <Link href={`/signup?next=/invite/${token}`}>{t('invite_token.signup')}</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
