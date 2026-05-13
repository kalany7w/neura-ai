import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Mail } from 'lucide-react';

export default function VerifyEmailPage() {
  return (
    <Card>
      <CardHeader>
        <div className="mx-auto rounded-full bg-primary/10 p-3 w-fit">
          <Mail className="h-6 w-6 text-primary" />
        </div>
        <CardTitle className="text-center">Confirme seu email</CardTitle>
        <CardDescription className="text-center">
          Enviamos um link de confirmação para seu email. Abra a mensagem e clique no link para
          ativar sua conta.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-center text-sm text-muted-foreground">
          Não recebeu? Verifique a pasta de spam ou cadastre-se novamente.
        </p>
      </CardContent>
    </Card>
  );
}
