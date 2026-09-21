import { describe, expect, test } from 'vitest';
import { createSessionActivityGate } from './session-activity-gate.js';
import { createSessionRetention, retentionTrees } from './session-retention.js';

const now = Date.now(), old = now - 90 * 86_400_000;
const row = (id, extra = {}) => ({ id, directory: '/fixture', time: { updated: old, created: old }, ...extra });
const recent = Array.from({ length: 5 }, (_, i) => row(`recent${i}`, { time: { updated: now } }));
const snapshot = (rows) => ({ protocol: 1, complete: true, instanceID: 'runtime-a', sessions: [...recent, ...rows] });

describe('retention admission and selection', () => {
  test('accepted asynchronous work holds admission after its HTTP response', async () => {
    const gate = createSessionActivityGate();
    const settle = gate.enter(['root', 'child']);
    // A 202 response does not call settle().
    expect(() => gate.hold(['child'])).toThrow('session_active');
    settle(); settle();
    const release = gate.hold(['root', 'child']);
    expect(() => gate.enter(['child'])).toThrow('session_retention_in_progress');
    release(); expect(() => gate.enter(['child'])()).not.toThrow();
  });
  test('connected unknown clients block; staged selection protects both rows until acknowledgement', () => {
    const gate = createSessionActivityGate();
    const close = gate.connect({ url: '/api/global/event?clientID=client_1234' });
    expect(() => gate.selections()).toThrow('client_selection_unknown');
    gate.select('client_1234', 'old', 1, true);
    gate.select('client_1234', 'new', 2);
    expect([...gate.selections()].sort()).toEqual(['new', 'old']);
    gate.select('client_1234', 'new', 2, true);
    expect([...gate.selections()]).toEqual(['new']);
    expect(() => gate.select('client_1234', 'old', 1, true)).toThrow('selection_superseded');
    close(); expect([...gate.selections()]).toEqual(['new']);
  });
  test('a descendant protects its whole tree, including ancestors', () => {
    const trees = retentionTrees(snapshot([row('root'), row('child', { parentID: 'root', share: { url: 'shared' } })]), { days: 30, now });
    expect(trees.find((tree) => tree.rootID === 'root').reason).toBe('shared_session');
  });
  test('unknown ancestors, cycles and truncated snapshots fail closed', () => {
    for (const data of [snapshot([row('child', { parentID: 'missing' })]),
      snapshot([row('one', { parentID: 'two' }), row('two', { parentID: 'one' })]), { ...snapshot([]), complete: false }]) {
      expect(() => retentionTrees(data, { days: 30, now })).toThrow('session_tree_incomplete');
    }
  });
  test('archived-only policy uses archive time and requires explicit opt-in', () => {
    const data = snapshot([row('archived', { time: { updated: old, archived: now } })]);
    expect(retentionTrees(data, { days: 30, now }).at(-1).reason).toBe('archive_policy');
    expect(retentionTrees(data, { days: 30, now, archivedOnly: true }).at(-1).reason).toBe('recent_session');
  });
});

function fixture({ onRequest, ...overrides } = {}) {
  const gate = createSessionActivityGate(); const calls = [];
  const settings = { autoDeleteEnabled: true, autoDeleteAfterDays: 30, sessionRetentionAction: 'archive' };
  const data = snapshot([row('root'), row('child', { parentID: 'root' })]);
  const retention = createSessionRetention({ gate, readSettings: async () => settings, isExclusive: () => true,
    buildOpenCodeUrl: (pathname) => `http://fixture${pathname}`, getOpenCodeAuthHeaders: () => ({}),
    getControlToken: async () => 'private-test-token', getDirectory: () => '/fixture', protectedSessions: async () => [],
    checkLedger: async () => {}, fetchImpl: async (url, options) => {
      const body = options.body && JSON.parse(options.body); calls.push({ path: url.pathname, body });
      const intercepted = await onRequest?.(url, body);
      if (intercepted) return intercepted;
      if (url.pathname.endsWith('revert-capabilities')) return Response.json({ sessionRetention: 1 });
      if (url.pathname.endsWith('retention-control')) {
        if (body.action === 'snapshot') return Response.json(data);
        if (body.action === 'hold') return Response.json({ token: 'hold' });
        if (body.action === 'release') return Response.json({ released: true });
        expect(() => gate.enter(['child'])).toThrow('session_retention_in_progress');
        return Response.json({ completed: body.ids, failed: [] });
      }
      return Response.json(url.pathname.endsWith('/status') ? {} : []);
    }, ...overrides });
  return { retention, calls, settings, data, gate };
}

