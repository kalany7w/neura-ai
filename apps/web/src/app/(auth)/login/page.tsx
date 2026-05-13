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
        <LoginForm />
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Ainda não tem conta?{' '}
          <Link href="/signup" className="font-medium text-primary hover:underline">
            Cadastrar
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
