import { describe, expect, test } from 'bun:test';

import { resolveDraftEffectiveDirectory } from './useEffectiveDirectory';

describe('resolveDraftEffectiveDirectory', () => {
  test('does not expose the fallback root while a managed worktree is pending', () => {
    expect(resolveDraftEffectiveDirectory({
      open: true,
      directoryOverride: null,
      pendingWorktreeRequestId: 'worktree-1',
      targetBranchName: 'Dev',
      parentID: null,
    }, '/repo')).toBe(undefined);
  });

  test('uses the resolved managed worktree instead of the fallback root', () => {
    expect(resolveDraftEffectiveDirectory({
      open: true,
      directoryOverride: '/worktrees/Dev',
      pendingWorktreeRequestId: null,
      targetBranchName: 'Dev',
      parentID: null,
    }, '/repo')).toBe('/worktrees/Dev');
  });

  test('keeps preparation errors fail-closed', () => {
    expect(resolveDraftEffectiveDirectory({
      open: true,
      directoryOverride: null,
      targetPreparationError: 'failed',
      parentID: null,
    }, '/repo')).toBe(undefined);
  });
});
