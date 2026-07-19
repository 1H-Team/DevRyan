import { describe, expect, test } from 'bun:test';
import type { ProjectEntry } from '@/lib/api/types';
import type { WorktreeMetadata } from '@/types/worktree';
import { resolveProjectForSessionDirectory } from './projectResolution';

const project = (id: string, path: string): ProjectEntry => ({ id, path } as ProjectEntry);
const worktree = (path: string, projectDirectory: string): WorktreeMetadata => ({
  path,
  projectDirectory,
} as WorktreeMetadata);

describe('resolveProjectForSessionDirectory', () => {
  test('prefers the deepest directly registered project over a parent worktree', () => {
    const parent = project('parent', '/repo');
    const child = project('child', '/repo/packages/child');
    const worktrees = new Map([
      ['/repo', [worktree('/repo/packages', '/repo')]],
    ]);

    expect(resolveProjectForSessionDirectory(
      [parent, child],
      worktrees,
      '/repo/packages/child/src',
    )).toBe(child);
  });

  test('uses external worktree ownership when no registered project contains the directory', () => {
    const parent = project('parent', 'C:\\repo\\');
    const worktrees = new Map([
      ['C:\\repo\\', [worktree('D:\\worktrees\\feature\\', 'C:\\repo\\')]],
    ]);

    expect(resolveProjectForSessionDirectory(
      [parent],
      worktrees,
      'D:\\worktrees\\feature\\src\\',
    )).toBe(parent);
  });
});
