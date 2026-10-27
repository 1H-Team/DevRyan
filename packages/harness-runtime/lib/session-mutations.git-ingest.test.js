import { afterEach, describe, expect, spyOn } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from './session-changes-git.js';
import { createSessionMutationRuntime } from './session-mutations.js';
import { createSessionChangeRuntime } from './session-changes.js';
import { openChangeStore, changeKey } from './session-changes-store.js';
import { withExecutionAdmission } from './execution-admission.js';
import { cleanupRoots, fixture, ledgerState, manyFiles, roots, SMALL_BATCHES, test, withEnv } from '../test/session-mutations-fixture.js';

afterEach(cleanupRoots);
test('a tracked directory replaced by a file is observed as that file, not a blocked project', async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.directory, 'd')); await f.write('d/x', 'inside');
  const first = await f.begin('s', 'p0', 'c0');
  await f.runtime.claimLease({ directory: f.directory, token: first.token, kind: 'process' });
  await f.finish(first);
  await fs.rm(path.join(f.directory, 'd'), { recursive: true }); await f.write('d', 'now a file');
  const next = await f.begin('s', 'p1', 'c1');
  expect(await fs.readFile(path.join(next.viewDirectory, 'd'), 'utf8')).toBe('now a file');
});

test('views clone verified objects and publication reuses only provably untouched files', async () => {
  const f = await fixture();
  await f.write('same.txt', 'aaaa'); await f.write('rewrite.txt', 'bbbb'); await f.write('mode.txt', 'cccc');
  const lease = await f.begin('a', 'pa', 'ca');
  const view = (name) => path.join(lease.viewDirectory, name);
  expect(await fs.readFile(view('same.txt'), 'utf8')).toBe('aaaa');
  // Same size, same second: only ctime/inode can reveal these edits.
  await fs.writeFile(view('rewrite.txt'), 'BBBB');
  await fs.chmod(view('mode.txt'), 0o755);
  const result = await f.finish(lease);
  expect(result.files.map((file) => file.path).sort()).toEqual(['mode.txt', 'rewrite.txt']);
  expect(await f.read('rewrite.txt')).toBe('BBBB');
  expect((await fs.stat(path.join(f.directory, 'mode.txt'))).mode & 0o111).not.toBe(0);
  expect(await f.read('same.txt')).toBe('aaaa');
});

test('a corrupted object store entry fails view preparation instead of being cloned', async () => {
  const f = await fixture();
  await f.write('x.txt', 'original');
  const first = await f.begin('a', 'pa', 'ca'); await f.finish(first);
  const objects = [];
  const walk = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (path.basename(path.dirname(full)) === 'objects' && /^[a-f0-9]{64}$/.test(entry.name)) objects.push(full);
    }
  };
  await walk(f.storage);
  expect(objects.length).toBeGreaterThan(0);
  // A fresh process has no verification cache; corrupt every stored object.
  for (const object of objects) { await fs.chmod(object, 0o600); await fs.writeFile(object, 'corrupted'); }
  const reopened = createSessionMutationRuntime({ directory: f.storage });
  await expect(reopened.begin({ directory: f.directory, sessionID: 'b', userMessageID: 'pb', messageID: 'pb-assistant', callID: 'cb' }))
    .rejects.toMatchObject({ code: 'invalid_change_record' });
});

