import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2/client';
import {
  areSessionRecordsEqual,
  compareSessionRecency,
  getSessionRecency,
  hasNewerSessionLifecycle,
  isStrictlyOlderSession,
  mergeSessionLifecycle,
  mergeSessionListLifecycle,
  retainSessionLifecycle,
} from './session-recency';
import type { DisplaySession } from './types';

const session = (time: { created?: number; updated?: number }, title = 'title'): Session => ({
  id: 'session',
  title,
  time,
} as Session);

describe('session recency', () => {
  test('uses finite updated time and falls back to created time', () => {
    expect(getSessionRecency(session({ created: 2, updated: Number.NaN }))).toBe(2);
    expect(getSessionRecency(session({ created: 2, updated: 3 }))).toBe(3);
  });

  test('rejects only strictly older records', () => {
    expect(isStrictlyOlderSession(session({ updated: 2 }), session({ updated: 3 }))).toBe(true);
    expect(compareSessionRecency(session({ updated: 3 }), session({ updated: 3 }))).toBe(0);
    expect(compareSessionRecency(session({}), session({ updated: 3 }))).toBe(0);
  });

  test('detects unchanged nested session records', () => {
    const left = session({ created: 1, updated: 2 });
    const right = session({ created: 1, updated: 2 });
    expect(areSessionRecordsEqual(left, right)).toBe(true);
    expect(areSessionRecordsEqual(left, session({ created: 1, updated: 2 }, 'renamed'))).toBe(false);
  });
});

type LifecycleFields = {
  updated?: number;
  busy?: number;
  idle?: number;
  viewed?: number;
  outcome?: DisplaySession['outcome'];
  fork?: DisplaySession['fork'];
  title?: string;
};

const lifecycleSession = ({ updated = 10, busy, idle, viewed, outcome, fork, title = 'title' }: LifecycleFields): DisplaySession => ({
  ...session({ created: 1, updated }, title),
  time: {
    created: 1,
    updated,
    ...(busy !== undefined ? { busy } : {}),
    ...(idle !== undefined ? { idle } : {}),
    ...(viewed !== undefined ? { viewed } : {}),
  },
  ...(outcome !== undefined ? { outcome } : {}),
  ...(fork !== undefined ? { fork } : {}),
});

const FORK = { sessionID: 'ses_source', boundary: { type: 'through' as const, messageID: 'msg_1' } };

describe('session lifecycle merge', () => {
  test('keeps lifecycle facts from a snapshot that is older by updated', () => {
    const current = lifecycleSession({ updated: 20, busy: 100, idle: 90, outcome: 'failed', viewed: 50 });
    const olderButFinished = lifecycleSession({ updated: 10, busy: 100, idle: 140, outcome: 'succeeded', viewed: 40 });

    expect(isStrictlyOlderSession(olderButFinished, current)).toBe(true);
    expect(hasNewerSessionLifecycle(current, olderButFinished)).toBe(true);
    const retained = retainSessionLifecycle(current, olderButFinished);

    expect(retained.time.updated).toBe(20);
    expect(retained.time.busy).toBe(100);
    expect(retained.time.idle).toBe(140);
    expect(retained.outcome).toBe('succeeded');
    expect(retained.time.viewed).toBe(50);
  });

  test('never moves lifecycle facts backwards when a newer record is accepted', () => {
    const current = lifecycleSession({ updated: 10, busy: 200, idle: 210, outcome: 'interrupted', viewed: 300, fork: FORK });
    const newerButStale = lifecycleSession({ updated: 20, busy: 100, idle: 110, outcome: 'succeeded', viewed: 150, title: 'renamed' });
    const merged = mergeSessionLifecycle(current, newerButStale);

    expect(merged.title).toBe('renamed');
    expect(merged.time.updated).toBe(20);
    expect(merged.time.busy).toBe(200);
    expect(merged.time.idle).toBe(210);
    expect(merged.outcome).toBe('interrupted');
    expect(merged.time.viewed).toBe(300);
    expect(merged.fork).toBe(FORK);
  });

  test('an equal idle keeps the current idle and outcome pair', () => {
    const current = lifecycleSession({ busy: 100, idle: 150, outcome: 'failed' });
    const tie = lifecycleSession({ busy: 100, idle: 150, outcome: 'succeeded' });

    expect(hasNewerSessionLifecycle(current, tie)).toBe(false);
    expect(retainSessionLifecycle(current, tie)).toBe(current);
    expect(mergeSessionLifecycle(current, tie).outcome).toBe('failed');
  });

  test('a start advances busy and keeps the previous idle and outcome', () => {
    const finished = lifecycleSession({ busy: 100, idle: 150, outcome: 'succeeded' });
    const started = lifecycleSession({ busy: 200 });
    const merged = mergeSessionLifecycle(finished, started);

    expect(merged.time.busy).toBe(200);
    expect(merged.time.idle).toBe(150);
    expect(merged.outcome).toBe('succeeded');
  });

  test('a shutdown record that changes neither idle nor outcome is a no-op', () => {
    const current = lifecycleSession({ busy: 200, idle: 150, outcome: 'succeeded', viewed: 120 });
    const shutdown = lifecycleSession({ busy: 200, idle: 150, outcome: 'succeeded' });

    expect(hasNewerSessionLifecycle(current, shutdown)).toBe(false);
    expect(retainSessionLifecycle(current, shutdown)).toBe(current);
    expect(areSessionRecordsEqual(current, mergeSessionLifecycle(current, { ...current }))).toBe(true);
  });

  test('viewed is a max watermark', () => {
    const current = lifecycleSession({ viewed: 500 });

    expect(retainSessionLifecycle(current, lifecycleSession({ viewed: 400 }))).toBe(current);
    expect(retainSessionLifecycle(current, lifecycleSession({ viewed: 600 })).time.viewed).toBe(600);
  });

  test('fork keeps the first defined value', () => {
    const otherFork = { sessionID: 'ses_other', boundary: { type: 'before' as const, messageID: 'msg_2' } };

    expect(mergeSessionLifecycle(lifecycleSession({}), lifecycleSession({ fork: FORK })).fork).toBe(FORK);
    expect(mergeSessionLifecycle(lifecycleSession({ fork: FORK }), lifecycleSession({ fork: otherFork })).fork).toBe(FORK);
  });

  test('returns the incoming reference when it already holds the merged facts', () => {
    const current = lifecycleSession({ busy: 100, idle: 150, outcome: 'succeeded' });
    const incoming = lifecycleSession({ updated: 20, busy: 100, idle: 160, outcome: 'failed' });

    expect(mergeSessionLifecycle(current, incoming)).toBe(incoming);
    expect(mergeSessionLifecycle(undefined, incoming)).toBe(incoming);
  });

  test('carries stored lifecycle facts into an authoritative snapshot list', () => {
    const stored = lifecycleSession({ busy: 100, idle: 150, outcome: 'succeeded' });
    const unchanged = { ...lifecycleSession({}), id: 'other' };
    const snapshot = [lifecycleSession({ updated: 30, title: 'snapshot' }), unchanged];
    const merged = mergeSessionListLifecycle([stored], snapshot);

    expect(merged).not.toBe(snapshot);
    expect(merged[0]?.title).toBe('snapshot');
    expect(merged[0]?.time.idle).toBe(150);
    expect(merged[1]).toBe(unchanged);
    expect(mergeSessionListLifecycle([], snapshot)).toBe(snapshot);
  });
});
