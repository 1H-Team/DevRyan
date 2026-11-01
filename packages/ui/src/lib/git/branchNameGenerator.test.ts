import { describe, expect, test } from 'bun:test';

import { buildDevRyanBranchName, DEVRYAN_BRANCH_PREFIX } from './branchNameGenerator';

describe('buildDevRyanBranchName', () => {
  test('prefixes the helper slug and keeps the bare slug as the worktree name', () => {
    expect(buildDevRyanBranchName('homepage-language-audit')).toEqual({
      branchName: 'DevRyan/homepage-language-audit',
      worktreeName: 'homepage-language-audit',
    });
  });

  test('falls back to a random adjective-noun slug', () => {
    for (const slug of [null, undefined, '', '   ']) {
      const { branchName, worktreeName } = buildDevRyanBranchName(slug);
      expect(worktreeName).toMatch(/^[a-z]+-[a-z]+$/);
      expect(branchName).toBe(`${DEVRYAN_BRANCH_PREFIX}/${worktreeName}`);
    }
  });
});