test('cached repository resolution notices a nested repository and a replaced .git', async () => {
  const f = await fixture();
  const sub = path.join(f.directory, 'pkg'); await fs.mkdir(sub);
  const real = await fs.realpath(f.directory);
  expect(await f.runtime.projectDirectory({ directory: sub })).toBe(real);
  expect(await f.runtime.projectDirectory({ directory: sub })).toBe(real);
  await git(sub, ['init', '--quiet']);
  expect(await f.runtime.projectDirectory({ directory: sub })).toBe(await fs.realpath(sub));
  await fs.rm(path.join(sub, '.git'), { recursive: true, force: true });
  expect(await f.runtime.projectDirectory({ directory: sub })).toBe(real);
});
test('fast first ingest records exactly the ledger the listing path records, across install batches', async () => {
  // 153 rows cross three 64-row first-build batches and five 32-row listing batches.
  const fast = await fixture({ batching: SMALL_BATCHES }), legacy = await fixture({ batching: SMALL_BATCHES });
  await manyFiles(fast, 150); await manyFiles(legacy, 150);
  await fast.finish(await fast.begin('a', 'pa', 'ca'));
  await withEnv({ DEVRYAN_LEDGER_FAST_INGEST: '0' }, async () => legacy.finish(await legacy.begin('a', 'pa', 'ca')));
  const [fastState, legacyState] = await Promise.all([ledgerState(fast), ledgerState(legacy)]);
  expect(Object.keys(fastState).length).toBe(153);
  expect(fastState).toEqual(legacyState);
  // Later edits build on the fast baseline exactly as on the legacy one.
  for (const f of [fast, legacy]) {
    await f.write('d1/e1/f1.txt', 'changed\n');
    const lease = await f.begin('a', 'pb', 'cb');
    await fs.writeFile(path.join(lease.viewDirectory, 'd2/e2/f2.txt'), 'edited by the call\n');
    await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'), JSON.stringify({ terminated: true, confined: true, cancelled: false, exitCode: 0 }), { flag: 'wx', mode: 0o600 });
    await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' }).catch(() => {});
    const result = await f.finish(lease);
    expect(result.files).toEqual([{ path: 'd2/e2/f2.txt', status: 'modified' }]);
  }
  expect(await ledgerState(fast)).toEqual(await ledgerState(legacy));
});

test('a writer committing between first-build batches is re-read, not overwritten by carried state', async () => {
  const f = await fixture({ batching: SMALL_BATCHES }); await manyFiles(f, 150);
  const open = fs.open.bind(fs);
  let triggered = null;
  const probe = spyOn(fs, 'open').mockImplementation(async (file, ...rest) => {
    // Well after the first 64-row batch has committed (d9 sorts last), another writer lands.
    if (!triggered && String(file).endsWith(`${path.sep}f145.txt`)) {
      triggered = f.runtime.registerPrompt({ directory: f.directory, sessionID: 'other', userMessageID: 'up' });
      await triggered;
    }
    return open(file, ...rest);
  });
  try { await f.finish(await f.begin('a', 'pa', 'ca')); }
  finally { probe.mockRestore(); }
  expect(triggered).not.toBeNull();
  const state = await ledgerState(f);
  expect(Object.keys(state).length).toBe(153);
  expect(state['d0/e0/f0.txt'].text).toBe('line 0\n');
  expect(state[`d${128 % 17}/e${128 % 5}/f128.txt`].text).toBe('line 128\n');
  // The concurrent writer's record survived both install batches.
  expect((await f.runtime.capturedSessionState({ directory: f.directory, sessionID: 'other' })).captured).toBe(true);
});

