import { expect, test } from 'bun:test';
import { createRetentionSelection } from './retentionSelection';
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

test('a stale effect cannot replace a selection staged by a newer click', async () => {
  let current: string | null = 'old';
  const stage = deferred();
  const sent: Array<[string | null, number, boolean]> = [];
  const applied: string[] = [];
  const selection = createRetentionSelection(async (...args) => {
    sent.push([args[0], args[1], args[2]]);
    if (args[0] === 'new' && !args[2]) await stage.promise;
  }, () => current);
  selection.select('new', () => { current = 'new'; applied.push('new'); }, (error) => { throw error; });
  await Promise.resolve();
  await expect(selection.observe('old')).rejects.toThrow('selection_superseded');
  stage.resolve(); await selection.settled();
  expect(applied).toEqual(['new']);
  expect(sent.map(([id, , committed]) => [id, committed])).toEqual([['new', false], ['new', true]]);
});

test('rapid selection changes never display an unprotected or superseded session', async () => {
  let current: string | null = null;
  const first = deferred();
  const applied: string[] = [], sent: Array<[string | null, number, boolean]> = [];
  const selection = createRetentionSelection(async (...args) => { sent.push([args[0], args[1], args[2]]); if (args[0] === 'a') await first.promise; }, () => current);
  selection.select('a', () => { current = 'a'; applied.push('a'); }, (error) => { throw error; });
  await Promise.resolve();
  selection.select('b', () => { current = 'b'; applied.push('b'); }, (error) => { throw error; });
  first.resolve(); await selection.settled();
  expect(applied).toEqual(['b']);
  expect(sent.filter(([, , committed]) => committed).map(([id]) => id)).toEqual(['b']);
});

test('a rejected protection request reports the failure and does not switch the UI', async () => {
  const failure = new Error('Session is being retained'); const errors: Error[] = [];
  const selection = createRetentionSelection(async () => { throw failure; }, () => null);
  let applied = false;
  selection.select('a', () => { applied = true; }, error => errors.push(error));
  await selection.settled(); await Promise.resolve();
  expect(applied).toBe(false); expect(errors).toEqual([failure]);
});

test('completed and failed requests retire so passive promotions protect the authoritative selection', async () => {
  let current: string | null = 'old'; const sent: Array<[string | null, boolean]> = [];
  const selection = createRetentionSelection(async (id, _revision, committed) => { sent.push([id, committed]); }, () => current);
  selection.select('clicked', () => { current = 'clicked'; selection.navigationChanged(); }, (error) => { throw error; });
  await selection.settled();
  current = 'promoted'; selection.navigationChanged();
  await selection.observe('promoted'); await expect(selection.observe('clicked')).rejects.toThrow('selection_superseded');
  expect(sent).toEqual([['clicked', false], ['clicked', true], ['promoted', false], ['promoted', true]]);
});

test('a pending click cannot override draft A to B to A navigation with no React render', async () => {
  const gate = deferred(); let applied = false; const committed: Array<string | null> = [];
  const selection = createRetentionSelection(async (id, _revision, commit) => {
    if (commit) committed.push(id); else await gate.promise;
  }, () => null);
  selection.select('old-click', () => { applied = true; }, (error) => { throw error; });
  await Promise.resolve(); selection.navigationChanged(); selection.navigationChanged();
  gate.resolve(); await selection.settled(); await selection.observe(null);
  expect(applied).toBe(false); expect(committed).toEqual([null]);
});

test('a stalled commit cannot delay a newer selection; duplicate observers join and reuse acknowledgements', async () => {
  const commit = deferred(); let current: string | null = 'old'; const sent: string[] = [];
  const selection = createRetentionSelection(async (id, _revision, committed) => {
    sent.push(`${id}:${committed}`);
    if (id === 'a' && committed) await commit.promise;
  }, () => current);
  selection.select('a', () => { current = 'a'; }, () => {});
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(current).toBe('a');
  const observer = selection.observe('a');
  expect(selection.observe('a')).toBe(observer);
  const rejected = observer.catch(error => error);
  selection.select('b', () => { current = 'b'; }, () => {});
  await selection.settled(); expect((await rejected as Error).message).toBe('selection_superseded');
  expect(current).toBe('b');
  await selection.observe('b'); await selection.observe('b');
  expect(sent).toEqual(['a:false', 'a:true', 'b:false', 'b:true']);
  commit.resolve();
});

