'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { InviteForm } from '@/components/forms/invite-form';

interface Member {
  id: string;
  userId: string;
  role: 'ADMIN' | 'SUPERVISOR' | 'AGENT';
  joinedAt: string;
  user: { id: string; name: string | null; email: string; image: string | null };
}

interface WorkspaceMe {
  workspace: { id: string; name: string; slug: string; members: Member[] };
}

export default function MembersPage() {
  const { data, isLoading } = useQuery<WorkspaceMe>({
    queryKey: ['workspace', 'me'],
    queryFn: () => api('/api/workspaces/me'),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Membros</h1>
        <p className="text-muted-foreground">Convide agentes e gerencie permissões.</p>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Convidar agente</CardTitle>
            <CardDescription>O convite expira em 7 dias.</CardDescription>
          </CardHeader>
          <CardContent>
            <InviteForm />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Membros atuais</CardTitle>
            <CardDescription>
              {data?.workspace.members.length ?? 0} membro(s)
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Carregando…</p>
            ) : (
              <ul className="space-y-2">
                {data?.workspace.members.map((m) => (
                  <li key={m.id} className="flex items-center justify-between rounded-md border p-3 text-sm">
                    <div>
                      <p className="font-medium">{m.user.name ?? m.user.email}</p>
                      <p className="text-xs text-muted-foreground">{m.user.email}</p>
                    </div>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{m.role}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
