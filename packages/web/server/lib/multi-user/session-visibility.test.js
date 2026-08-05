import { describe, expect, it, vi } from 'vitest';

import {
  listVisibleSessionPage,
  normalizeSessionPageLimit,
  selectUniqueOwnershipCandidate,
} from './session-visibility.js';

const session = (id, updated) => ({ id, time: { updated } });

describe('managed global session visibility', () => {
  it('fills a visible page across upstream pages containing foreign sessions', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({
        sessions: [session('foreign-1', 100), session('developer-1', 99)],
        nextCursor: 99,
      })
      .mockResolvedValueOnce({
        sessions: [session('foreign-2', 98), session('developer-2', 97)],
        nextCursor: 97,
      });

    const result = await listVisibleSessionPage({
      limit: 2,
      fetchPage,
      isVisible: ({ id }) => id.startsWith('developer-'),
    });

    expect(result.sessions.map(({ id }) => id)).toEqual(['developer-1', 'developer-2']);
    expect(result.nextCursor).toBe(97);
    expect(fetchPage).toHaveBeenNthCalledWith(2, { cursor: 99, limit: 2 });
  });

  it('exhausts foreign-only pages without returning a metadata-bearing cursor', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ sessions: [session('foreign-1', 50)], nextCursor: 50 })
      .mockResolvedValueOnce({ sessions: [session('foreign-2', 40)], nextCursor: null });

    const result = await listVisibleSessionPage({
      limit: 1,
      fetchPage,
      isVisible: () => false,
    });

    expect(result).toEqual({ sessions: [], nextCursor: null });
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('applies the same ownership predicate for administrators and developers', async () => {
    const rows = [session('admin', 3), session('developer', 2), session('foreign', 1)];
    const listFor = (userId) => listVisibleSessionPage({
      limit: 10,
      fetchPage: async () => ({ sessions: rows, nextCursor: null }),
      isVisible: ({ id }) => id === userId,
    });

    await expect(listFor('admin')).resolves.toMatchObject({ sessions: [rows[0]] });
    await expect(listFor('developer')).resolves.toMatchObject({ sessions: [rows[1]] });
  });

  it('bounds malformed limits before forwarding them upstream', () => {
    expect(normalizeSessionPageLimit(undefined)).toBe(100);
    expect(normalizeSessionPageLimit(0)).toBe(1);
    expect(normalizeSessionPageLimit(50_000)).toBe(1_000);
  });
});

describe('session ownership reconciliation matching', () => {
  const candidate = (overrides = {}) => ({
    userId: 'developer-a',
    projectId: 'project-a',
    branchName: 'main',
    canonicalDirectory: '/worktrees/a',
    isDefault: false,
    ...overrides,
  });

  it('selects the default assignment when one user has duplicate path grants', () => {
    const selected = selectUniqueOwnershipCandidate([
      candidate({ branchName: 'feature' }),
      candidate({ branchName: 'main', isDefault: true }),
    ], '/worktrees/a');

    expect(selected).toMatchObject({ userId: 'developer-a', branchName: 'main' });
  });

  it('rejects a canonical path claimed by more than one active user', () => {
    expect(selectUniqueOwnershipCandidate([
      candidate(),
      candidate({ userId: 'developer-b' }),
    ], '/worktrees/a')).toBeNull();
  });
});
