'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ChevronLeft, Save } from 'lucide-react';
import { toast } from 'sonner';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { WelcomeFlowOptionsEditor } from '@/components/settings/welcome-flow-options-editor';
import { WelcomeFlowTestDialog } from '@/components/settings/welcome-flow-test-dialog';

interface WelcomeOption {
  id: string;
  position: number;
  label: string;
  description: string | null;
  matchKeywords: string[];
  targetLabelId: string;
  targetFunnelId: string | null;
  targetStageId: string | null;
  targetUserId: string | null;
}

interface FlowResponse {
  flow: {
    id: string;
    prompt: string;
    fallbackLabelId: string | null;
    fallbackFunnelId: string | null;
    fallbackStageId: string | null;
    fallbackUserId: string | null;
    fallbackTimeoutMinutes: number;
    maxAttempts: number;
    enabled: boolean;
    options: WelcomeOption[];
  };
  inbox: { id: string; name: string };
}

interface LabelOpt {
  id: string;
  name: string;
  color: string;
  // routesToFunnelId: dueño de funnel. null = label global (visível em todos os funis).
  routesToFunnelId?: string | null;
  routesToStageId?: string | null;
}
interface FunnelOpt {
  id: string;
  name: string;
  stages: { id: string; name: string }[];
}
interface MemberOpt {
  id: string;
  name: string | null;
  email: string;
}

interface WorkspaceMeResponse {
  workspace: {
    id: string;
    name: string;
    slug: string;
    members: Array<{
      id: string;
      userId: string;
      role: string;
      user: { id: string; name: string | null; email: string; image: string | null };
    }>;
  };
}

const flowSchema = z.object({
  prompt: z.string().min(1).max(2_000),
  enabled: z.boolean(),
  fallbackLabelId: z.string().nullable(),
  fallbackFunnelId: z.string().nullable(),
  fallbackStageId: z.string().nullable(),
  fallbackUserId: z.string().nullable(),
  fallbackTimeoutMinutes: z.number().int().min(0).max(60),
  maxAttempts: z.number().int().min(1).max(10),
});
type FlowInput = z.infer<typeof flowSchema>;

