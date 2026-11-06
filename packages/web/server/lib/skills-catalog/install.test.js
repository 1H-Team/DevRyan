import { describe, expect, it, vi } from 'vitest';

vi.mock('./git.js', async (importOriginal) => ({
  ...(await importOriginal()),
  assertGitAvailable: vi.fn(async () => ({ ok: true })),
  looksLikeAuthError: vi.fn(() => false),
  runGit: vi.fn(async () => ({ ok: true, stdout: '', stderr: '' })),
}));

vi.mock('./source.js', () => ({
  parseSkillRepoSource: vi.fn(() => ({
    ok: true,
    cloneUrlHttps: 'https://example.invalid/owner/repo.git',
    cloneUrlSsh: 'git@example.invalid:owner/repo.git',
    effectiveSubpath: null,
    normalizedRepo: 'owner/repo',
  })),
}));

describe('installSkillsFromRepository', () => {
  it('rejects selected skill directories that escape the cloned repository', async () => {
    const { runGit } = await import('./git.js');
    const { installSkillsFromRepository } = await import('./install.js');

    const result = await installSkillsFromRepository({
      source: 'owner/repo',
      scope: 'user',
      targetSource: 'opencode',
      userSkillDir: '/tmp/devryan-user-skills',
      selections: [{ skillDir: '../outside' }],
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'invalidSource',
        message: 'Selected skill directory cannot contain path traversal',
      },
    });
    expect(runGit).not.toHaveBeenCalled();
  });
});
