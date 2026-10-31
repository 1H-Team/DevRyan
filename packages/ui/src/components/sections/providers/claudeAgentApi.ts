/**
 * Claude Code login for OpenCode's claude-agent provider (Settings → Providers).
 * DevRyan never sees the Claude account: the server reports only whether the
 * connection exists and OpenCode's login problem, if any.
 */
export const CLAUDE_AGENT_PROVIDER_ID = 'claude-agent';

export interface ClaudeAgentStatus {
  available: boolean;
  connected: boolean;
  problem: { status: 'needs_auth' | 'error'; message: string; url?: string } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

export const parseClaudeAgentStatus = (payload: unknown): ClaudeAgentStatus | null => {
  if (!isRecord(payload) || payload.providerID !== CLAUDE_AGENT_PROVIDER_ID) return null;
  const raw = isRecord(payload.problem) ? payload.problem : null;
  const status = raw?.status === 'needs_auth' ? 'needs_auth' as const : raw?.status === 'error' ? 'error' as const : null;
  const problem = raw && status
    ? {
      status,
      message: typeof raw.message === 'string' ? raw.message : '',
      ...(typeof raw.url === 'string' && raw.url.startsWith('https://') ? { url: raw.url } : {}),
    }
    : null;
  return { available: payload.available === true, connected: payload.connected === true, problem };
};

const withDirectory = (path: string, directory: string | null | undefined): string => {
  const trimmed = directory?.trim();
  return trimmed ? `${path}?${new URLSearchParams({ directory: trimmed }).toString()}` : path;
};

/** The status, or null when this runtime has no claude-agent provider. */
export const requestClaudeAgent = async (
  action: 'status' | 'connect' | 'disconnect',
  directory: string | null | undefined,
  { fetchImpl = globalThis.fetch, signal }: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<ClaudeAgentStatus | null> => {
  const path = `/api/provider/${CLAUDE_AGENT_PROVIDER_ID}/${action === 'status' ? 'status' : 'connect'}`;
  const method = action === 'status' ? 'GET' : action === 'connect' ? 'POST' : 'DELETE';
  const response = await fetchImpl(withDirectory(path, directory), {
    method,
    headers: { Accept: 'application/json', ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
    ...(method === 'GET' ? {} : { body: '{}' }),
    signal,
  });
  if (response.status === 404 || response.status === 501) return null;
  if (!response.ok) throw new Error(`claude_agent_${action}_failed`);
  const status = parseClaudeAgentStatus(await response.json().catch(() => null));
  if (!status) throw new Error('claude_agent_status_invalid');
  return status;
};
