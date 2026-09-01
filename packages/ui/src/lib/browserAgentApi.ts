export type BrowserAgentViewSession = {
  id: string;
  leaseId: string;
  streamUrl: string;
  startedAt: string;
};

const readError = async (response: Response): Promise<Error> => {
  const body = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown };
  const error = new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`);
  if (typeof body.code === 'string') Object.assign(error, { code: body.code });
  return error;
};

export const startBrowserAgentView = async (leaseId: string): Promise<BrowserAgentViewSession> => {
  const response = await fetch(`/api/browser/agent-leases/${encodeURIComponent(leaseId)}/views`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DevRyan-CSRF': '1' },
    credentials: 'include',
    cache: 'no-store',
    body: '{}',
  });
  if (!response.ok) throw await readError(response);
  const body = await response.json() as { view?: Partial<BrowserAgentViewSession> };
  if (
    typeof body.view?.id !== 'string'
    || typeof body.view?.leaseId !== 'string'
    || typeof body.view?.streamUrl !== 'string'
    || typeof body.view?.startedAt !== 'string'
  ) {
    throw new Error('Invalid browser viewer response');
  }
  const expectedPrefix = `/api/browser/agent-leases/${encodeURIComponent(leaseId)}/views/`;
  if (
    body.view.leaseId !== leaseId
    || !body.view.streamUrl.startsWith(expectedPrefix)
    || !body.view.streamUrl.endsWith('/stream')
  ) {
    throw new Error('Invalid browser viewer stream URL');
  }
  return body.view as BrowserAgentViewSession;
};

export const stopBrowserAgentView = async (view: Pick<BrowserAgentViewSession, 'id' | 'leaseId'>): Promise<void> => {
  await fetch(
    `/api/browser/agent-leases/${encodeURIComponent(view.leaseId)}/views/${encodeURIComponent(view.id)}`,
    {
      method: 'DELETE',
      headers: { 'X-DevRyan-CSRF': '1' },
      credentials: 'include',
      cache: 'no-store',
    },
  ).catch(() => undefined);
};
