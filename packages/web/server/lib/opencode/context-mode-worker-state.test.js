import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextModeWorkerState, emptyStats, statsDelta } from './context-mode-worker-state.js';
import { ContextModeWorkerStorage } from './context-mode-worker-storage.js';

const roots = [];
const states = [];
const fixture = async (options) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-worker-state-'));
  roots.push(root);
  const state = new ContextModeWorkerState({ directory: root, ...options });
  states.push(state);
  return { root, state, request: { storagePaths: [path.join(root, 'content.db')], statsPath: path.join(root, 'stats-ses_a.json') } };
};
afterEach(async () => {
  await Promise.all(states.splice(0).map(async (state) => { await state.close(); await state.dispose(); }));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('Context Mode shared worker state', () => {
  it('aggregates thirty concurrent deltas once each and restores them after worker retirement and restart', async () => {
    const { state, request } = await fixture();
    const slots = Array.from({ length: 30 }, (_, index) => ({ owner: index + 1 }));
    const prepared = await Promise.all(slots.map((slot) => state.prepare(slot, request)));
    expect(new Set(prepared.map((value) => value.locks[0].lockPath)).size).toBe(1);
    const releases = [];
    for (const [index, slot] of slots.entries()) {
      const after = { ...prepared[index].stats, calls: { ctx_index: 1 }, bytesReturned: { ctx_index: 10 }, bytesIndexed: 100 };
      state.update(slot, statsDelta(prepared[index].stats, after));
      slot.exited = true;
      releases.push(state.release(slot));
    }
    await Promise.all(releases);
    expect(state.storage.size).toBe(0);
    await state.close();
    const saved = JSON.parse(await fs.readFile(request.statsPath, 'utf8'));
    expect(saved).toMatchObject({ total_calls: 30, bytes_returned: 300, bytes_indexed: 3000,
      by_tool: { ctx_index: { calls: 30, bytes: 300 } } });
    expect((await fs.readdir(path.dirname(request.statsPath))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const restored = new ContextModeWorkerState({ directory: path.dirname(request.statsPath) });
    states.push(restored);
    const result = await restored.prepare({ owner: 31 }, request);
    expect(result.stats).toMatchObject({ calls: { ctx_index: 30 }, bytesIndexed: 3000 });
  });

  it('shares coordination by canonical database path while keeping session statistics separate', async () => {
    const { root, state, request } = await fixture();
    const actual = path.join(root, 'actual');
    const alias = path.join(root, 'alias');
    await fs.mkdir(actual);
    await fs.symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const firstSlot = { owner: 1 };
    const first = await state.prepare(firstSlot, { ...request, storagePaths: [path.join(actual, 'content.db')] });
    const second = await state.prepare({ owner: 2 }, { storagePaths: [path.join(alias, 'content.db')], statsPath: path.join(root, 'stats-ses_b.json') });
    expect(first.locks[0].lockPath).toBe(second.locks[0].lockPath);
    state.update(firstSlot, { ...emptyStats(), calls: { ctx_index: 1 } });
    expect(second.stats.calls).toEqual({});
  });

  it('reclaims a dead worker mutex only after exit, retaining the schema and sibling ownership', async () => {
    const { state, request } = await fixture();
    const firstSlot = { owner: 1, terminating: false };
    const sibling = { owner: 2 };
    const first = await state.prepare(firstSlot, request);
    await state.prepare(sibling, request);
    const lock = first.locks[0].lockPath;
    await fs.link(first.ownerToken, lock);
    await fs.writeFile(`${lock}.1`, '');
    firstSlot.terminating = true;
    await state.release(firstSlot);
    expect(await fs.stat(lock)).toBeTruthy();
    firstSlot.exited = true;
    await state.release(firstSlot);
    expect(await fs.stat(lock).catch(() => null)).toBeNull();
    expect(await fs.stat(`${lock}.1`)).toBeTruthy();
    expect(state.storage.size).toBe(1);
  });

  it('keeps a pending statistics write attributed to its session when the worker is reused', async () => {
    const { root, state, request } = await fixture();
    const slot = { owner: 1 };
    await state.prepare(slot, request);
    const firstEntry = slot.statsEntry;
    vi.useFakeTimers();
    try {
      state.update(slot, { ...emptyStats(), calls: { ctx_index: 1 } });
      const secondPath = path.join(root, 'stats-ses_b.json');
      await state.prepare(slot, { ...request, statsPath: secondPath });
      await vi.advanceTimersByTimeAsync(500);
      await firstEntry.writing;
      expect(JSON.parse(await fs.readFile(request.statsPath, 'utf8')).total_calls).toBe(1);
      expect(await fs.stat(secondPath).catch(() => null)).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('bounds unowned statistics cache entries and retries failed persistence without losing counters', async () => {
    const onError = vi.fn();
    let fail = true;
    const { root, state, request } = await fixture({ maxStats: 1, onError,
      fsApi: { ...fs, rename: (...args) => fail ? Promise.reject(new Error('fixture I/O')) : fs.rename(...args) } });
    const slot = { owner: 1 };
    await state.prepare(slot, request);
    state.update(slot, { ...emptyStats(), calls: { ctx_index: 1 } });
    await state.flush(slot.statsPath, slot.statsEntry);
    expect(onError).toHaveBeenCalledOnce();
    expect(slot.statsEntry.persisted).toBe(0);
    fail = false;
    await state.flush(slot.statsPath, slot.statsEntry);
    expect(JSON.parse(await fs.readFile(request.statsPath, 'utf8')).total_calls).toBe(1);
    await state.prepare(slot, { ...request, statsPath: path.join(root, 'stats-ses_b.json') });
    // An outstanding coalescing timer pins its entry until flushed.
    await state.close();
    expect(state.stats.size).toBe(1);
  });
});

describe('Context Mode storage critical sections', () => {
  const fixtureStorage = async (options = {}) => {
    const { state, request } = await fixture();
    const prepared = await state.prepare({ owner: 1 }, request);
    const storage = new ContextModeWorkerStorage({ remainingMs: () => 1000, ...options });
    storage.configure(prepared);
    return { storage, cancellation: prepared.cancellationPath, database: request.storagePaths[0], lock: prepared.locks[0].lockPath };
  };
  it('initializes once under a reentrant mutex and releases it when a transaction throws', async () => {
    const { storage, database, lock } = await fixtureStorage();
    const schema = vi.fn();
    storage.run(database, () => storage.run(database, schema, 1));
    storage.run(database, schema, 1);
    expect(schema).toHaveBeenCalledOnce();
    expect(() => storage.transaction(database, () => { throw new Error('constraint failure'); })).toThrow('constraint failure');
    expect(await fs.stat(lock).catch(() => null)).toBeNull();
    expect(await fs.stat(`${lock}.1`)).toBeTruthy();
  });
  it('honors cancellation before storage work and releases a contended transaction at its deadline', async () => {
    let remaining = 10;
    const { storage, cancellation, database, lock } = await fixtureStorage({ remainingMs: () => remaining });
    await fs.writeFile(cancellation, '1');
    const write = vi.fn();
    expect(() => storage.run(database, write)).toThrow('CANCELLED');
    expect(write).not.toHaveBeenCalled();
    await fs.unlink(cancellation);
    const transaction = vi.fn(() => { remaining = 0; throw new Error('SQLITE_BUSY'); });
    expect(() => storage.transaction(database, transaction)).toThrow('TIMEOUT');
    expect(transaction).toHaveBeenCalledOnce();
    expect(await fs.stat(lock).catch(() => null)).toBeNull();
  });
});