test('a warm first build yields its lock to a queued call and still installs every file', async () => {
  // One 1024-row initial batch would hold the lock for the whole build.
  const f = await fixture(); await manyFiles(f, 150);
  const lstat = fs.lstat.bind(fs);
  let seen = 0, queued = null, called = false, stampedAfterCall = 0;
  const probe = spyOn(fs, 'lstat').mockImplementation(async (file, ...rest) => {
    if (called && /f\d+\.txt$/.test(String(file))) stampedAfterCall += 1;
    // Inspection stats each file three times; the fourth is the under-lock check.
    if (!queued && String(file).endsWith(`${path.sep}f100.txt`) && ++seen === 4) {
      queued = f.runtime.registerPrompt({ directory: f.directory, sessionID: 'other', userMessageID: 'up' }).then(() => { called = true; });
    }
    return lstat(file, ...rest);
  });
  try { expect(await f.runtime.warm({ directory: f.directory })).toMatchObject({ built: true }); }
  finally { probe.mockRestore(); }
  expect(queued).not.toBeNull(); await queued;
  // The call ran between batches: the warm still had rows to stamp after it.
  expect(stampedAfterCall).toBeGreaterThan(0);
  const state = await ledgerState(f);
  expect(Object.keys(state).length).toBe(153);
  expect(state[`d${149 % 17}/e${149 % 5}/f149.txt`].text).toBe('line 149\n'.repeat(2));
  expect((await f.runtime.capturedSessionState({ directory: f.directory, sessionID: 'other' })).captured).toBe(true);
});
test('warm builds a missing ledger once, skips non-repositories, and a real call reuses it', async () => {
  const f = await fixture(); await manyFiles(f, 40);
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-plain-')); roots.push(plain);
  expect(await f.runtime.warm({ directory: plain })).toEqual({ skipped: 'not-git' });
  expect(await f.runtime.warm({ directory: f.directory, maxFiles: 1 })).toEqual({ skipped: 'too-large' });
  const built = await f.runtime.warm({ directory: f.directory });
  expect(built).toMatchObject({ built: true });
  expect(await f.runtime.warm({ directory: f.directory })).toEqual({ skipped: 'already-built' });
  await f.write('d0/e0/f0.txt', 'external edit after warm\n');
  const lease = await f.begin('a', 'pa', 'ca');
  expect(await fs.readFile(path.join(lease.viewDirectory, 'd0/e0/f0.txt'), 'utf8')).toBe('external edit after warm\n');
  await fs.writeFile(path.join(lease.viewDirectory, 'd1/e1/f1.txt'), 'by the call\n');
  await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'), JSON.stringify({ terminated: true, confined: true, cancelled: false, exitCode: 0 }), { flag: 'wx', mode: 0o600 });
  await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' });
  // The external edit made before the call is not attributed to it.
  expect((await f.finish(lease)).files).toEqual([{ path: 'd1/e1/f1.txt', status: 'modified' }]);
});

test('a call that starts while a warm build runs supersedes advisory work and sees a complete view', async () => {
  // Small batches keep the warm build busy across many idle gaps while the call starts.
  const f = await fixture({ batching: SMALL_BATCHES }); await manyFiles(f, 150);
  const warming = f.runtime.warm({ directory: f.directory });
  const lease = await f.begin('a', 'pa', 'ca');
  expect(await fs.readFile(path.join(lease.viewDirectory, 'd13/e4/f149.txt'), 'utf8')).toBe('line 149\n'.repeat(2));
  const result = await warming;
  expect(result.built === true || result.skipped === 'foreground').toBe(true);
  expect(Object.keys(await ledgerState(f)).length).toBe(153);
});

test('warm enumeration is bounded even for empty directories omitted by Git', async () => {
  const f = await fixture();
  const project = await fs.realpath(f.directory);
  await Promise.all(Array.from({ length: 50 }, (_, index) => fs.mkdir(path.join(f.directory, `empty-${index}`))));
  let reads = 0;
  const readdir = fs.readdir.bind(fs), observer = spyOn(fs, 'readdir').mockImplementation(async (...args) => {
    if (String(args[0]).startsWith(project)) reads++;
    return readdir(...args);
  });
  try {
    expect(await f.runtime.warm({ directory: f.directory, maxFiles: 5 })).toEqual({ skipped: 'too-large' });
    expect(reads).toBe(1);
    await expect(f.runtime.warm({ directory: f.directory, maxFiles: Infinity })).rejects.toMatchObject({ code: 'invalid_warm_request' });
  } finally { observer.mockRestore(); await f.runtime.drain(); }
});

