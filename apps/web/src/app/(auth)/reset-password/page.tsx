import Link from 'next/link';
import { Suspense } from 'react';
import { ResetPasswordForm } from '@/components/forms/reset-password-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function ResetPasswordPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Criar senha nova</CardTitle>
        <CardDescription>Escolha uma senha forte com pelo menos 8 caracteres.</CardDescription>
      </CardHeader>
      <CardContent>
        <Suspense fallback={<p className="text-sm text-muted-foreground">Carregando…</p>}>
          <ResetPasswordForm />
        </Suspense>
        <p className="mt-6 text-center text-sm text-muted-foreground">
          <Link href="/login" className="font-medium text-primary hover:underline">
            Voltar pro login
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
