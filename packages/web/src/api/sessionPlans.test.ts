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
      if (init?.method === 'POST') return Response.json({ path: '/plans/a.md', created: true, version: 'v1' });
      if (init?.method === 'PUT') return Response.json({ path: '/plans/a.md', saved: true, version: 'v2' });
      return Response.json({ path: '/plans/a.md', content: '# Plan', version: 'v1' });
    }) as typeof fetch;

    const api = createWebSessionPlansAPI();
    expect(await api.ensureRevision({ ...identity, markdown: '# Plan' })).toMatchObject({ version: 'v1' });
    expect(await api.readRevision(identity)).toMatchObject({ version: 'v1' });
    expect(await api.updateRevision({ ...identity, markdown: '# Edited', expectedVersion: 'v1' })).toMatchObject({ version: 'v2' });

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
    expect(JSON.parse(String(calls[2].init?.body))).toMatchObject({ expectedVersion: 'v1' });
    expect(new Headers(calls[2].init?.headers).get('X-DevRyan-CSRF')).toBe('1');
  });

  test('preserves conflict status, code and authoritative version', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ error: 'The plan changed', code: 'plan_version_conflict', version: 'v2' }, { status: 409 })) as typeof fetch;
    await expect(createWebSessionPlansAPI().updateRevision({ ...identity, markdown: '# Draft', expectedVersion: 'v1' }))
      .rejects.toMatchObject({ message: 'The plan changed', status: 409, code: 'plan_version_conflict', version: 'v2' });
  });

  test('rejects successful revisions without a version', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ path: '/plans/a.md', content: '# Plan', created: true, saved: true })) as typeof fetch;
    const api = createWebSessionPlansAPI();
    await expect(api.readRevision(identity)).rejects.toThrow('Invalid plan response');
    await expect(api.ensureRevision({ ...identity, markdown: '# Plan' })).rejects.toThrow('Invalid plan response');
    await expect(api.updateRevision({ ...identity, markdown: '# Draft', expectedVersion: 'v1' })).rejects.toThrow('Invalid plan response');
  });

  test('surfaces server error copy', async () => {
    globalThis.fetch = vi.fn(async () => Response.json(
      { error: 'Session not found' },
      { status: 404 },
    )) as typeof fetch;

    await expect(createWebSessionPlansAPI().readRevision(identity)).rejects.toThrow('Session not found');
  });
});
