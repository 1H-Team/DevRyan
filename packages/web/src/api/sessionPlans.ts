import type {
  SessionPlanRevisionIdentity,
  SessionPlanRevisionWrite,
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

const requestJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => null) as { error?: unknown } | T | null;
  if (!response.ok) {
    const message = payload && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : response.statusText;
    throw new Error(message || `Plan request failed (${response.status})`);
  }
  return payload as T;
};

const mutationHeaders = {
  'Content-Type': 'application/json',
  'X-DevRyan-CSRF': '1',
};

export const createWebSessionPlansAPI = (): SessionPlansAPI => ({
  async ensureRevision(input: SessionPlanRevisionWrite) {
    return requestJson(routeFor(input), {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ ...identityPayload(input), markdown: input.markdown }),
    });
  },

  async readRevision(input: SessionPlanRevisionIdentity) {
    const query = new URLSearchParams({
      directory: input.directory,
      sessionCreated: String(input.sessionCreated),
      sessionSlug: input.sessionSlug,
    });
    return requestJson(`${routeFor(input)}?${query.toString()}`, { cache: 'no-store' });
  },

  async updateRevision(input: SessionPlanRevisionWrite) {
    return requestJson(routeFor(input), {
      method: 'PUT',
      headers: mutationHeaders,
      body: JSON.stringify({ ...identityPayload(input), markdown: input.markdown }),
    });
  },
});
