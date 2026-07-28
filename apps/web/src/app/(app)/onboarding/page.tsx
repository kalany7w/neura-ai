'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { CreateWorkspaceForm } from '@/components/forms/create-workspace-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useT } from '@/lib/i18n';

export default function OnboardingPage() {
  const { t } = useT();
  const router = useRouter();
  // User com workspace (ex.: convidado cujo invite foi auto-aceito pela API)
  // não cria outro — segue pro select-workspace, que auto-entra se for 1 só.
  const { data } = useQuery<{ workspaces: { id: string }[] }>({
    queryKey: ['workspaces'],
    queryFn: () => api('/api/workspaces'),
  });
  useEffect(() => {
    if (data && data.workspaces.length > 0) {
      router.replace('/select-workspace');
    }
  }, [data, router]);

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>{t('page.onboarding.title')}</CardTitle>
          <CardDescription>{t('page.onboarding.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          <CreateWorkspaceForm />
        </CardContent>
      </Card>
    </div>
  );
}
