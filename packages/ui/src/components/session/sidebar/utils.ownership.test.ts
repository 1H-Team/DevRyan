import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { buildSessionProjectOwnership } from './utils';

const session = (input: {
  id: string;
  directory?: string | null;
  projectWorktree?: string | null;
  parentID?: string | null;
}): Session => ({
  id: input.id,
  title: input.id,
  time: { created: 1, updated: 1 },
  ...(input.directory !== undefined ? { directory: input.directory } : {}),
  ...(input.parentID ? { parentID: input.parentID } : {}),
  ...(input.projectWorktree !== undefined
    ? { project: { worktree: input.projectWorktree } }
    : {}),
} as Session);

describe('buildSessionProjectOwnership', () => {
  test('assigns nested sessions to the deepest registered project', () => {
    const nested = session({
      id: 'nested',
      directory: '/repo/packages/child/src',
      projectWorktree: '/repo',
    });
    const ownership = buildSessionProjectOwnership(
      [{ normalizedPath: '/repo' }, { normalizedPath: '/repo/packages/child' }],
      new Map(),
      [nested],
      false,
    );

    expect(ownership.get(nested.id)).toBe('/repo/packages/child');
  });

  test('maps external worktrees to their registered owner', () => {
    const external = session({ id: 'external', directory: '/tmp/worktrees/feature/src' });
    const ownership = buildSessionProjectOwnership(
      [{ normalizedPath: '/repo' }],
      new Map([['/repo', [{ path: '/tmp/worktrees/feature' }]]]),
      [external],
      false,
    );

    expect(ownership.get(external.id)).toBe('/repo');
  });

  test('prefers an exact registered project over worktree metadata at the same path', () => {
    const nested = session({ id: 'nested', directory: 'C:\\repo\\child\\src\\' });
    const ownership = buildSessionProjectOwnership(
      [{ normalizedPath: 'C:\\repo\\' }, { normalizedPath: 'C:\\repo\\child\\' }],
      new Map([['C:\\repo\\', [{ path: 'C:\\repo\\child\\' }]]]),
      [nested],
      false,
    );

    expect(ownership.get(nested.id)).toBe('C:/repo/child');
  });

  test('inherits ownership through parent lineage only when directory metadata is absent', () => {
    const parent = session({ id: 'parent', directory: '/repo' });
    const child = session({ id: 'child', parentID: parent.id });
    const explicitUnknown = session({
      id: 'unknown',
      directory: '/unregistered',
      projectWorktree: '/repo',
      parentID: parent.id,
    });
    const ownership = buildSessionProjectOwnership(
      [{ normalizedPath: '/repo' }],
      new Map(),
      [parent, child, explicitUnknown],
      false,
    );

    expect(ownership.get(child.id)).toBe('/repo');
    expect(ownership.has(explicitUnknown.id)).toBe(false);
  });
});
