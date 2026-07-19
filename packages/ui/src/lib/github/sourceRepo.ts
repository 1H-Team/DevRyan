import type { GitHubRepoSelector } from '@/lib/api/types';

export const resolveGitHubSourceRepo = (
  repo: { owner?: unknown; repo?: unknown } | null | undefined,
): GitHubRepoSelector | null => {
  const owner = typeof repo?.owner === 'string' ? repo.owner.trim() : '';
  const name = typeof repo?.repo === 'string' ? repo.repo.trim() : '';
  return owner && name ? { owner, repo: name } : null;
};
