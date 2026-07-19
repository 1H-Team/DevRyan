import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2/client';
import {
  areSessionRecordsEqual,
  compareSessionRecency,
  getSessionRecency,
  isStrictlyOlderSession,
} from './session-recency';

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
