import Link from 'next/link';
import { ForgotPasswordForm } from '@/components/forms/forgot-password-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function ForgotPasswordPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Esqueci a senha</CardTitle>
        <CardDescription>
          Vamos enviar um link pro seu email pra criar uma nova senha.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ForgotPasswordForm />
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Lembrou?{' '}
          <Link href="/login" className="font-medium text-primary hover:underline">
            Voltar pro login
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
