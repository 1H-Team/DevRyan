import { describe, expect, it } from 'vitest';

import { OPENCODE_CLIENT_ERROR_CODES as C } from './errors.js';
import { createOpenCodeClient } from './index.js';
import { V2_MAX_PAGES, V2_STATUS_LOOKUP_LIMIT } from './v2.js';

const runtime = () => ({ generation: 2, baseUrl: 'http://fixture.invalid', epoch: 1 });
const session = (id, directory = '/repo') => ({ id, title: id, location: { directory }, time: { created: 1, updated: 1 } });
const page = (data, next) => Response.json({ data, cursor: next ? { next } : {} });

describe('complete v2 snapshots', () => {
  it('fails a directory status snapshot when an active session lookup fails', async () => {
    const client = createOpenCodeClient({
      getRuntime: runtime,
      fetchImpl: async (url) => new URL(url).pathname === '/api/session/active'
        ? Response.json({ data: { ses_active: {} } })
        : Response.json({ _tag: 'ServiceUnavailableError' }, { status: 503 }),
    });
    await expect(client.sessions.status({ directory: '/repo' })).rejects.toMatchObject({ code: C.unavailable, statusCode: 503 });
  });

  it('makes bounded lookup progress without returning an incomplete active map', async () => {
    const ids = Array.from({ length: V2_STATUS_LOOKUP_LIMIT + 1 }, (_, i) => `ses_${i}`);
    const reads = [];
    const client = createOpenCodeClient({
      getRuntime: runtime,
      projector: { sessionStatus: () => ({ type: 'busy' }) },
      fetchImpl: async (url) => {
        const pathname = new URL(url).pathname;
        if (pathname === '/api/session/active') return Response.json({ data: Object.fromEntries(ids.map((id) => [id, {}])) });
        const id = pathname.split('/').at(-1);
        reads.push(id);
        return Response.json({ data: session(id) });
      },
    });
    await expect(client.sessions.status({ directory: '/repo' })).rejects.toMatchObject({ code: C.unavailable, retryable: true });
    expect(reads).toHaveLength(V2_STATUS_LOOKUP_LIMIT);
    expect(Object.keys(await client.sessions.status({ directory: '/repo' }))).toEqual(ids);
    expect(reads).toHaveLength(ids.length);
  });

  it.each([null, { id: 'ses_a' }])('fails closed when an active session has no resolved location: %j', async (info) => {
    const client = createOpenCodeClient({
      getRuntime: runtime,
      fetchImpl: async (url) => {
        if (new URL(url).pathname === '/api/session/active') return Response.json({ data: { ses_a: {} } });
        return info ? Response.json({ data: info }) : new Response(null, { status: 404 });
      },
    });
    await expect(client.sessions.status({ directory: '/repo' })).rejects.toMatchObject({ code: C.unavailable });
  });

  it('preserves cancellation during unknown-location resolution', async () => {
    const controller = new AbortController();
    const client = createOpenCodeClient({
      getRuntime: runtime,
      fetchImpl: async (url, init) => {
        if (new URL(url).pathname === '/api/session/active') return Response.json({ data: { ses_a: {} } });
        controller.abort(new Error('Cancelled lookup'));
        init.signal.throwIfAborted();
      },
    });
    await expect(client.sessions.status({ directory: '/repo' }, { signal: controller.signal })).rejects.toThrow('Cancelled lookup');
  });

  it('uses options.directory and follows short native pages for enumeration', async () => {
    const calls = [];
    const client = createOpenCodeClient({
      getRuntime: runtime,
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        calls.push(parsed);
        return parsed.searchParams.has('cursor') ? page([session('ses_b')]) : page([session('ses_a')], 'older');
      },
    });
    expect((await client.sessions.list({}, { directory: '/repo' })).map((row) => row.id)).toEqual(['ses_a', 'ses_b']);
    expect(calls[0].searchParams.get('directory')).toBe('/repo');
    expect(calls[1].searchParams.get('cursor')).toBe('older');
    expect(calls[1].searchParams.has('directory')).toBe(false);
  });

  it('rejects an incomplete capped enumeration instead of returning partial ownership', async () => {
    let reads = 0;
    const client = createOpenCodeClient({ getRuntime: runtime, fetchImpl: async () => page([session(`ses_${++reads}`)], `cursor_${reads}`) });
    await expect(client.sessions.list()).rejects.toMatchObject({ code: C.unavailable, retryable: true });
    expect(reads).toBe(V2_MAX_PAGES);
  });

  it('rejects a repeated native cursor without looping to the page cap', async () => {
    let reads = 0;
    const client = createOpenCodeClient({ getRuntime: runtime, fetchImpl: async () => { reads += 1; return page([], 'stuck'); } });
    await expect(client.sessions.list()).rejects.toMatchObject({ code: C.invalidResponse });
    expect(reads).toBe(2);
  });
});
