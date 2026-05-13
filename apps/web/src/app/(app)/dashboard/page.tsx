import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground">Bem-vindo ao Neura AI. As próximas fases trazem o atendimento.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Inboxes</CardTitle>
            <CardDescription>Configure suas inboxes WhatsApp (Fase 2)</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Em breve.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Conversas</CardTitle>
            <CardDescription>Atenda clientes em tempo real (Fase 4)</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Em breve.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Kanban</CardTitle>
            <CardDescription>Funis de venda + SLA visual (Fase 6+)</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Em breve.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
