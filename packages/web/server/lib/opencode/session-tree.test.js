import { createNativeConsumerFixture } from './test-native-consumer-client.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createLoopbackOpenCodeFixtureForGeneration } from '../../../../../scripts/perf/loopback-opencode-fixtures.mjs';
import { PERF_CHILD_SESSION_IDS, PERF_PARENT_SESSION_ID } from '../../../../../scripts/perf/fixture-session-seeds.mjs';
import { createOpenCodeClient } from './opencode-client/index.js';
import { SESSION_TREE_MAX_DEPTH, isActiveSessionStatus, listSessionStatuses, listSessionTree } from './session-tree.js';

const buildOpenCodeUrl = (requestPath) => `http://opencode.test${requestPath}`;

// Routes are keyed by pathname; a value can be a payload, a function returning
// one, an Error (→ 500) or undefined (→ 404).
const createFakeFetch = (routes) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    calls.push({ pathname, directory: searchParams.get('directory'), method: init?.method ?? 'GET' });
    const route = routes[pathname];
    const payload = typeof route === 'function' ? route() : route;
    if (payload === undefined) {
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    }
    if (payload instanceof Error) {
      return { ok: false, status: 500, json: async () => ({ error: payload.message }) };
    }
    return { ok: true, status: 200, json: async () => payload };
  };
  return { fetchImpl, calls };
};

const session = (id, parentID, extra = {}) => ({
  id,
  parentID,
  title: `title ${id}`,
  time: { created: 1, updated: 2 },
  projectID: 'project',
  ...extra,
});

const listOptions = (fetchImpl, extra = {}) => ({
  sessionID: 'root',
  directory: '/repo',
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders: () => ({ authorization: 'Bearer test' }),
  fetchImpl,
  openCodeClient: createNativeConsumerFixture({ readFixture: fetchImpl }),
  ...extra,
});

describe('listSessionTree', () => {
  it('lists the root and every descendant breadth-first with normalized entries', async () => {
    const { fetchImpl, calls } = createFakeFetch({
      '/session/root': session('root', undefined, { revert: { messageID: 'msg-1' } }),
      '/session/root/children': [session('b', 'root'), session('c', 'root')],
      '/session/b/children': [session('d', 'b')],
      '/session/c/children': [],
    });

    const tree = await listSessionTree(listOptions(fetchImpl));

    expect(tree).toEqual([
      { id: 'root', parentID: null, title: 'title root', time: { created: 1, updated: 2 }, projectID: 'project', revert: { messageID: 'msg-1' }, depth: 0 },
      { id: 'b', parentID: 'root', title: 'title b', time: { created: 1, updated: 2 }, projectID: 'project', revert: null, depth: 1 },
      { id: 'c', parentID: 'root', title: 'title c', time: { created: 1, updated: 2 }, projectID: 'project', revert: null, depth: 1 },
      { id: 'd', parentID: 'b', title: 'title d', time: { created: 1, updated: 2 }, projectID: 'project', revert: null, depth: 2 },
    ]);
    expect(calls.every((call) => call.directory === '/repo')).toBe(true);
    expect(calls.map((call) => call.pathname)).toEqual([
      '/session/root',
      '/session/root/children',
      '/session/b/children',
      '/session/c/children',
      '/session/d/children',
    ]);
  });

  it('stops descending past the depth limit', async () => {
    const routes = { '/session/root': session('root') };
    let previous = 'root';
    for (let level = 1; level <= 12; level += 1) {
      const id = `s${level}`;
      routes[`/session/${previous}/children`] = [session(id, previous)];
      previous = id;
    }
    const { fetchImpl, calls } = createFakeFetch(routes);

    const tree = await listSessionTree(listOptions(fetchImpl));

    expect(SESSION_TREE_MAX_DEPTH).toBe(8);
    expect(tree).toHaveLength(SESSION_TREE_MAX_DEPTH + 1);
    expect(tree[tree.length - 1]).toEqual(expect.objectContaining({ id: 's8', depth: 8 }));
    expect(calls.some((call) => call.pathname === '/session/s8/children')).toBe(false);

    const rootOnly = await listSessionTree(listOptions(fetchImpl, { maxDepth: 0 }));
    expect(rootOnly).toEqual([expect.objectContaining({ id: 'root', depth: 0 })]);
  });

  it('skips branches whose children lookup returns 404 and guards against cycles', async () => {
    const { fetchImpl } = createFakeFetch({
      '/session/root': session('root'),
      '/session/root/children': [session('a', 'root'), session('gone', 'root')],
      '/session/a/children': [session('root', 'a'), session('a', 'a'), { title: 'no id' }, session('leaf', 'a')],
      '/session/leaf/children': [],
    });

    const tree = await listSessionTree(listOptions(fetchImpl));

    expect(tree.map((entry) => `${entry.id}@${entry.depth}`)).toEqual(['root@0', 'a@1', 'gone@1', 'leaf@2']);
  });

  it('synthesizes the root entry when the session endpoint is unavailable', async () => {
    const { fetchImpl } = createFakeFetch({
      '/session/root/children': [{ id: 'child' }],
    });

    const tree = await listSessionTree(listOptions(fetchImpl));

    expect(tree).toEqual([
      { id: 'root', parentID: null, title: '', time: null, projectID: null, revert: null, depth: 0 },
      { id: 'child', parentID: 'root', title: '', time: null, projectID: null, revert: null, depth: 1 },
    ]);
  });

  it('surfaces non-404 failures instead of returning a partial tree', async () => {
    const { fetchImpl } = createFakeFetch({
      '/session/root': session('root'),
      '/session/root/children': new Error('boom'),
    });

    await expect(listSessionTree(listOptions(fetchImpl))).rejects.toThrow('Cannot list children of session root (status 500)');

    const failingRoot = createFakeFetch({ '/session/root': new Error('down') });
    await expect(listSessionTree(listOptions(failingRoot.fetchImpl))).rejects.toThrow('Cannot load session root (status 500)');
  });

  it('honours an aborted signal', async () => {
    const { fetchImpl } = createFakeFetch({ '/session/root': session('root') });
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(listSessionTree(listOptions(fetchImpl, { signal: controller.signal }))).rejects.toThrow('cancelled');
  });
});

