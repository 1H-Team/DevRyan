import { afterEach, describe, expect, test, vi } from 'vitest';

import { createWebSessionPlansAPI } from './sessionPlans';

const originalFetch = globalThis.fetch;
const identity = {
  sessionId: 'session-a',
  sourceMessageId: 'msg-plan-1',
  directory: '/repo/worktree',
  sessionCreated: 123,
  sessionSlug: 'Plan route',
};

describe('createWebSessionPlansAPI', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('uses the scoped session routes with CSRF-protected mutations', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (init?.method === 'POST') return Response.json({ path: '/plans/a.md', created: true });
      if (init?.method === 'PUT') return Response.json({ path: '/plans/a.md', saved: true });
      return Response.json({ path: '/plans/a.md', content: '# Plan' });
    }) as typeof fetch;

    const api = createWebSessionPlansAPI();
    await api.ensureRevision({ ...identity, markdown: '# Plan' });
    await api.readRevision(identity);
    await api.updateRevision({ ...identity, markdown: '# Edited' });

    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe('/api/session/session-a/plan-revisions/msg-plan-1');
    expect(calls[0].init?.method).toBe('POST');
    expect(new Headers(calls[0].init?.headers).get('X-DevRyan-CSRF')).toBe('1');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      directory: identity.directory,
      sessionCreated: identity.sessionCreated,
      sessionSlug: identity.sessionSlug,
      markdown: '# Plan',
    });
    const readUrl = new URL(calls[1].url, 'http://127.0.0.1');
    expect(readUrl.pathname).toBe('/api/session/session-a/plan-revisions/msg-plan-1');
    expect(readUrl.searchParams.get('directory')).toBe(identity.directory);
    expect(calls[2].init?.method).toBe('PUT');
    expect(new Headers(calls[2].init?.headers).get('X-DevRyan-CSRF')).toBe('1');
  });

  test('surfaces server error copy', async () => {
    globalThis.fetch = vi.fn(async () => Response.json(
      { error: 'Session not found' },
      { status: 404 },
    )) as typeof fetch;

    await expect(createWebSessionPlansAPI().readRevision(identity)).rejects.toThrow('Session not found');
  });
});
