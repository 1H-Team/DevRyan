import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('./WorktreeSectionContent.tsx', import.meta.url)),
  'utf8',
);

describe('WorktreeSectionContent worktree list synchronization', () => {
  test('observes the authoritative per-project worktree list after removal', () => {
    expect(source).toContain('state.availableWorktreesByProject.get(normalizedProjectPath)');
    expect(source).toContain('setAvailableWorktrees(storedAvailableWorktrees)');
  });
});
