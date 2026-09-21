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
    sent.push(args);
    if (args[0] === 'new' && !args[2]) await stage.promise;
  }, () => current);
  selection.select('new', () => { current = 'new'; applied.push('new'); }, (error) => { throw error; });
  await Promise.resolve();
  void selection.observe('old');
  stage.resolve(); await selection.settled();
  expect(applied).toEqual(['new']);
  expect(sent.map(([id, , committed]) => [id, committed])).toEqual([['new', false], ['new', true]]);
});

test('rapid selection changes never display an unprotected or superseded session', async () => {
  let current: string | null = null;
  const first = deferred();
  const applied: string[] = [], sent: Array<[string | null, number, boolean]> = [];
  const selection = createRetentionSelection(async (...args) => { sent.push(args); if (args[0] === 'a') await first.promise; }, () => current);
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
  await selection.observe('promoted'); await selection.observe('clicked');
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
