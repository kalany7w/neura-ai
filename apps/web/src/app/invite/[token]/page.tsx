'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { useSession } from '@/lib/auth-client';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function AcceptInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const [isAccepting, setIsAccepting] = useState(false);

  async function accept() {
    setIsAccepting(true);
    try {
      const res = await api<{ workspaceId: string }>('/api/invites/accept', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      toast.success('Convite aceito!');
      router.push('/dashboard');
      router.refresh();
      return res;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao aceitar convite');
    } finally {
      setIsAccepting(false);
    }
  }

  if (isPending) return null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Aceitar convite</CardTitle>
          <CardDescription>
            Você foi convidado para um workspace no Neura AI.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {session?.user ? (
            <Button onClick={accept} className="w-full" disabled={isAccepting}>
              {isAccepting ? 'Aceitando...' : 'Aceitar e entrar'}
            </Button>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Você precisa entrar (ou criar conta com o email convidado) antes de aceitar.
              </p>
              <Button asChild className="w-full">
                <Link href={`/login?next=/invite/${token}`}>Entrar</Link>
              </Button>
              <Button asChild variant="outline" className="w-full">
                <Link href={`/signup?next=/invite/${token}`}>Criar conta</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
