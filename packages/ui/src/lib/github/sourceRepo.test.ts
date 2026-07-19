import { describe, expect, test } from 'bun:test';
import { resolveGitHubSourceRepo } from './sourceRepo';

describe('resolveGitHubSourceRepo', () => {
  test('retains a valid fork repository identity', () => {
    expect(resolveGitHubSourceRepo({ owner: ' fork-owner ', repo: ' project ' })).toEqual({
      owner: 'fork-owner',
      repo: 'project',
    });
  });

  test('rejects incomplete repository identities', () => {
    expect(resolveGitHubSourceRepo({ owner: 'fork-owner' })).toBeNull();
    expect(resolveGitHubSourceRepo(null)).toBeNull();
  });
});
