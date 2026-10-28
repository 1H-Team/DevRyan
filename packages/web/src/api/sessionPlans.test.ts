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

  test('preserves scoped successful source proof and actual saved content on every operation', async () => {
    const sourceIdentity = { sessionID: identity.sessionId, sourceMessageID: identity.sourceMessageId,
      rootUserMessageID: 'msg-user', memberUserMessageIDs: ['msg-user'], memberAssistantMessageIDs: [identity.sourceMessageId],
      currentSourceMessageID: identity.sourceMessageId, successful: true, settled: true, current: true };
    const response = { path: '/plans/a.md', version: 'a'.repeat(64), created: false, saved: true, content: '# Edited saved plan', sourceIdentity };
    globalThis.fetch = vi.fn(async () => Response.json(response)) as typeof fetch;
    const api = createWebSessionPlansAPI();
    for (const result of [await api.ensureRevision({ ...identity, markdown: '# Assistant original' }),
      await api.readRevision(identity), await api.updateRevision({ ...identity, markdown: response.content, expectedVersion: 'b'.repeat(64) })]) {
      expect(result).toMatchObject({ version: response.version, content: response.content, sourceIdentity });
    }
    for (const invalid of [{ ...sourceIdentity, sessionID: 'other' }, { ...sourceIdentity, currentSourceMessageID: 'other' },
      { ...sourceIdentity, permitSha256: 'secret-proof' }, { ...sourceIdentity, successful: false }]) {
      globalThis.fetch = vi.fn(async () => Response.json({ ...response, sourceIdentity: invalid })) as typeof fetch;
      await expect(api.readRevision(identity)).rejects.toThrow('Invalid plan response');
    }
    globalThis.fetch = vi.fn(async () => Response.json({ ...response, version: 'v1' })) as typeof fetch;
    await expect(api.readRevision(identity)).rejects.toThrow('Invalid plan response');
    await expect(api.updateRevision({ ...identity, markdown: '# Edited', expectedVersion: response.version })).rejects.toThrow('Invalid plan response');
  });

  test('preserves conflict status, code and authoritative version', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ error: 'The plan changed', code: 'plan_version_conflict', version: 'v2' }, { status: 409 })) as typeof fetch;
    await expect(createWebSessionPlansAPI().updateRevision({ ...identity, markdown: '# Draft', expectedVersion: 'v1' }))
      .rejects.toMatchObject({ message: 'The plan changed', status: 409, code: 'plan_version_conflict', version: 'v2' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test('keeps why a plan source is unsettled, and drops a malformed reason', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ error: 'plan_source_unsettled', code: 'plan_source_unsettled', reason: 'tasks_active' }, { status: 409 })) as typeof fetch;
    await expect(createWebSessionPlansAPI().ensureRevision({ ...identity, markdown: '# Plan' }))
      .rejects.toMatchObject({ status: 409, code: 'plan_source_unsettled', reason: 'tasks_active' });
    globalThis.fetch = vi.fn(async () => Response.json({ error: 'plan_source_unsettled', code: 'plan_source_unsettled', reason: 'Not A Reason' }, { status: 409 })) as typeof fetch;
    const error = await createWebSessionPlansAPI().ensureRevision({ ...identity, markdown: '# Plan' }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'plan_source_unsettled' });
    expect(error).not.toHaveProperty('reason');
  });

  test('refreshes only the canonical display slug after a typed mismatch, once for each owned operation', async () => {
    const api = createWebSessionPlansAPI();
    for (const operation of ['ensure', 'read', 'update'] as const) {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        if (calls.length === 1) return Response.json({ code: 'plan_identity_mismatch', error: 'Identity mismatch' }, { status: 409 });
        if (calls.length === 2) return Response.json({ id: identity.sessionId, directory: identity.directory, time: { created: identity.sessionCreated }, slug: identity.sessionId });
        return Response.json({ path: '/plans/a.md', created: false, saved: true, content: '# Saved', version: 'v1' });
      }) as typeof fetch;
      if (operation === 'ensure') await api.ensureRevision({ ...identity, markdown: '# Original' });
      else if (operation === 'read') await api.readRevision(identity);
      else await api.updateRevision({ ...identity, markdown: '# Edit', expectedVersion: 'original-version' });
      expect(calls).toHaveLength(3);
      expect(new URL(calls[1].url, 'http://fixture').pathname).toBe('/api/session/session-a');
      expect(new URL(calls[1].url, 'http://fixture').searchParams.get('directory')).toBe(identity.directory);
      if (operation === 'read') expect(new URL(calls[2].url, 'http://fixture').searchParams.get('sessionSlug')).toBe(identity.sessionId);
      else {
        expect(JSON.parse(String(calls[2].init?.body))).toMatchObject({ directory: identity.directory,
          sessionCreated: identity.sessionCreated, sessionSlug: identity.sessionId });
        if (operation === 'update') expect(JSON.parse(String(calls[2].init?.body)).expectedVersion).toBe('original-version');
      }
    }
  });

  test.each([{ id: 'foreign', directory: identity.directory, time: { created: identity.sessionCreated }, slug: 'canonical' },
    { id: identity.sessionId, directory: identity.directory, time: { created: identity.sessionCreated + 1 }, slug: 'canonical' },
    { id: identity.sessionId, directory: '/moved-or-foreign', time: { created: identity.sessionCreated }, slug: 'canonical' },
    { id: identity.sessionId, time: { created: identity.sessionCreated }, slug: 'canonical' },
    { id: identity.sessionId, directory: identity.directory, time: { created: identity.sessionCreated }, slug: identity.sessionSlug }])('does not replace a mismatched original identity with %j', canonical => {
    let count = 0;
    globalThis.fetch = vi.fn(async () => ++count === 1
      ? Response.json({ code: 'plan_identity_mismatch', error: 'Mismatch' }, { status: 409 })
      : Response.json(canonical)) as typeof fetch;
    return expect(createWebSessionPlansAPI().ensureRevision({ ...identity, markdown: '# Original' }))
      .rejects.toMatchObject({ code: 'plan_identity_mismatch' }).then(() => expect(count).toBe(2));
  });

  test('a second identity refusal remains a refusal without another retry', async () => {
    let count = 0;
    globalThis.fetch = vi.fn(async () => ++count === 2
      ? Response.json({ id: identity.sessionId, directory: identity.directory, time: { created: identity.sessionCreated }, slug: 'canonical' })
      : Response.json({ code: 'plan_identity_mismatch', error: 'Mismatch' }, { status: 409 })) as typeof fetch;
    await expect(createWebSessionPlansAPI().readRevision(identity)).rejects.toMatchObject({ code: 'plan_identity_mismatch' });
    expect(count).toBe(3);
  });

  test('refused current scoped metadata never retries a Plan write', async () => {
    let count = 0;
    globalThis.fetch = vi.fn(async () => ++count === 1
      ? Response.json({ code: 'plan_identity_mismatch', error: 'Mismatch' }, { status: 409 })
      : Response.json({ error: 'Session unavailable' }, { status: 404 })) as typeof fetch;
    await expect(createWebSessionPlansAPI().updateRevision({ ...identity, markdown: '# Edit', expectedVersion: 'original' }))
      .rejects.toMatchObject({ code: 'plan_identity_mismatch' });
    expect(count).toBe(2);
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
