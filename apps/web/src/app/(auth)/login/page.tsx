import { Suspense } from 'react';
import { LoginForm } from '@/components/forms/login-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import Link from 'next/link';

export default function LoginPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Entrar no Neura AI</CardTitle>
        <CardDescription>Use seu email e senha</CardDescription>
      </CardHeader>
      <CardContent>
        {/* LoginForm lê ?verified=true — useSearchParams exige boundary no build */}
        <Suspense fallback={<p className="text-sm text-muted-foreground">Carregando…</p>}>
          <LoginForm />
        </Suspense>
        <div className="mt-6 flex flex-col items-center gap-2 text-center text-sm text-muted-foreground">
          <Link href="/forgot-password" className="hover:text-foreground hover:underline">
            Esqueci a senha
          </Link>
          <span>
            Ainda não tem conta?{' '}
            <Link href="/signup" className="font-medium text-primary hover:underline">
              Cadastrar
            </Link>
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
