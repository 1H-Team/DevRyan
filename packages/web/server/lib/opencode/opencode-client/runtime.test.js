import { describe, expect, it } from 'vitest';

import { createOpenCodeAdmission } from '../v2/admission.js';
import { OPENCODE_CLIENT_ERROR_CODES as C } from './errors.js';
import { createOpenCodeClient } from './index.js';

const session = (directory = '/repo') => ({ id: 'ses_a', title: 'A', location: { directory }, time: { created: 1, updated: 1 } });
const changed = { code: C.runtimeChanged, statusCode: 503, retryable: false };

describe('runtime operation scope', () => {
  it.each([
    { generation: 2, baseUrl: 'http://replacement.invalid', epoch: 1 },
    { generation: 2, baseUrl: 'http://original.invalid', epoch: 2 },
    { generation: 1, baseUrl: 'http://original.invalid', epoch: 1 },
  ])('stops archive read/write/read across replacement $generation/$baseUrl/$epoch', async (replacement) => {
    let runtime = { generation: 2, baseUrl: 'http://original.invalid', epoch: 1 };
    const calls = [];
    const admission = createOpenCodeAdmission({ getRuntime: () => runtime });
    const client = createOpenCodeClient({
      getAdmission: () => admission,
      getRuntime: () => runtime,
      fetchImpl: async (url, init) => {
        calls.push([String(url), init.method]);
        runtime = replacement;
        return Response.json({ data: session() });
      },
    });
    await expect(client.sessions.archive('ses_a', 123)).rejects.toMatchObject(changed);
    expect(calls).toEqual([['http://original.invalid/api/session/ses_a', 'GET']]);
  });

  it.each([2])('checks the identity again after awaiting auth for generation %s', async (generation) => {
    let runtime = { generation, baseUrl: 'http://original.invalid', epoch: 1 };
    let fetches = 0;
    const client = createOpenCodeClient({
      getRuntime: () => runtime,
      getAuthHeaders: async () => { runtime = { ...runtime, epoch: 2 }; return {}; },
      fetchImpl: async () => { fetches += 1; return Response.json({}); },
    });
    await expect(client.sessions.abort('ses_a')).rejects.toMatchObject(changed);
    expect(fetches).toBe(0);
  });

  it('keeps replacement operations independent of the old in-flight operation', async () => {
    let runtime = { generation: 2, baseUrl: 'http://original.invalid', epoch: 1 };
    let release;
    let started;
    const firstStarted = new Promise((resolve) => { started = resolve; });
    const firstResponse = new Promise((resolve) => { release = resolve; });
    const client = createOpenCodeClient({
      getRuntime: () => runtime,
      fetchImpl: async (url) => {
        if (new URL(url).host === 'original.invalid') { started(); return await firstResponse; }
        return Response.json({ data: session('/replacement') });
      },
    });
    const old = client.sessions.get('ses_a');
    const rejected = expect(old).rejects.toMatchObject(changed);
    await firstStarted;
    runtime = { ...runtime, baseUrl: 'http://replacement.invalid', epoch: 2 };
    expect((await client.sessions.get('ses_a')).directory).toBe('/replacement');
    release(Response.json({ data: session() }));
    await rejected;
  });

  it('scopes direct admission calls through selection and prompt dispatch', async () => {
    let runtime = { generation: 2, baseUrl: 'http://original.invalid', epoch: 1 };
    const calls = [];
    const admission = createOpenCodeAdmission({
      getRuntime: () => runtime,
      fetchImpl: async (url, init) => {
        const pathname = new URL(url).pathname;
        calls.push([pathname, init.method]);
        if (pathname.includes('/message/')) return Response.json({ _tag: 'MessageNotFoundError' }, { status: 404 });
        if (pathname.endsWith('/inbox')) return Response.json({ data: [] });
        return Response.json({ data: session() });
      },
    }, {
      toolRules: { resolve: async () => { runtime = { ...runtime, epoch: 2 }; return null; } },
    });
    await expect(admission.prompt('ses_a', {
      parts: [{ type: 'text', text: 'Do the work' }], tools: { bash: false },
    })).rejects.toMatchObject(changed);
    expect(calls.map(([pathname, method]) => [pathname.replace(/\/message\/[^/]+$/, '/message/<id>'), method])).toEqual([
      ['/api/session/ses_a/inbox', 'GET'], ['/api/session/ses_a/message/<id>', 'GET'], ['/api/session/ses_a', 'GET'],
    ]);
  });

  it('drops cached directory ownership after a same-address runtime replacement', async () => {
    let runtime = { generation: 2, baseUrl: 'http://original.invalid', epoch: 1 };
    let directory = '/original';
    let sessionReads = 0;
    const client = createOpenCodeClient({
      getRuntime: () => runtime,
      projector: { sessionStatus: () => ({ type: 'busy' }) },
      fetchImpl: async (url) => {
        if (new URL(url).pathname === '/api/session/active') return Response.json({ data: { ses_a: {} } });
        sessionReads += 1;
        return Response.json({ data: session(directory) });
      },
    });
    await client.sessions.get('ses_a');
    runtime = { ...runtime, epoch: 2 };
    directory = '/replacement';
    expect(await client.sessions.status({ directory })).toEqual({ ses_a: { type: 'busy' } });
    expect(sessionReads).toBe(2);
  });
});
