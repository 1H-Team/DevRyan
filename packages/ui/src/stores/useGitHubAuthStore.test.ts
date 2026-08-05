import { beforeEach, describe, expect, test } from 'bun:test';

import type { GitHubAPI } from '@/lib/api/types';
import { fetchGitHubAuthStatusWithRetry, useGitHubAuthStore } from './useGitHubAuthStore';

const githubRuntime = (authStatus: GitHubAPI['authStatus']): GitHubAPI => ({ authStatus } as GitHubAPI);

describe('useGitHubAuthStore', () => {
  beforeEach(() => {
    useGitHubAuthStore.setState({ status: null, isLoading: false, hasChecked: false });
  });

  test('retries transient startup failures before publishing auth status', async () => {
    let attempts = 0;
    const status = await fetchGitHubAuthStatusWithRetry(githubRuntime(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('not ready');
      return {
        connected: true,
        user: { login: 'dev', id: 7, avatarUrl: 'https://avatars.example/dev' },
      };
    }), [0, 0]);

    expect(attempts).toBe(3);
    expect(status.user?.avatarUrl).toBe('https://avatars.example/dev');
  });

  test('preserves the last valid assigned avatar when a refresh fails', async () => {
    useGitHubAuthStore.getState().setStatus({
      connected: true,
      user: { login: 'dev', id: 7, avatarUrl: 'https://avatars.example/dev' },
    });

    await useGitHubAuthStore.getState().refreshStatus(
      githubRuntime(async () => { throw new Error('temporary failure'); }),
      { force: true, retryDelays: [] },
    );

    const status = useGitHubAuthStore.getState().status;
    expect(status?.connected).toBe(true);
    expect(status?.user?.avatarUrl).toBe('https://avatars.example/dev');
    expect(status?.error).toBe('temporary failure');
  });
});
