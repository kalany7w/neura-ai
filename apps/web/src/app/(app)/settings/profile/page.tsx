'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, Mail, User as UserIcon } from 'lucide-react';
import { toast } from 'sonner';
import { authClient, useSession } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ActiveSessions } from '@/components/settings/active-sessions';

export default function ProfilePage() {
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const [name, setName] = useState('');
  const [savingName, setSavingName] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    if (session?.user) setName(session.user.name ?? '');
  }, [session?.user?.name, session?.user]);

  if (isPending) {
    return <p className="text-sm text-muted-foreground">Carregando…</p>;
  }
  if (!session?.user) {
    return <p className="text-sm text-destructive">Não autenticado.</p>;
  }

  const user = session.user;
  const initials = (user.name ?? user.email)
    .split(/[\s.@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('');

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || savingName) return;
    setSavingName(true);
    try {
      const res = await authClient.updateUser({ name: name.trim() });
      if (res.error) throw new Error(res.error.message ?? 'Erro');
      toast.success('Perfil atualizado');
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar');
    } finally {
      setSavingName(false);
    }
  }

  async function savePassword(e: React.FormEvent) {
    e.preventDefault();
    if (savingPassword) return;
    if (newPassword.length < 8) {
      toast.error('A nova senha deve ter pelo menos 8 caracteres');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('Confirmação não bate com a nova senha');
      return;
    }
    setSavingPassword(true);
    try {
      const res = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (res.error) throw new Error(res.error.message ?? 'Erro');
      toast.success('Senha alterada. Sessões em outros dispositivos foram revogadas.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao trocar senha');
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold">Meu perfil</h1>
        <p className="text-muted-foreground">Edite seus dados de atendente e troque sua senha.</p>
      </div>

      <div className="rounded-lg border bg-card p-5">
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary text-xl font-semibold text-primary-foreground">
            {initials || '?'}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-semibold">{user.name ?? 'Sem nome'}</p>
            <p className="truncate text-sm text-muted-foreground">{user.email}</p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-5">
        <h2 className="mb-4 flex items-center gap-2 font-semibold">
          <UserIcon className="h-4 w-4" />
          Identidade
        </h2>
        <form onSubmit={saveName} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Nome de exibição</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Seu nome"
              maxLength={120}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email" className="flex items-center gap-1.5">
              <Mail className="h-3.5 w-3.5" />
              Email
            </Label>
            <Input id="email" value={user.email} disabled />
            <p className="text-xs text-muted-foreground">
              Pra trocar o email, fale com um administrador.
            </p>
          </div>
          <Button type="submit" disabled={savingName || !name.trim() || name === (user.name ?? '')}>
            {savingName ? 'Salvando…' : 'Salvar alterações'}
          </Button>
        </form>
      </div>

      <div className="rounded-lg border bg-card p-5">
        <h2 className="mb-4 flex items-center gap-2 font-semibold">
          <Lock className="h-4 w-4" />
          Trocar senha
        </h2>
        <form onSubmit={savePassword} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="current">Senha atual</Label>
            <Input
              id="current"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="new">Nova senha</Label>
              <Input
                id="new"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                minLength={8}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm">Confirmar nova senha</Label>
              <Input
                id="confirm"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                minLength={8}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Mínimo 8 caracteres. Trocar a senha desconecta outras sessões abertas.
          </p>
          <Button
            type="submit"
            disabled={
              savingPassword || !currentPassword || newPassword.length < 8 || !confirmPassword
            }
          >
            {savingPassword ? 'Atualizando…' : 'Atualizar senha'}
          </Button>
        </form>
      </div>

      <ActiveSessions />
    </div>
  );
}
