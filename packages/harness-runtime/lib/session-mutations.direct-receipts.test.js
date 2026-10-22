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
import { withCrossProcessFileLock } from './atomic-file.js';
import { cleanupRoots, fixture, ledgerState, manyFiles, roots, SMALL_BATCHES, test, withEnv } from '../test/session-mutations-fixture.js';

afterEach(cleanupRoots);
describe('baseline content references', () => {
  const documents = async (f) => {
    const root = path.join(f.storage, changeKey(await fs.realpath(f.directory)));
    const db = await openChangeStore(root, path.join(root, 'git')), byPath = {};
    for await (const { value } of db.entries('files')) {
      if (!value.published) continue;
      const pages = [];
      for await (const { key, value: page } of db.entries(`runs/${value.id}`)) pages.push({ key: key.slice(key.lastIndexOf('/') + 1), page });
      byPath[value.published.path] = { id: value.id, pages };
    }
    return { root, db, byPath };
  };
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  // Longer than one 32 KiB inline row, with multibyte text across a row boundary.
  const large = `${'α'.repeat(20_000)}\nmiddle\n${'ω'.repeat(20_000)}\n`;

  test('untouched baselines store one content reference; edits, Revert and old hosts stay exact', async () => {
    const scenario = async () => {
      const f = await fixture();
      await f.write('large.txt', large); await f.write('small.txt', 'one\ntwo\n'); await f.write('empty.txt', '');
      const a = await f.begin('s', 'p1', 'c1');
      await fs.writeFile(path.join(a.viewDirectory, 'small.txt'), 'one\n2\n');
      await f.finish(a);
      const b = await f.begin('s', 'p2', 'c2');
      await fs.writeFile(path.join(b.viewDirectory, 'large.txt'), large.replace('middle', 'center'));
      await f.finish(b);
      const edited = { state: await ledgerState(f), large: await f.read('large.txt'), small: await f.read('small.txt') };
      await f.revert('s', 'p2');
      const reverted = { large: await f.read('large.txt'), small: await f.read('small.txt') };
      await f.revert('s', 'p1');
      return { f, outcome: { edited, reverted, original: { large: await f.read('large.txt'), small: await f.read('small.txt') }, state: await ledgerState(f) } };
    };
    const { f, outcome } = await scenario();
    const { outcome: inline } = await withEnv({ DEVRYAN_LEDGER_BASELINE_REFS: '0' }, scenario);
    expect(outcome).toEqual(inline);
    expect(outcome.edited.large).toBe(large.replace('middle', 'center'));
    expect(outcome.reverted).toEqual({ large, small: 'one\n2\n' });
    expect(outcome.original).toEqual({ large, small: 'one\ntwo\n' });

    const fresh = await fixture(); await fresh.write('large.txt', large); await fresh.write('empty.txt', '');
    await fresh.finish(await fresh.begin('s', 'p1', 'c1'));
    const { db, byPath } = await documents(fresh);
    expect(byPath['large.txt'].pages).toEqual([{ key: '0000000000.json', page: { baseline: sha(large), size: Buffer.byteLength(large) } }]);
    expect(byPath['empty.txt'].pages).toEqual([]);
    // A host predating references reads runs as arrays and fails closed.
    await expect((async () => { for await (const _ of db.list(`runs/${byPath['large.txt'].id}`)); })())
      .rejects.toMatchObject({ code: 'invalid_change_record' });
    // Edited documents keep granular inline runs.
    expect((await documents(f)).byPath['large.txt'].pages.every(({ page }) => Array.isArray(page))).toBe(true);
  }, 600_000);

  test('maintenance compacts inline baselines in place; pinned leases and concurrent edits stay exact', async () => {
    const f = await fixture({ maintenance: { looseObjects: 1_000_000, packs: 1_000, commits: 1_000_000 } });
    await manyFiles(f, 40); await f.write('large.txt', large);
    const { pinned, before } = await withEnv({ DEVRYAN_LEDGER_BASELINE_REFS: '0' }, async () => {
      const first = await f.begin('s', 'p1', 'c1');
      await fs.writeFile(path.join(first.viewDirectory, 'd1/e1/f1.txt'), 'edited\n');
      await f.finish(first);
      // Prepared before compaction: its pinned snapshot holds inline pages.
      return { pinned: await f.begin('s', 'p2', 'c2'), before: await ledgerState(f) };
    });
    const inline = await documents(f);
    expect(inline.byPath['large.txt'].pages.map(({ page }) => page.length)).toEqual([3]);
    expect(Object.values(inline.byPath).some(({ pages }) => pages.some(({ page }) => !Array.isArray(page)))).toBe(false);

    // A writer lands while candidates are read outside the lock: its document
    // must keep the writer's runs, and the pass must not claim completion.
    const lstat = fs.lstat.bind(fs);
    let concurrent = null;
    const probe = spyOn(fs, 'lstat').mockImplementation(async (file, ...rest) => {
      if (!concurrent && String(file).includes(`${path.sep}objects${path.sep}`)) {
        concurrent = (async () => {
          const lease = await f.begin('t', 'q1', 'd1');
          await fs.writeFile(path.join(lease.viewDirectory, 'large.txt'), large.replace('middle', 'concurrent'));
          return f.finish(lease);
        })();
        await concurrent;
      }
      return lstat(file, ...rest);
    });
    try { await f.runtime.maintainLedger({ directory: f.directory }); }
    finally { probe.mockRestore(); }
    expect((await concurrent).files).toEqual([{ path: 'large.txt', status: 'modified' }]);
    const stamp = path.join(inline.root, 'baseline-refs');
    await expect(fs.access(stamp)).rejects.toMatchObject({ code: 'ENOENT' });
    const compacted = await documents(f);
    expect(compacted.byPath['large.txt'].pages.every(({ page }) => Array.isArray(page))).toBe(true);
    expect(compacted.byPath['d1/e1/f1.txt'].pages.every(({ page }) => Array.isArray(page))).toBe(true);
    expect(compacted.byPath['d0/e0/f0.txt'].pages).toEqual([{ key: '0000000000.json',
      page: { baseline: sha('line 0\n'), size: 7 } }]);
    expect(await f.read('large.txt')).toBe(large.replace('middle', 'concurrent'));
    const after = await ledgerState(f);
    expect(after['large.txt'].revisions).toBe(before['large.txt'].revisions + 1);
    expect({ ...after, 'large.txt': before['large.txt'] }).toEqual(before);
    // Nothing left to convert: the next pass completes.
    await f.runtime.maintainLedger({ directory: f.directory });
    await fs.access(stamp);

    // The lease prepared from inline pages publishes onto compacted state.
    await fs.writeFile(path.join(pinned.viewDirectory, 'd0/e0/f0.txt'), 'line 0\nadded\n');
    expect((await f.finish(pinned)).files).toEqual([{ path: 'd0/e0/f0.txt', status: 'modified' }]);
    expect(await f.read('large.txt')).toBe(large.replace('middle', 'concurrent'));
    await f.revert('t', 'q1');
    expect(await f.read('large.txt')).toBe(large);
    await f.revert('s', 'p2');
    expect(await f.read('d0/e0/f0.txt')).toBe('line 0\n');
    await f.revert('s', 'p1');
    expect(await f.read('d1/e1/f1.txt')).toBe('line 1\nline 1\n');
  }, 600_000);
});