test('foreground observation stops a slow warm walk before unrelated directories and proves current bytes', async () => {
  const f = await fixture();
  const project = await fs.realpath(f.directory);
  await f.write('keep.txt', 'before');
  for (let index = 0; index < 12; index++) {
    await fs.mkdir(path.join(f.directory, `d${index}`));
    await f.write(`d${index}/file`, 'original');
  }
  let entered, release;
  const paused = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let pausedOnce = false, warmReads = 0;
  const readdir = fs.readdir.bind(fs), observer = spyOn(fs, 'readdir').mockImplementation(async (...args) => {
    if (String(args[0]).startsWith(project) && !pausedOnce) {
      pausedOnce = true; entered(); await gate;
    }
    if (String(args[0]).startsWith(project) && !released) warmReads++;
    return readdir(...args);
  });
  let released = false;
  const warming = f.runtime.warm({ directory: f.directory });
  try {
    await paused;
    await f.write('keep.txt', 'after reservation');
    let observing;
    const observed = new Promise(resolve => { observing = resolve; });
    const preparing = withExecutionAdmission({}, () => f.begin('foreground', 'p1', 'c1'), {
      onDiagnostic: record => { if (record.phase === 'reconciliation' && record.state === 'started') observing(); },
    });
    await observed;
    released = true; release();
    const lease = await preparing;
    expect(await warming).toEqual({ skipped: 'foreground' });
    expect(warmReads).toBe(0);
    expect(await fs.readFile(path.join(lease.viewDirectory, 'keep.txt'), 'utf8')).toBe('after reservation');
    await f.runtime.cancelLease(lease); await f.runtime.cleanupLease(lease);
  } finally { release(); observer.mockRestore(); await f.runtime.drain(); }
});

test('record caching is invisible: edits, reverts and outcomes match with the cache disabled', async () => {
  const run = async () => {
    const f = await fixture(); await manyFiles(f, 30);
    const outcomes = [];
    for (const [index, file] of ['d0/e0/f0.txt', 'd1/e1/f1.txt', 'd0/e0/f0.txt'].entries()) {
      const lease = await f.begin('s', `p${index}`, `c${index}`);
      await fs.writeFile(path.join(lease.viewDirectory, file), `edit ${index}\n`);
      await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'), JSON.stringify({ terminated: true, confined: true, cancelled: false, exitCode: 0 }), { flag: 'wx', mode: 0o600 });
      await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' });
      outcomes.push((await f.finish(lease)).files);
      await f.runtime.cleanupLease({ directory: f.directory, token: lease.token });
    }
    await f.revert('s', 'p1');
    outcomes.push(await f.read('d0/e0/f0.txt'), await f.read('d1/e1/f1.txt'));
    return { outcomes, state: await ledgerState(f) };
  };
  const cached = await run();
  const uncached = await withEnv({ DEVRYAN_LEDGER_RECORD_CACHE: '0', DEVRYAN_LEDGER_SNAPSHOT_REUSE: '0' }, run);
  expect(cached).toEqual(uncached);
});