describe('server retention', () => {
  test('rechecks under a tree hold and archives children before their parent', async () => {
    const f = fixture(); const result = await f.retention.run();
    expect(result.completed).toEqual(['child', 'root']);
    expect(f.calls.filter((call) => call.body?.action === 'snapshot')).toHaveLength(2);
    expect(f.calls.at(-1).body.action).toBe('release');
  });
  test('missing status and uncoordinated runtimes never mutate', async () => {
    const missing = fixture({ fetchImpl: async () => new Response('', { status: 404 }) });
    expect((await missing.retention.run()).completed).toEqual([]);
    const external = fixture({ isExclusive: () => false });
    expect((await external.retention.run()).skipped[0].reason).toBe('runtime_uncoordinated');
    expect(external.calls).toEqual([]);
  });
  test('disabling during verification stops new mutations and releases the hold', async () => {
    let f; f = fixture({ checkLedger: async () => { f.settings.autoDeleteEnabled = false; } });
    const result = await f.retention.run();
    expect(result.completed).toEqual([]);
    expect(result.skipped.some((entry) => entry.reason === 'disabled')).toBe(true);
    expect(f.calls.some((call) => call.body?.action === 'archive')).toBe(false);
    expect(() => f.gate.enter(['root'])()).not.toThrow();
  });
  test('captured execution or recovery uncertainty is a skip with a reason', async () => {
    const f = fixture({ checkLedger: async () => { throw Object.assign(new Error(), { code: 'captured_execution_active' }); } });
    const result = await f.retention.run();
    expect(result.completed).toEqual([]);
    expect(result.skipped.some((entry) => entry.reason === 'captured_execution_active')).toBe(true);
  });
  test('disabling drains an accepted mutation and prevents a second batch', async () => {
    let finish, accepted;
    const started = new Promise((resolve) => { accepted = resolve; });
    const f = fixture({ onRequest: async (_url, body) => {
      if (body?.action === 'archive') {
        accepted();
        return new Promise((resolve) => { finish = () => resolve(Response.json({ completed: body.ids, failed: [] })); });
      }
    } });
    const batch = f.retention.run(); await started;
    f.settings.autoDeleteEnabled = false;
    expect(() => f.gate.enter(['root'])).toThrow('session_retention_in_progress');
    expect((await f.retention.run()).skipped[0].reason).toBe('running');
    finish(); expect((await batch).completed).toEqual(['child', 'root']);
    expect(() => f.gate.enter(['root'])()).not.toThrow();
    expect((await f.retention.run()).skipped[0].reason).toBe('disabled');
  });
  test('a lost mutation response keeps the hold until native settlement is confirmed', async () => {
    let confirm, draining;
    const started = new Promise((resolve) => { draining = resolve; });
    const f = fixture({ onRequest: async (_url, body) => {
      if (body?.action === 'archive') throw new Error('lost response');
      if (body?.action === 'release') {
        draining();
        return new Promise((resolve) => { confirm = () => resolve(Response.json({ released: true })); });
      }
    } });
    const batch = f.retention.run(); await started;
    expect(() => f.gate.enter(['child'])).toThrow('session_retention_in_progress');
    confirm();
    expect((await batch).failed).toContainEqual({ id: 'root', reason: 'mutation_unconfirmed' });
    expect(() => f.gate.enter(['child'])()).not.toThrow();
  });
  test('runtime restart after a hold invalidates the tree and releases local admission', async () => {
    let snapshots = 0;
    const f = fixture({ onRequest: async (_url, body) => {
      if (body?.action === 'snapshot' && ++snapshots > 1) return Response.json({ ...snapshot([]), instanceID: 'runtime-b' });
      if (body?.action === 'release') return Response.json({ error: 'runtime_restarted' });
    } });
    expect((await f.retention.run()).skipped).toContainEqual({ id: 'root', reason: 'runtime_restarted' });
    expect(f.calls.some((call) => call.body?.action === 'archive')).toBe(false);
    expect(() => f.gate.enter(['root'])()).not.toThrow();
  });
});
