import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { archiveBranchSessions, resolveBranchGroupLabel } from './branchSessionCleanup';

describe('branch session cleanup', () => {
  test('keeps the sidebar label branch-only even when a legacy label contains PR metadata', () => {
    expect(resolveBranchGroupLabel({ branch: 'Dev', label: '#7023 Dev' })).toBe('Dev');
    expect(resolveBranchGroupLabel({ branch: 'Dev', label: 'merged · #7023 Dev' })).toBe('Dev');
    expect(resolveBranchGroupLabel({ branch: 'Dev', label: 'closed · #7023 Dev' })).toBe('Dev');
  });

  test('archives each branch session once and preserves partial-failure results', async () => {
    const sessions = [
      { id: 'root' },
      { id: 'child', parentID: 'root' },
      { id: 'child', parentID: 'root' },
    ] as Session[];
    let receivedIds: string[] = [];

    const result = await archiveBranchSessions(sessions, async (ids) => {
      receivedIds = ids;
      return { archivedIds: ['root'], failedIds: ['child'] };
    });

    expect(receivedIds).toEqual(['root', 'child']);
    expect(result).toEqual({ archivedIds: ['root'], failedIds: ['child'] });
  });
});
