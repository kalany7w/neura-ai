'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface WorkspacesResponse {
  workspaces: Array<{ id: string; currency?: string }>;
  activeWorkspaceId: string | null;
}

/**
 * Moeda do workspace ativo (persistida em settings.currency no backend).
 * Lê o cache do query ['workspaces'] que o layout já carrega — sem fetch extra
 * na maioria dos casos. Default 'USD'.
 */
export function useWorkspaceCurrency(): string {
  const { data } = useQuery<WorkspacesResponse>({
    queryKey: ['workspaces'],
    queryFn: () => api('/api/workspaces'),
    staleTime: 5 * 60_000,
  });
  if (!data) return 'USD';
  const active =
    data.workspaces.find((w) => w.id === data.activeWorkspaceId) ?? data.workspaces[0];
  return active?.currency ?? 'USD';
}