describe('direct receipts for native read-only tools', () => {
  const digest = 'a'.repeat(64);
  const scope = (f, call, user = 'pd') => ({ directory: f.directory, sessionID: 's', userMessageID: user, messageID: `${user}-assistant`, callID: call });
  const outcome = async (f, call, user = 'pd') => (await f.runtime.executionOutcomes({ directory: f.directory, sessionID: 's',
    calls: [{ messageID: `${user}-assistant`, callID: call }] }))[0].outcome;

  test('queued finish pins its directory and identity before caller mutation, including calls without a meter', async () => {
    const f = await fixture(), other = await fixture();
    const input = { ...scope(f, 'captured'), token: randomUUID(), generation: 0, executionFingerprint: digest };
    const original = { ...input }, receipt = f.runtime.finishDirect(input);
    input.directory = other.directory; input.sessionID = 'foreign'; input.callID = 'foreign'; input.token = randomUUID();
    expect((await receipt).operationID).toBeString();
    await new Promise(resolve => setImmediate(resolve));
    expect(await outcome(f, original.callID)).toBe('finished');
    expect((await f.runtime.executionOutcomes({ directory: other.directory, sessionID: original.sessionID,
      calls: [{ messageID: original.messageID, callID: original.callID }] }))[0].outcome).toBe('uncertain');
  });

  test('parallel finishes share one durable commit while a failed call leaves no staged prompt or sequence', async () => {
    const timings = [], f = await fixture({ onLockTiming: record => timings.push(record) });
    await f.runtime.registerPrompt({ ...scope(f, 'seed'), userMessageID: 'pd' });
    timings.length = 0;
    const input = call => ({ ...scope(f, call), token: randomUUID(), generation: 0, executionFingerprint: digest });
    const good = [input('c1'), input('c2'), input('c3')];
    const bad = { ...input('bad'), userMessageID: 'failed-new-prompt', messageID: 'failed-new-prompt-assistant', generation: 9 };
    const results = await Promise.allSettled([f.runtime.finishDirect(good[0]), f.runtime.finishDirect(bad),
      f.runtime.finishDirect(good[1]), f.runtime.finishDirect(good[2])]);
    expect(results.map(row => row.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
    expect(results[1].reason.code).toBe('execution_reverted');
    expect(timings.filter(row => row.operation === 'finishDirect' && row.wrote)).toHaveLength(1);
    const restarted = createSessionMutationRuntime({ directory: f.storage });
    for (const item of good) expect((await restarted.executionOutcomes({ directory: f.directory, sessionID: 's',
      calls: [{ messageID: item.messageID, callID: item.callID }] }))[0].outcome).toBe('finished');
    const root = path.join(f.storage, changeKey(await fs.realpath(f.directory)));
    const db = await openChangeStore(root, path.join(root, 'git'));
    expect(await db.get(`prompts/${changeKey('s\0failed-new-prompt')}.json`)).toBeNull();
    expect((await db.get('meta.json')).sequence).toBe(4);
  });

  test('finishes arriving as separate requests while the lock is held share one commit', async () => {
    const timings = [], f = await fixture({ onLockTiming: record => timings.push(record) });
    await f.runtime.registerPrompt({ ...scope(f, 'seed'), userMessageID: 'pd' });
    timings.length = 0;
    const lockPath = path.join(f.storage, changeKey(await fs.realpath(f.directory)), 'owner.lock');
    let release, held;
    const holding = new Promise(resolve => { held = resolve; });
    const owner = withCrossProcessFileLock(lockPath, () => { held(); return new Promise(resolve => { release = resolve; }); });
    await holding;
    const finishes = [];
    for (const call of ['s1', 's2', 's3', 's4']) {
      finishes.push(f.runtime.finishDirect({ ...scope(f, call), token: randomUUID(), generation: 0, executionFingerprint: digest }));
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    release(); await owner;
    expect((await Promise.all(finishes)).every(result => typeof result.operationID === 'string')).toBe(true);
    expect(timings.filter(row => row.operation === 'finishDirect')).toHaveLength(1);
    expect(timings.filter(row => row.operation === 'finishDirect' && row.wrote)).toHaveLength(1);
    for (const call of ['s1', 's2', 's3', 's4']) expect(await outcome(f, call)).toBe('finished');
    // The next arrival starts a new batch rather than joining a committed one.
    await f.runtime.finishDirect({ ...scope(f, 's5'), token: randomUUID(), generation: 0, executionFingerprint: digest });
    expect(timings.filter(row => row.operation === 'finishDirect' && row.wrote)).toHaveLength(2);
  });

  test('a failed shared commit acknowledges no call and all original tokens remain retryable', async () => {
    const f = await fixture(); await f.runtime.registerPrompt(scope(f, 'seed'));
    const inputs = ['c1', 'c2'].map(call => ({ ...scope(f, call), token: randomUUID(), generation: 0, executionFingerprint: digest }));
    const write = fs.writeFile.bind(fs), blocked = spyOn(fs, 'writeFile').mockImplementation(async (file, ...args) => {
      if (String(file).includes('.metadata-index.blobs')) throw new Error('fixture commit unavailable');
      return write(file, ...args);
    });
    try {
      const failed = await Promise.allSettled(inputs.map(input => f.runtime.finishDirect(input)));
      expect(failed.every(row => row.status === 'rejected' && row.reason.message === 'fixture commit unavailable')).toBe(true);
    } finally { blocked.mockRestore(); }
    for (const input of inputs) expect(await outcome(f, input.callID)).toBe('uncertain');
    const results = await Promise.all(inputs.map(input => f.runtime.finishDirect(input)));
    expect(results).toHaveLength(2);
    for (const input of inputs) expect(await outcome(f, input.callID)).toBe('finished');
  });

  test('one caller cancellation cannot cancel another finish or acknowledge its own receipt', async () => {
    const f = await fixture(); await f.runtime.registerPrompt(scope(f, 'seed'));
    const controller = new AbortController();
    const input = call => ({ ...scope(f, call), token: randomUUID(), generation: 0, executionFingerprint: digest });
    const cancelled = withExecutionAdmission({}, () => f.runtime.finishDirect(input('cancelled')), { signal: controller.signal });
    controller.abort(Object.assign(new Error('fixture cancelled'), { code: 'fixture_cancelled' }));
    const results = await Promise.allSettled([cancelled, f.runtime.finishDirect(input('valid'))]);
    expect(results[0].status).toBe('rejected'); expect(results[1].status).toBe('fulfilled');
    expect(await outcome(f, 'cancelled')).toBe('uncertain'); expect(await outcome(f, 'valid')).toBe('finished');
  });

  test('admission commits nothing; one finish records a finished, cleaned receipt; retries are idempotent', async () => {
    const f = await fixture(); await f.write('a.txt', 'a');
    const { generation } = await f.runtime.admitDirect(scope(f, 'c1'));
    expect(await outcome(f, 'c1')).toBe('uncertain');
    const token = randomUUID();
    const result = await f.runtime.finishDirect({ ...scope(f, 'c1'), token, generation, executionFingerprint: digest });
    expect(result.files).toEqual([]);
    expect(await f.runtime.finishDirect({ ...scope(f, 'c1'), token, generation, executionFingerprint: digest })).toEqual(result);
    await expect(f.runtime.finishDirect({ ...scope(f, 'c1'), token: randomUUID(), generation, executionFingerprint: digest }))
      .rejects.toMatchObject({ code: 'capture_identity_mismatch' });
    expect(await outcome(f, 'c1')).toBe('finished');
    await expect(f.runtime.admitDirect(scope(f, 'c1'))).rejects.toMatchObject({ code: 'execution_already_started' });
    expect(await f.runtime.pendingCleanup({ directory: f.directory })).toEqual([]);
    expect((await f.runtime.executionReceipt({ directory: f.directory, token })).files).toEqual([]);
  });

  test('a revert or cancellation between admission and finish fences the receipt; a crash leaves it uncertain', async () => {
    const f = await fixture(); await f.write('a.txt', 'before');
    const lease = await f.begin('s', 'p0', 'c0');
    await fs.writeFile(path.join(lease.viewDirectory, 'a.txt'), 'after');
    await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'), JSON.stringify({ terminated: true, confined: true, cancelled: false, exitCode: 0 }), { flag: 'wx', mode: 0o600 });
    await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' });
    await f.finish(lease);
    const admitted = await f.runtime.admitDirect(scope(f, 'c1', 'p1'));
    await f.revert('s', 'p0');
    await expect(f.runtime.finishDirect({ ...scope(f, 'c1', 'p1'), token: randomUUID(), generation: admitted.generation, executionFingerprint: digest }))
      .rejects.toMatchObject({ code: 'execution_reverted' });
    expect(await outcome(f, 'c1', 'p1')).toBe('uncertain');

    const again = await f.runtime.admitDirect(scope(f, 'c2', 'p2'));
    await f.runtime.cancelUnstartedCall(scope(f, 'c2', 'p2'));
    await expect(f.runtime.finishDirect({ ...scope(f, 'c2', 'p2'), token: randomUUID(), generation: again.generation, executionFingerprint: digest }))
      .rejects.toMatchObject({ code: 'execution_cancelled' });

    // Admitted, then the process died before finishing: no record at all.
    await f.runtime.admitDirect(scope(f, 'c3', 'p3'));
    const restarted = createSessionMutationRuntime({ directory: f.storage });
    expect((await restarted.executionOutcomes({ directory: f.directory, sessionID: 's',
      calls: [{ messageID: 'p3-assistant', callID: 'c3' }] }))[0].outcome).toBe('uncertain');
  });
});
