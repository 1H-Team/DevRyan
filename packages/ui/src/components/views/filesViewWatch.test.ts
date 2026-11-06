import { describe, expect, test } from 'bun:test';

import type { FileWatchEvent, FileWatchScope } from '@/lib/api/types';
import {
  buildFilesWatchPlan,
  classifySelectedFileStat,
  filesPollIntervals,
  shouldSubscribeFilesWatch,
  startFilesWatch,
  type FilesWatchPlan,
} from './filesViewWatch';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type Call = { scope: FileWatchScope; emit: (event: FileWatchEvent) => void; signal: AbortSignal; resolve: () => void; reject: (error: Error) => void };

const createHarness = (plan: FilesWatchPlan) => {
  const calls: Call[] = [];
  const log: string[] = [];
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  const stop = startFilesWatch({
    plan,
    watch: (scope, onEvent, signal) => new Promise<void>((resolve, reject) => {
      calls.push({ scope, emit: onEvent, signal, resolve, reject });
    }),
    handlers: {
      refreshDirectory: (path) => log.push(`dir:${path}`),
      refreshSelectedFile: () => log.push('selected'),
      refreshAll: () => log.push('all'),
      setWatching: (watching) => log.push(watching ? 'watching' : 'polling'),
    },
    timers: {
      setTimeout: (callback, delayMs) => {
        const timer = { callback, delayMs, cleared: false };
        timers.push(timer);
        return setTimeout(() => {}, 0);
      },
      clearTimeout: () => {
        const pending = timers.find((timer) => !timer.cleared);
        if (pending) pending.cleared = true;
      },
    },
  });
  const fireRetry = async () => {
    const timer = timers.find((entry) => !entry.cleared);
    if (!timer) throw new Error('No retry scheduled');
    timer.cleared = true;
    timer.callback();
    await flush();
  };
  return { calls, log, timers, stop, fireRetry };
};

const plan = buildFilesWatchPlan({
  root: '/repo',
  expandedPaths: ['/repo/src', '/repo/src', '/repo', '/elsewhere/lib', '/repo/docs/guides'],
  selectedPath: '/repo/src/app.ts',
});
if (!plan) throw new Error('Expected a plan');

describe('files view watch scope', () => {
  test('builds a debounced, root-relative scope and leaves outside paths to polling', () => {
    expect(plan.scope).toEqual({ directory: '/repo', expandedDirectories: ['src', 'docs/guides'], selectedFile: 'src/app.ts' });
    expect(plan.expandedPaths).toEqual(['/repo/src', '/repo/docs/guides']);
    const outside = buildFilesWatchPlan({ root: 'C:/Repo', expandedPaths: ['c:/repo/Src'], selectedPath: 'D:/other/file.ts' });
    expect(outside?.scope).toEqual({ directory: 'C:/Repo', expandedDirectories: ['Src'] });
    expect(outside?.key).not.toBe(plan.key);
    expect(buildFilesWatchPlan({ root: '', expandedPaths: [], selectedPath: null })).toBeNull();
  });

  test('subscribes only while the view and the document are visible', () => {
    expect(shouldSubscribeFilesWatch({ visible: true, documentVisible: true, hasWatch: true, hasPlan: true })).toBe(true);
    expect(shouldSubscribeFilesWatch({ visible: false, documentVisible: true, hasWatch: true, hasPlan: true })).toBe(false);
    expect(shouldSubscribeFilesWatch({ visible: true, documentVisible: false, hasWatch: true, hasPlan: true })).toBe(false);
    expect(shouldSubscribeFilesWatch({ visible: true, documentVisible: true, hasWatch: false, hasPlan: true })).toBe(false);
  });

  test('keeps a 30 s safety net while watching and 8 s / 2 s polling otherwise', () => {
    expect(filesPollIntervals(true)).toEqual({ directoryMs: 30_000, selectedFileMs: 30_000 });
    expect(filesPollIntervals(false)).toEqual({ directoryMs: 8_000, selectedFileMs: 2_000 });
  });
});

