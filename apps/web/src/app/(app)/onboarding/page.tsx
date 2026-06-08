'use client';

import { CreateWorkspaceForm } from '@/components/forms/create-workspace-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useT } from '@/lib/i18n';

export default function OnboardingPage() {
  const { t } = useT();
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