test('same-current clicks cancel pending navigation and null applies synchronously', async () => {
  let current: string | null = 'a'; const stage = deferred(); let callbacks = 0;
  const selection = createRetentionSelection(async (id) => { if (id === 'b') await stage.promise; }, () => current);
  selection.select('b', () => { current = 'b'; }, () => {});
  selection.select('a', () => { current = 'a'; }, () => {}, { onApplied: () => callbacks++ });
  await selection.settled(); stage.resolve();
  expect(current).toBe('a'); expect(callbacks).toBe(1);
  selection.select(null, () => { current = null; }, () => {});
  expect(current).toBeNull(); await selection.settled();
});

test('reconnection invalidates reuse and restages the pending intent without changing user priority', async () => {
  let current: string | null = 'old'; const blocked = deferred(); let stages = 0;
  const selection = createRetentionSelection(async (_id, _revision, committed) => {
    if (!committed && ++stages === 1) await blocked.promise;
  }, () => current);
  selection.select('new', () => { current = 'new'; }, () => {});
  await Promise.resolve(); const revision = selection.navigationRevision();
  selection.invalidateAcknowledgement(); await selection.settled();
  expect(current).toBe('new'); expect(selection.navigationRevision()).toBe(revision);
  await selection.observe('new'); expect(stages).toBe(2);
  selection.invalidateAcknowledgement(); await selection.observe('new'); expect(stages).toBe(3);
  blocked.resolve();
});

test('authoritative invalidation preserves unrelated pending navigation and cancels an invalid target', async () => {
  let current: string | null = 'a'; const blocked = deferred();
  const selection = createRetentionSelection(async (_id, _revision, committed) => { if (!committed) await blocked.promise; }, () => current);
  selection.select('b', () => { current = 'b'; }, () => {});
  const revision = selection.navigationRevision();
  selection.invalidateSession('a', () => { current = null; });
  expect(current).toBeNull(); expect(selection.navigationRevision()).toBe(revision);
  blocked.resolve(); await selection.settled(); expect(current).toBe('b');
  selection.select('c', () => { current = 'c'; }, () => {});
  selection.invalidateSession('c', () => { current = null; });
  await selection.settled(); expect(current).toBe('b');
});

test('delayed create, fork, restore, or rollback cannot override newer user intent', async () => {
  let current: string | null = 'a'; const selection = createRetentionSelection(async () => {}, () => current);
  const expectedNavigationRevision = selection.navigationRevision();
  selection.select('b', () => { current = 'b'; }, () => {});
  let applied = false;
  selection.select('late', () => { applied = true; current = 'late'; }, () => {}, { expectedNavigationRevision });
  await selection.settled(); expect(current).toBe('b'); expect(applied).toBe(false);
});

test('real activity gate preserves stage protection and rejects late stages and commits across revisions', async () => {
  const { createSessionActivityGate } = await import('../../../web/server/lib/opencode/session-activity-gate.js');
  const gate = createSessionActivityGate(); const clientID = 'fixture_client';
  const oldStage = deferred(), oldCommit = deferred();
  let current: string | null = 'initial'; const failures: string[] = [];
  gate.select(clientID, current, 0, true);
  const selection = createRetentionSelection(async (id, revision, committed) => {
    if (id === 'a' && !committed) await oldStage.promise;
    if (id === 'b' && committed) await oldCommit.promise;
    try { gate.select(clientID, id, revision, committed); }
    catch (error) { failures.push((error as Error).message); throw error; }
  }, () => current);
  selection.select('a', () => { current = 'a'; }, () => {});
  await Promise.resolve();
  selection.select('b', () => { current = 'b'; }, () => {});
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(gate.selections()).toEqual(new Set(['initial', 'b']));
  selection.select('c', () => { current = 'c'; }, () => {});
  await selection.settled(); expect(current).toBe('c');
  oldStage.resolve(); oldCommit.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(gate.selections()).toEqual(new Set(['c']));
  expect(failures).toEqual(['selection_superseded', 'selection_superseded']);
});
