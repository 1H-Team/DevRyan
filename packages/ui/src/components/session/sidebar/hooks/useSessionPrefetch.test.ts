import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2/client';

import { selectSessionPrefetchNeighborIds } from './useSessionPrefetch';

const session = (id: string, directory: string): Session => ({
  id,
  directory,
  title: id,
  time: { created: 1, updated: 1 },
} as Session);

describe('session neighbor prefetch', () => {
  test('skips adjacent sessions owned by inactive directories', () => {
    const neighbors = selectSessionPrefetchNeighborIds({
      currentSessionId: 'current',
      currentDirectory: '/repo/active/',
      sortedSessions: [
        session('active-before', '/repo/active'),
        session('inactive-before', '/repo/inactive'),
        session('current', '/REPO/ACTIVE'),
        session('inactive-after', '/repo/other'),
        session('active-after', '/repo/active'),
      ],
    });

    expect(neighbors).toEqual(['active-before', 'active-after']);
  });
});