export default function WelcomeFlowEditorPage() {
  const params = useParams<{ inboxId: string }>();
  const inboxId = params.inboxId;
  const router = useRouter();
  const qc = useQueryClient();
  const [submitting, setSubmitting] = useState(false);

  const { data, isLoading, isError } = useQuery<FlowResponse | { error: string; inbox: { id: string; name: string } }>({
    queryKey: ['welcome-flow', inboxId],
    queryFn: async () => {
      try {
        return await api(`/api/inboxes/${inboxId}/welcome-flow`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          return err.body as { error: string; inbox: { id: string; name: string } };
        }
        throw err;
      }
    },
  });

  const { data: labelsData } = useQuery<{ labels: LabelOpt[] }>({
    queryKey: ['labels'],
    queryFn: () => api('/api/labels'),
  });

  const { data: funnelsData } = useQuery<{ funnels: FunnelOpt[] }>({
    queryKey: ['funnels-with-stages'],
    queryFn: () => api('/api/kanban/funnels?includeStages=true'),
  });

  const { data: workspaceData } = useQuery<WorkspaceMeResponse>({
    queryKey: ['workspace-me'],
    queryFn: () => api('/api/workspaces/me'),
  });

  const members: MemberOpt[] = (workspaceData?.workspace.members ?? []).map((m) => ({
    id: m.user.id,
    name: m.user.name,
    email: m.user.email,
  }));

  const hasFlow = !!data && 'flow' in data;
  const inbox = data?.inbox;

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FlowInput>({
    resolver: zodResolver(flowSchema),
    defaultValues: {
      prompt: 'Olá! Como podemos ajudar?\n\n1. Compra\n2. Suporte',
      enabled: true,
      fallbackLabelId: null,
      fallbackFunnelId: null,
      fallbackStageId: null,
      fallbackUserId: null,
      fallbackTimeoutMinutes: 2,
      maxAttempts: 2,
    },
    values: hasFlow
      ? {
          prompt: data.flow.prompt,
          enabled: data.flow.enabled,
          fallbackLabelId: data.flow.fallbackLabelId,
          fallbackFunnelId: data.flow.fallbackFunnelId,
          fallbackStageId: data.flow.fallbackStageId,
          fallbackUserId: data.flow.fallbackUserId,
          fallbackTimeoutMinutes: data.flow.fallbackTimeoutMinutes,
          maxAttempts: data.flow.maxAttempts,
        }
      : undefined,
  });

  const fallbackFunnelId = watch('fallbackFunnelId');
  const fallbackLabelId = watch('fallbackLabelId');
  const fallbackStageId = watch('fallbackStageId');
  const fallbackStages = funnelsData?.funnels.find((f) => f.id === fallbackFunnelId)?.stages ?? [];

  // Labels visíveis no fallback: globais + as do funnel selecionado.
  // (Mesmo escopo multi-empresa que kanban: label de XAG não aparece em fluxo apontando pra Caltech.)
  const visibleFallbackLabels = (labelsData?.labels ?? []).filter(
    (l) =>
      !l.routesToFunnelId ||
      (fallbackFunnelId ? l.routesToFunnelId === fallbackFunnelId : true),
  );

  // Auto-reset fallbackLabelId quando muda o funnel e a label atual não está mais visível.
  // Evita state stale apontando pra label de outro funnel (que sumiu do dropdown e
  // faria o Radix Select renderizar com value inválido — placeholder, mas o form ainda
  // enviaria o id antigo no submit). Mesmo pra stageId.
  useEffect(() => {
    if (fallbackLabelId && !visibleFallbackLabels.some((l) => l.id === fallbackLabelId)) {
      setValue('fallbackLabelId', null);
    }
    if (fallbackStageId && !fallbackStages.some((s) => s.id === fallbackStageId)) {
      setValue('fallbackStageId', null);
    }
  }, [fallbackFunnelId, fallbackLabelId, fallbackStageId, visibleFallbackLabels, fallbackStages, setValue]);

  async function onSave(values: FlowInput) {
    setSubmitting(true);
    try {
      const method = hasFlow ? 'PUT' : 'POST';
      await api(`/api/inboxes/${inboxId}/welcome-flow`, {
        method,
        body: JSON.stringify(values),
      });
      toast.success(hasFlow ? 'Fluxo atualizado' : 'Fluxo criado');
      await qc.invalidateQueries({ queryKey: ['welcome-flow', inboxId] });
      await qc.invalidateQueries({ queryKey: ['welcome-flows-list'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar');
    } finally {
      setSubmitting(false);
    }
  }

  if (isLoading) return <p className="text-muted-foreground">Carregando…</p>;
  if (isError || !inbox) {
    return (
      <div className="space-y-4">
        <p className="text-destructive">Erro ao carregar fluxo. Inbox existe?</p>
        <Button onClick={() => router.push('/settings/welcome-flows')}>Voltar</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Link href="/settings/welcome-flows" className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-3xl font-bold">{inbox.name}</h1>
          <p className="text-muted-foreground">Fluxo de boas-vindas</p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSave)} className="space-y-6">
        <div className="rounded-lg border bg-card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Configurações gerais</h2>
            <div className="flex items-center gap-2">
              <Label htmlFor="enabled" className="text-sm">
                Ativo
              </Label>
              <Switch
                id="enabled"
                checked={watch('enabled')}
                onCheckedChange={(v) => setValue('enabled', v)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="prompt">Mensagem inicial</Label>
            <Textarea
              id="prompt"
              {...register('prompt')}
              rows={6}
              placeholder="Olá {{contact.name}}! Como podemos ajudar?"
            />
            <p className="text-xs text-muted-foreground">
              Suporta placeholder <code>{'{{contact.name}}'}</code>. Quando o nome do contato for
              vazio, substitui por &quot;cliente&quot;.
            </p>
            {errors.prompt && <p className="text-xs text-destructive">{errors.prompt.message}</p>}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="maxAttempts">Máx. tentativas do cliente</Label>
              <Input
                id="maxAttempts"
                type="number"
                min={1}
                max={10}
                {...register('maxAttempts', { valueAsNumber: true })}
              />
              <p className="text-xs text-muted-foreground">
                Após N respostas sem match, aplica fallback.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="fallbackTimeoutMinutes">Timeout pra texto plano (min)</Label>
              <Input
                id="fallbackTimeoutMinutes"
                type="number"
                min={0}
                max={60}
                {...register('fallbackTimeoutMinutes', { valueAsNumber: true })}
              />
              <p className="text-xs text-muted-foreground">
                Se cliente não responder o botão interativo em X min, reenviamos como texto. 0 =
                desativado.
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-5 space-y-4">
          <h2 className="font-semibold">Fallback (se nenhuma opção matchea)</h2>

          <div className="space-y-2">
            <Label>Etiqueta aplicada</Label>
            <Select
              value={fallbackLabelId ?? 'none'}
              onValueChange={(v) => setValue('fallbackLabelId', v === 'none' ? null : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Nenhuma" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Nenhuma</SelectItem>
                {visibleFallbackLabels.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                    {l.routesToFunnelId && (
                      <span className="ml-2 text-[10px] text-muted-foreground">
                        · {funnelsData?.funnels.find((f) => f.id === l.routesToFunnelId)?.name ?? ''}
                      </span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fallbackFunnelId && (
              <p className="text-[11px] text-muted-foreground">
                Mostrando apenas labels globais + do funil selecionado.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Funil destino</Label>
              <Select
                value={watch('fallbackFunnelId') ?? 'none'}
                onValueChange={(v) => {
                  setValue('fallbackFunnelId', v === 'none' ? null : v);
                  setValue('fallbackStageId', null);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Nenhum" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Nenhum</SelectItem>
                  {funnelsData?.funnels.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Etapa inicial</Label>
              <Select
                value={watch('fallbackStageId') ?? 'none'}
                onValueChange={(v) => setValue('fallbackStageId', v === 'none' ? null : v)}
                disabled={!fallbackFunnelId}
              >
                <SelectTrigger>
                  <SelectValue placeholder={fallbackFunnelId ? 'Selecione' : 'Escolha funil antes'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Nenhum</SelectItem>
                  {fallbackStages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Atribuir fallback a</Label>
            <Select
              value={watch('fallbackUserId') ?? 'none'}
              onValueChange={(v) => setValue('fallbackUserId', v === 'none' ? null : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Ninguém" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Ninguém</SelectItem>
                {members.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name ?? m.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Se nenhuma opção matchear após N attempts, atribui a este usuário.
            </p>
          </div>
        </div>

        {watch('enabled') && hasFlow && data.flow.options.length === 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
            <strong>Atenção:</strong> O fluxo está marcado como ativo mas não tem opções configuradas.
            Adicione pelo menos uma opção abaixo antes de salvar, ou desative o toggle.
          </div>
        )}

        <div className="flex justify-end gap-2">
          {hasFlow && (
            <WelcomeFlowTestDialog
              flowId={data.flow.id}
              flowEnabled={data.flow.enabled}
              optionsCount={data.flow.options.length}
            />
          )}
          <Button type="submit" disabled={submitting}>
            <Save className="mr-2 h-4 w-4" />
            {submitting ? 'Salvando…' : 'Salvar'}
          </Button>
        </div>
      </form>

      {hasFlow && labelsData && funnelsData && (
        <WelcomeFlowOptionsEditor
          flowId={data.flow.id}
          options={data.flow.options}
          labels={labelsData.labels}
          funnels={funnelsData.funnels}
          members={members}
        />
      )}
    </div>
  );
}
