import { beforeEach, describe, expect, test } from 'bun:test';
import type { GitHubAPI, GitHubPullRequestStatus } from '@/lib/api/types';
import {
  getGitHubPrStatusKey,
  getPrPollingPlan,
  PR_TERMINAL_DISCOVERY_INTERVAL_MS,
  PR_STATUS_REFRESH_CONCURRENCY,
  useGitHubPrStatusStore,
} from './useGitHubPrStatusStore';

type Deferred = {
  promise: Promise<GitHubPullRequestStatus>;
  resolve: (value: GitHubPullRequestStatus) => void;
};

const createDeferred = (): Deferred => {
  let resolve!: (value: GitHubPullRequestStatus) => void;
  const promise = new Promise<GitHubPullRequestStatus>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error('Condition was not reached');
};

const registerTarget = (
  directory: string,
  branch: string,
  prStatus: GitHubAPI['prStatus'],
) => {
  const key = getGitHubPrStatusKey(directory, branch);
  const store = useGitHubPrStatusStore.getState();
  store.ensureEntry(key);
  useGitHubPrStatusStore.getState().setParams(key, {
    directory,
    branch,
    remoteName: null,
    canShow: true,
    github: { prStatus },
    githubAuthChecked: true,
    githubConnected: true,
  });
  return key;
};

describe('useGitHubPrStatusStore refresh coordination', () => {
  beforeEach(() => {
    useGitHubPrStatusStore.setState({
      entries: {},
      activeRequestCount: 0,
      totalRequestCount: 0,
    });
  });

  test('runs no more than four target refreshes at once', async () => {
    const pending: Deferred[] = [];
    let active = 0;
    let maxActive = 0;
    const prStatus: GitHubAPI['prStatus'] = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const deferred = createDeferred();
      pending.push(deferred);
      try {
        return await deferred.promise;
      } finally {
        active -= 1;
      }
    };
    const targets = Array.from({ length: 9 }, (_, index) => ({
      directory: `/repo-${index}`,
      branch: 'feature',
    }));
    targets.forEach((target) => registerTarget(target.directory, target.branch, prStatus));

    const refresh = useGitHubPrStatusStore.getState().refreshTargets(targets, { force: true });
    await waitFor(() => pending.length === PR_STATUS_REFRESH_CONCURRENCY);
    expect(active).toBe(PR_STATUS_REFRESH_CONCURRENCY);

    while (pending.some((deferred) => deferred)) {
      const unsettled = pending.splice(0, pending.length);
      if (unsettled.length === 0) {
        break;
      }
      unsettled.forEach((deferred) => deferred.resolve({ connected: true }));
      await Promise.resolve();
      if (useGitHubPrStatusStore.getState().totalRequestCount === targets.length) {
        break;
      }
      await waitFor(() => pending.length > 0);
    }
    pending.splice(0).forEach((deferred) => deferred.resolve({ connected: true }));
    await refresh;

    expect(maxActive).toBe(PR_STATUS_REFRESH_CONCURRENCY);
    expect(useGitHubPrStatusStore.getState().totalRequestCount).toBe(targets.length);
    expect(useGitHubPrStatusStore.getState().activeRequestCount).toBe(0);
  });

  test('deduplicates concurrent refreshes with the same signature', async () => {
    const deferred = createDeferred();
    let calls = 0;
    const prStatus: GitHubAPI['prStatus'] = async () => {
      calls += 1;
      return deferred.promise;
    };
    const key = registerTarget('/repo', 'feature', prStatus);

    const first = useGitHubPrStatusStore.getState().refresh(key, { force: true });
    const second = useGitHubPrStatusStore.getState().refresh(key, { force: true });
    await Promise.resolve();

    expect(calls).toBe(1);
    deferred.resolve({ connected: true });
    await Promise.all([first, second]);
    expect(useGitHubPrStatusStore.getState().totalRequestCount).toBe(1);
  });

  test('returns the active request count to zero after success', async () => {
    const key = registerTarget('/success', 'feature', async () => ({ connected: true }));

    await useGitHubPrStatusStore.getState().refresh(key, { force: true });

    expect(useGitHubPrStatusStore.getState().activeRequestCount).toBe(0);
    expect(useGitHubPrStatusStore.getState().totalRequestCount).toBe(1);
  });

  test('returns the active request count to zero after failure', async () => {
    const key = registerTarget('/failure', 'feature', async () => {
      throw new Error('request failed');
    });

    await useGitHubPrStatusStore.getState().refresh(key, { force: true });

    expect(useGitHubPrStatusStore.getState().activeRequestCount).toBe(0);
    expect(useGitHubPrStatusStore.getState().totalRequestCount).toBe(1);
    expect(useGitHubPrStatusStore.getState().entries[key]?.error).toBe('request failed');
  });
});

describe('getPrPollingPlan', () => {
  test('re-discovers branch PRs after a terminal PR at a low frequency', () => {
    const plan = getPrPollingPlan({
      connected: true,
      pr: {
        number: 7023,
        title: 'Dev',
        url: 'https://github.test/pull/7023',
        state: 'merged',
        draft: false,
        base: 'main',
        head: 'Dev',
      },
    });

    expect(plan).toEqual({
      intervalMs: PR_TERMINAL_DISCOVERY_INTERVAL_MS,
      onlyExistingPr: false,
    });
  });
});
