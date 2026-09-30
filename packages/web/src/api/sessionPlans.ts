import type {
  SessionPlanRevisionIdentity,
  SessionPlanRevisionWrite,
  SessionPlanRevisionUpdate,
  SessionPlansAPI,
} from '@openchamber/ui/lib/api/types';

const routeFor = ({ sessionId, sourceMessageId }: SessionPlanRevisionIdentity): string => (
  `/api/session/${encodeURIComponent(sessionId)}/plan-revisions/${encodeURIComponent(sourceMessageId)}`
);

const identityPayload = (input: SessionPlanRevisionIdentity) => ({
  directory: input.directory,
  sessionCreated: input.sessionCreated,
  sessionSlug: input.sessionSlug,
});

const requestJson = async (url: string, init?: RequestInit): Promise<Record<string, unknown> & { path: string; version: string }> => {
  const response = await fetch(url, init);
  const payload: unknown = await response.json().catch(() => null);
  const value = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown> : {};
  if (!response.ok) {
    const message = typeof value.error === 'string' ? value.error : response.statusText;
    throw Object.assign(new Error(message || `Plan request failed (${response.status})`), {
      status: response.status,
      ...(typeof value.code === 'string' ? { code: value.code } : {}),
      ...(typeof value.version === 'string' ? { version: value.version } : {}),
    });
  }
  if (typeof value.path !== 'string' || typeof value.version !== 'string' || !value.version) {
    throw new Error('Invalid plan response');
  }
  return { ...value, path: value.path, version: value.version };
};

const mutationHeaders = {
  'Content-Type': 'application/json',
  'X-DevRyan-CSRF': '1',
};

export const createWebSessionPlansAPI = (): SessionPlansAPI => ({
  async ensureRevision(input: SessionPlanRevisionWrite) {
    const result = await requestJson(routeFor(input), {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ ...identityPayload(input), markdown: input.markdown }),
    });
    if (typeof result.created !== 'boolean') throw new Error('Invalid plan response');
    return { path: result.path, created: result.created, version: result.version };
  },

  async readRevision(input: SessionPlanRevisionIdentity) {
    const query = new URLSearchParams({
      directory: input.directory,
      sessionCreated: String(input.sessionCreated),
      sessionSlug: input.sessionSlug,
    });
    const result = await requestJson(`${routeFor(input)}?${query.toString()}`, { cache: 'no-store' });
    if (typeof result.content !== 'string') throw new Error('Invalid plan response');
    return { path: result.path, content: result.content, version: result.version };
  },

  async updateRevision(input: SessionPlanRevisionUpdate) {
    const result = await requestJson(routeFor(input), {
      method: 'PUT',
      headers: mutationHeaders,
      body: JSON.stringify({ ...identityPayload(input), markdown: input.markdown, expectedVersion: input.expectedVersion }),
    });
    if (typeof result.saved !== 'boolean') throw new Error('Invalid plan response');
    return { path: result.path, saved: result.saved, version: result.version };
  },
});
