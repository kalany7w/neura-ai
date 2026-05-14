'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmProvider } from '@/components/confirm-provider';
import { ThemeProvider } from '@/components/theme-provider';

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  return (
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <ConfirmProvider>{children}</ConfirmProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
