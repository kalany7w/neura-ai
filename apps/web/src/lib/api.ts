/**
 * Fetch wrapper que envia cookies por padrão.
 * Use pra chamar nossos endpoints custom (workspaces, invites).
 */
export async function api<T = unknown>(
  path: string,
  init?: RequestInit & { workspaceId?: string },
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  if (init?.workspaceId) headers.set('X-Workspace-Id', init.workspaceId);

  const res = await fetch(path, {
    credentials: 'include',
    ...init,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body?.error ?? `http_${res.status}`, body);
  }

  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public body?: unknown,
  ) {
    super(`${code} (${status})`);
    this.name = 'ApiError';
  }
}