test('background packing keeps the ledger exact, including while a call runs concurrently', async () => {
  // The concurrent run keeps the production prune grace: a grace of 'now'
  // may remove a running call's not yet published objects.
  const limits = { looseObjects: 5, packs: 2, commits: 1_000 };
  const f = await fixture({ maintenance: limits });
  await manyFiles(f, 60);
  const root = path.join(f.storage, changeKey(await fs.realpath(f.directory)));
  const objects = async () => Object.fromEntries((await git(root, ['--git-dir', path.join(root, 'git'), 'count-objects', '-v'])).toString()
    .trim().split('\n').map((line) => line.split(': ')).map(([name, value]) => [name, Number(value)]));
  const call = async (index, file) => {
    const lease = await f.begin('s', `p${index}`, `c${index}`);
    await fs.writeFile(path.join(lease.viewDirectory, file), `edit ${index}\n`);
    await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'), JSON.stringify({ terminated: true, confined: true, cancelled: false, exitCode: 0 }), { flag: 'wx', mode: 0o600 });
    await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' });
    const result = await f.finish(lease);
    await f.runtime.cleanupLease({ directory: f.directory, token: lease.token });
    return result.files;
  };
  expect(await call(0, 'd0/e0/f0.txt')).toEqual([{ path: 'd0/e0/f0.txt', status: 'modified' }]);
  const before = await ledgerState(f);
  expect((await objects()).count).toBeGreaterThan(5);
  // First run packs loose objects; a concurrent call must be unaffected.
  const [, concurrent] = await Promise.all([f.runtime.maintainLedger({ directory: f.directory }), call(1, 'd1/e1/f1.txt')]);
  expect(concurrent).toEqual([{ path: 'd1/e1/f1.txt', status: 'modified' }]);
  await createSessionMutationRuntime({ directory: f.storage, maintenance: { ...limits, pruneExpiry: 'now' } }).maintainLedger({ directory: f.directory });
  const packed = await objects();
  expect(packed.packs).toBeGreaterThanOrEqual(1);
  // Consolidation and prune leave every reachable record readable.
  expect(await call(2, 'd0/e0/f0.txt')).toEqual([{ path: 'd0/e0/f0.txt', status: 'modified' }]);
  const after = await ledgerState(f);
  expect(await f.read('d0/e0/f0.txt')).toBe('edit 2\n');
  expect(await f.read('d1/e1/f1.txt')).toBe('edit 1\n');
  expect(after['d0/e0/f0.txt'].revisions).toBe(before['d0/e0/f0.txt'].revisions + 1);
  expect(Object.keys(after)).toEqual(Object.keys(before));
  await f.revert('s', 'p2');
  expect(await f.read('d0/e0/f0.txt')).toBe('edit 0\n');
});

test('packing can be switched off', async () => {
  const f = await fixture({ maintenance: { looseObjects: 1, packs: 1, commits: 1 } });
  await manyFiles(f, 10);
  await withEnv({ DEVRYAN_LEDGER_PACK: '0' }, async () => {
    await f.finish(await f.begin('s', 'p', 'c'));
    expect(await f.runtime.maintainLedger({ directory: f.directory })).toBeNull();
  });
  const root = path.join(f.storage, changeKey(await fs.realpath(f.directory)));
  const stats = (await git(root, ['--git-dir', path.join(root, 'git'), 'count-objects', '-v'])).toString();
  expect(stats).toMatch(/^packs: 0$/m);
});

test('maintenance prunes superseded loose objects without waiting for pack consolidation', async () => {
  const f = await fixture({ maintenance: { looseObjects: 5, packs: 1_000, commits: 1_000, pruneExpiry: 'now' } });
  await manyFiles(f, 30);
  // Finish seed packing before zero-grace pruning can race later transaction writes.
  await f.runtime.warm({ directory: f.directory });
  await f.runtime.drain();
  const root = path.join(f.storage, changeKey(await fs.realpath(f.directory))), gitDir = path.join(root, 'git');
  for (const index of [0, 1, 2]) {
    const lease = await f.begin('s', `p${index}`, `c${index}`);
    await fs.writeFile(path.join(lease.viewDirectory, 'd0/e0/f0.txt'), `edit ${index}\n`);
    await f.finish(lease);
  }
  const unreachable = async () => (await git(root, ['--git-dir', gitDir, 'prune', '--dry-run', '--expire=now'])).toString().trim();
  expect(await unreachable()).not.toBe('');
  const before = await ledgerState(f);
  await f.runtime.maintainLedger({ directory: f.directory });
  expect(await unreachable()).toBe('');
  expect((await git(root, ['--git-dir', gitDir, 'count-objects', '-v'])).toString()).toMatch(/^count: 0$/m);
  expect(await ledgerState(f)).toEqual(before);
  await f.revert('s', 'p2');
  expect(await f.read('d0/e0/f0.txt')).toBe('edit 1\n');
});