describe('listSessionStatuses', () => {
  it('returns the status map and treats a missing endpoint as empty', async () => {
    const withStatuses = createFakeFetch({
      '/session/status': { a: { type: 'busy' }, b: { type: 'idle' }, c: { type: 'retry', attempt: 2, message: 'x' }, bad: 'nope' },
    });

    const statuses = await listSessionStatuses({ directory: '/repo', buildOpenCodeUrl, getOpenCodeAuthHeaders: () => ({}), fetchImpl: withStatuses.fetchImpl, openCodeClient: createNativeConsumerFixture({ readFixture: withStatuses.fetchImpl }) });

    expect(statuses).toEqual({ a: { type: 'busy' }, b: { type: 'idle' }, c: { type: 'retry', attempt: 2, message: 'x' } });
    expect(Object.values(statuses).filter(isActiveSessionStatus).map((status) => status.type)).toEqual(['busy', 'retry']);

    const missing = createFakeFetch({});
    await expect(listSessionStatuses({ directory: '/repo', buildOpenCodeUrl, getOpenCodeAuthHeaders: () => ({}), fetchImpl: missing.fetchImpl, openCodeClient: createNativeConsumerFixture({ readFixture: missing.fetchImpl }) })).resolves.toEqual({});

    const failing = createFakeFetch({ '/session/status': new Error('down') });
    await expect(listSessionStatuses({ directory: '/repo', buildOpenCodeUrl, getOpenCodeAuthHeaders: () => ({}), fetchImpl: failing.fetchImpl, openCodeClient: createNativeConsumerFixture({ readFixture: failing.fetchImpl }) })).rejects.toThrow('Cannot read session status (status 500)');
  });
});

// ---------------------------------------------------------------------------
// Generation 2: the same reads through `openCodeClient` (DESIGN.md E item 13c).

const clientError = (statusCode, code = 'opencode_http_error') => Object.assign(new Error(`failed (${statusCode})`), { statusCode, code });

const createFakeClient = ({ sessions = {}, children = {}, statuses = {}, generation = 2 } = {}) => {
  const calls = [];
  const resolve = (value) => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
  return {
    calls,
    generation: () => generation,
    sessions: {
      get: vi.fn((id, options) => {
        calls.push({ op: 'get', id, options });
        return resolve(Object.hasOwn(sessions, id) ? sessions[id] : null);
      }),
      children: vi.fn((id, options) => {
        calls.push({ op: 'children', id, options });
        return resolve(Object.hasOwn(children, id) ? children[id] : null);
      }),
      status: vi.fn((query, options) => {
        calls.push({ op: 'status', query, options });
        return resolve(statuses);
      }),
    },
  };
};

