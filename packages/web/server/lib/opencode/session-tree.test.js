import { describe, expect, it } from 'vitest';

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

    const statuses = await listSessionStatuses({ directory: '/repo', buildOpenCodeUrl, getOpenCodeAuthHeaders: () => ({}), fetchImpl: withStatuses.fetchImpl });

    expect(statuses).toEqual({ a: { type: 'busy' }, b: { type: 'idle' }, c: { type: 'retry', attempt: 2, message: 'x' } });
    expect(Object.values(statuses).filter(isActiveSessionStatus).map((status) => status.type)).toEqual(['busy', 'retry']);

    const missing = createFakeFetch({});
    await expect(listSessionStatuses({ directory: '/repo', buildOpenCodeUrl, getOpenCodeAuthHeaders: () => ({}), fetchImpl: missing.fetchImpl })).resolves.toEqual({});

    const failing = createFakeFetch({ '/session/status': new Error('down') });
    await expect(listSessionStatuses({ directory: '/repo', buildOpenCodeUrl, getOpenCodeAuthHeaders: () => ({}), fetchImpl: failing.fetchImpl })).rejects.toThrow('Cannot read session status (status 500)');
  });
});