describe('files view watch lifecycle', () => {
  test('refreshes authoritatively on ready, then only the hinted slot', async () => {
    const harness = createHarness(plan);
    expect(harness.calls).toHaveLength(1);
    const [call] = harness.calls;
    call.emit({ type: 'invalidate', epoch: 3, slot: { kind: 'root' } });
    expect(harness.log).toEqual([]);
    call.emit({ type: 'ready', epoch: 3 });
    call.emit({ type: 'invalidate', epoch: 3, slot: { kind: 'root' } });
    call.emit({ type: 'invalidate', epoch: 3, slot: { kind: 'expanded', index: 1 } });
    call.emit({ type: 'invalidate', epoch: 3, slot: { kind: 'expanded', index: 9 } });
    call.emit({ type: 'invalidate', epoch: 3, slot: { kind: 'selected' } });
    call.emit({ type: 'invalidate', epoch: 2, slot: { kind: 'root' } });
    call.emit({ type: 'resync', epoch: 3 });
    expect(harness.log).toEqual(['watching', 'all', 'dir:/repo', 'dir:/repo/docs/guides', 'selected', 'all']);
    harness.stop();
  });

  test('falls back to polling and retries with the shared backoff, reset after ready', async () => {
    const harness = createHarness(plan);
    harness.calls[0].reject(new Error('network'));
    await flush();
    expect(harness.log).toEqual(['polling']);
    expect(harness.timers.map((timer) => timer.delayMs)).toEqual([1_000]);
    await harness.fireRetry();
    harness.calls[1].reject(new Error('timeout'));
    await flush();
    expect(harness.timers.map((timer) => timer.delayMs)).toEqual([1_000, 2_000]);
    await harness.fireRetry();
    harness.calls[2].emit({ type: 'ready', epoch: 1 });
    harness.calls[2].resolve();
    await flush();
    expect(harness.timers.map((timer) => timer.delayMs)).toEqual([1_000, 2_000, 1_000]);
    expect(harness.log).toEqual(['polling', 'polling', 'watching', 'all', 'polling']);
    harness.stop();
  });

  test('stays on polling after a non-retryable unavailable and retries a retryable one', async () => {
    const terminal = createHarness(plan);
    terminal.calls[0].emit({ type: 'unavailable', epoch: 0, retryable: false });
    terminal.calls[0].resolve();
    await flush();
    expect(terminal.log).toEqual(['polling', 'polling']);
    expect(terminal.timers).toEqual([]);

    const transient = createHarness(plan);
    transient.calls[0].emit({ type: 'ready', epoch: 4 });
    transient.calls[0].emit({ type: 'unavailable', epoch: 4, retryable: true });
    transient.calls[0].resolve();
    await flush();
    expect(transient.timers.map((timer) => timer.delayMs)).toEqual([1_000]);
    transient.stop();
  });

  test('abort on stop cancels the stream and any pending retry without changing the mode', async () => {
    const harness = createHarness(plan);
    const [call] = harness.calls;
    call.emit({ type: 'ready', epoch: 5 });
    harness.stop();
    expect(call.signal.aborted).toBe(true);
    call.emit({ type: 'resync', epoch: 5 });
    call.resolve();
    await flush();
    expect(harness.log).toEqual(['watching', 'all']);
    expect(harness.timers).toEqual([]);

    const retrying = createHarness(plan);
    retrying.calls[0].reject(new Error('network'));
    await flush();
    retrying.stop();
    expect(retrying.timers.every((timer) => timer.cleared)).toBe(true);
  });
});

describe('selected file change detection', () => {
  const previous = { path: '/repo/src/app.ts', size: 10, mtimeMs: 1, ctimeMs: 1 };
  test('never replaces a dirty buffer and reloads a clean one', () => {
    const latest = { ...previous, mtimeMs: 2 };
    expect(classifySelectedFileStat({ previous, latest, selectedPath: previous.path, isDirty: true })).toBe('dirty');
    expect(classifySelectedFileStat({ previous, latest, selectedPath: previous.path, isDirty: false })).toBe('reload');
    expect(classifySelectedFileStat({ previous, latest: { ...previous }, selectedPath: previous.path, isDirty: false })).toBe('unchanged');
    expect(classifySelectedFileStat({ previous: null, latest, selectedPath: previous.path, isDirty: false })).toBe('record');
    expect(classifySelectedFileStat({ previous, latest: { ...previous, size: 11 }, selectedPath: '/repo/other.ts', isDirty: false })).toBe('record');
  });
});