describe('listSessionTree (generation 2)', () => {
  it('reads the root and descendants through the client and never fetches', async () => {
    const { fetchImpl, calls: fetchCalls } = createFakeFetch({});
    const client = createFakeClient({
      sessions: { root: session('root', undefined, { revert: { messageID: 'msg-1' } }) },
      children: { root: [session('b', 'root'), session('c', 'root')], b: [session('d', 'b')], c: [] },
    });

    const tree = await listSessionTree(listOptions(fetchImpl, { openCodeClient: client }));

    expect(tree.map((entry) => `${entry.id}<${entry.parentID}@${entry.depth}`)).toEqual(['root<null@0', 'b<root@1', 'c<root@1', 'd<b@2']);
    expect(tree[0].revert).toEqual({ messageID: 'msg-1' });
    expect(fetchCalls).toEqual([]);
    expect(client.calls.map((call) => `${call.op} ${call.id}`)).toEqual(['get root', 'children root', 'children b', 'children c', 'children d']);
    for (const call of client.calls) expect(call.options).toMatchObject({ directory: '/repo', allowNotFound: true });
  });

  it('synthesizes a missing root, skips missing branches and keeps the depth limit', async () => {
    const client = createFakeClient({ children: { root: [{ id: 'child' }] } });

    const tree = await listSessionTree(listOptions(undefined, { openCodeClient: client }));
    expect(tree).toEqual([
      { id: 'root', parentID: null, title: '', time: null, projectID: null, revert: null, depth: 0 },
      { id: 'child', parentID: 'root', title: '', time: null, projectID: null, revert: null, depth: 1 },
    ]);

    const rootOnly = await listSessionTree(listOptions(undefined, { openCodeClient: createFakeClient(), maxDepth: 0 }));
    expect(rootOnly).toEqual([expect.objectContaining({ id: 'root', depth: 0 })]);
  });

  it('surfaces client failures with the client status instead of a partial tree', async () => {
    const failingChildren = createFakeClient({ sessions: { root: session('root') }, children: { root: clientError(503, 'opencode_unavailable') } });
    await expect(listSessionTree(listOptions(undefined, { openCodeClient: failingChildren })))
      .rejects.toThrow('Cannot list children of session root (status 503)');

    const failingRoot = createFakeClient({ sessions: { root: new Error('socket hang up') } });
    const error = await listSessionTree(listOptions(undefined, { openCodeClient: failingRoot })).catch((cause) => cause);
    expect(error.message).toBe('Cannot load session root (status 502)');
    expect(error.cause.message).toBe('socket hang up');
  });

  it('honours an aborted signal before any client call', async () => {
    const client = createFakeClient({ sessions: { root: session('root') } });
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(listSessionTree(listOptions(undefined, { openCodeClient: client, signal: controller.signal }))).rejects.toThrow('cancelled');
    expect(client.calls).toEqual([]);
  });

  it.each([undefined, {}, createFakeClient({ generation: 1 }), createFakeClient({ generation: 3 })])('refuses unsupported tree identity: %j', async openCodeClient => {
    const fetchImpl = vi.fn();
    await expect(listSessionTree(listOptions(fetchImpl, { openCodeClient }))).rejects.toMatchObject({ code: 'opencode_generation_invalid' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('listSessionStatuses (generation 2)', () => {
  it('reads non-idle statuses through the client, treats 404 as empty and reports other failures', async () => {
    const client = createFakeClient({ statuses: { a: { type: 'busy' }, c: { type: 'retry', attempt: 2, message: 'x', next: 5 }, bad: 'nope' } });
    const statuses = await listSessionStatuses({ directory: '/repo', openCodeClient: client });
    expect(statuses).toEqual({ a: { type: 'busy' }, c: { type: 'retry', attempt: 2, message: 'x', next: 5 } });
    expect(client.calls[0]).toMatchObject({ op: 'status', query: { directory: '/repo' } });

    const missing = createFakeClient({ statuses: clientError(404, 'opencode_not_found') });
    await expect(listSessionStatuses({ directory: '/repo', openCodeClient: missing })).resolves.toEqual({});

    const failing = createFakeClient({ statuses: clientError(500, 'opencode_upstream_failure') });
    await expect(listSessionStatuses({ directory: '/repo', openCodeClient: failing })).rejects.toThrow('Cannot read session status (status 500)');
  });
});

describe('session tree native wire', () => {
  it('lists the canonical native fixture tree through the real client', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'devryan-session-tree-'));
    const fixture = await createLoopbackOpenCodeFixtureForGeneration(2, { directory, heartbeatMs: 50 });
    try {
      const client = createOpenCodeClient({ getRuntime: () => ({ generation: 2, baseUrl: fixture.origin }),
        getAuthHeaders: () => ({ ...fixture.authHeaders }) });
      const tree = await listSessionTree({ sessionID: PERF_PARENT_SESSION_ID, directory, openCodeClient: client });
      expect(tree.map(entry => entry.id).sort()).toEqual([PERF_PARENT_SESSION_ID, ...PERF_CHILD_SESSION_IDS].sort());
      expect(tree[0]).toMatchObject({ id: PERF_PARENT_SESSION_ID, depth: 0 });
      expect(await listSessionStatuses({ directory, openCodeClient: client })).toEqual({});
    } finally { await fixture.close(); rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
});
