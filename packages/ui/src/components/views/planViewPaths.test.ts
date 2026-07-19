import { describe, expect, test } from 'bun:test';

import { getPlanViewCandidatePaths } from './planViewPaths';

describe('getPlanViewCandidatePaths', () => {
  test('prioritizes an explicit target, then the saved session revision, then legacy paths', () => {
    expect(getPlanViewCandidatePaths({
      explicitTargetPath: '/plans/explicit.md',
      sessionPlanPath: '/plans/current.md',
      repoPlanPath: '/repo/.opencode/plans/legacy.md',
      homePlanPath: '/home/.opencode/plans/legacy.md',
    })).toEqual([
      '/plans/explicit.md',
      '/plans/current.md',
      '/repo/.opencode/plans/legacy.md',
      '/home/.opencode/plans/legacy.md',
    ]);
  });

  test('deduplicates paths and drops empty candidates', () => {
    expect(getPlanViewCandidatePaths({
      explicitTargetPath: null,
      sessionPlanPath: '/plans/current.md',
      repoPlanPath: '/plans/current.md',
      homePlanPath: '',
    })).toEqual(['/plans/current.md']);
  });
});
