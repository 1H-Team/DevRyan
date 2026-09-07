import { beforeEach, describe, expect, test } from 'bun:test';
import type { GitLogEntry, GitLogResponse, GitStatus } from '@/lib/api/types';
import { useGitStore } from './useGitStore';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type GitAPI = Parameters<ReturnType<typeof useGitStore.getState>['fetchStatus']>[1];

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const createStatus = (diffStats?: GitStatus['diffStats']): GitStatus => ({
  current: 'main',
  tracking: null,
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
  diffStats,
});

const createLog = (hash: string, options: { isRemoteHead?: boolean } = {}): GitLogResponse => {
  const entry: GitLogEntry = {
    hash,
    date: '2026-08-08T00:00:00.000Z',
    message: `commit ${hash}`,
    refs: '',
    body: '',
    author_name: 'DevRyan Test',
    author_email: 'devryan@example.com',
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
    isHead: true,
    isRemoteHead: options.isRemoteHead ?? false,
    isSyncPoint: options.isRemoteHead ?? false,
    syncStatus: options.isRemoteHead ? 'remote' : 'local',
  };

  return {
    all: [entry],
    latest: entry,
    total: 1,
    hasUpstream: true,
  };
};

const createGitApi = (getGitStatus: GitAPI['getGitStatus']): GitAPI => ({
  checkIsGitRepository: async () => true,
  getGitStatus,
  getGitBranches: async () => ({ all: [], current: 'main', branches: {} }),
  getGitLog: async () => ({ all: [], latest: null, total: 0 }),
  getCurrentGitIdentity: async () => null,
  getGitFileDiff: async (_directory, options) => ({ original: '', modified: '', path: options.path }),
});

describe('useGitStore', () => {
  beforeEach(() => {
    useGitStore.setState({
      directories: new Map(),
      activeDirectory: null,
    });
  });

  test('does not reuse an in-flight light status request for full status', async () => {
    const requests: Deferred<GitStatus>[] = [];
    const statusCalls: Array<{ directory: string; options?: { mode?: 'light' } }> = [];
    const git = createGitApi((directory, options) => {
      statusCalls.push({ directory, options });
      const request = createDeferred<GitStatus>();
      requests.push(request);
      return request.promise;
    });

    const lightPromise = useGitStore.getState().fetchStatus('/repo', git, { mode: 'light', silent: true });
    const fullPromise = useGitStore.getState().fetchStatus('/repo', git, { silent: true });
    await Promise.resolve();

    expect(statusCalls).toEqual([
      { directory: '/repo', options: { mode: 'light' } },
      { directory: '/repo', options: undefined },
    ]);

    requests[0].resolve(createStatus());
    requests[1].resolve(createStatus({ 'src/index.ts': { insertions: 1, deletions: 0 } }));
    await Promise.all([lightPromise, fullPromise]);
  });

  test('reuses an in-flight full status request for light status', async () => {
    const requests: Deferred<GitStatus>[] = [];
    const statusCalls: Array<{ directory: string; options?: { mode?: 'light' } }> = [];
    const git = createGitApi((directory, options) => {
      statusCalls.push({ directory, options });
      const request = createDeferred<GitStatus>();
      requests.push(request);
      return request.promise;
    });

    const fullPromise = useGitStore.getState().fetchStatus('/repo', git, { silent: true });
    const lightPromise = useGitStore.getState().fetchStatus('/repo', git, { mode: 'light', silent: true });
    await Promise.resolve();

    expect(statusCalls).toEqual([{ directory: '/repo', options: undefined }]);

    requests[0].resolve(createStatus({ 'src/index.ts': { insertions: 1, deletions: 0 } }));
    const [fullResult, lightResult] = await Promise.all([fullPromise, lightPromise]);
    expect(lightResult).toBe(fullResult);
  });

  test('forces a fresh post-push status request and ignores the older result', async () => {
    const git = createGitApi(async () => createStatus());
    await useGitStore.getState().fetchStatus('/repo', git);

    const requests: Deferred<GitStatus>[] = [];
    git.getGitStatus = () => {
      const request = createDeferred<GitStatus>();
      requests.push(request);
      return request.promise;
    };

    const prePushRequest = useGitStore.getState().fetchStatus('/repo', git);
    const postPushRequest = useGitStore.getState().fetchStatus('/repo', git, { force: true });

    expect(requests).toHaveLength(2);

    requests[1].resolve({ ...createStatus(), ahead: 0 });
    await postPushRequest;
    requests[0].resolve({ ...createStatus(), ahead: 1 });
    await prePushRequest;

    const state = useGitStore.getState().getDirectoryState('/repo');
    expect(state?.status?.ahead).toBe(0);
    expect(state?.isLoadingStatus).toBe(false);
  });

  test('does not let an older history response overwrite pushed-tip metadata', async () => {
    const requests: Deferred<GitLogResponse>[] = [];
    const git = createGitApi(async () => createStatus());
    git.getGitLog = () => {
      const request = createDeferred<GitLogResponse>();
      requests.push(request);
      return request.promise;
    };

    const staleRequest = useGitStore.getState().fetchLog('/repo', git);
    const freshRequest = useGitStore.getState().fetchLog('/repo', git);

    requests[1].resolve(createLog('pushed', { isRemoteHead: true }));
    await freshRequest;
    requests[0].resolve(createLog('local-only'));
    await staleRequest;

    const state = useGitStore.getState().getDirectoryState('/repo');
    expect(state?.log?.latest?.hash).toBe('pushed');
    expect(state?.log?.latest?.isRemoteHead).toBe(true);
    expect(state?.isLoadingLog).toBe(false);
  });

  test('keeps history loading until the newest request finishes', async () => {
    const requests: Deferred<GitLogResponse>[] = [];
    const git = createGitApi(async () => createStatus());
    git.getGitLog = () => {
      const request = createDeferred<GitLogResponse>();
      requests.push(request);
      return request.promise;
    };

    const staleRequest = useGitStore.getState().fetchLog('/repo', git);
    const freshRequest = useGitStore.getState().fetchLog('/repo', git);

    requests[0].resolve(createLog('stale'));
    await staleRequest;
    expect(useGitStore.getState().getDirectoryState('/repo')?.isLoadingLog).toBe(true);

    requests[1].resolve(createLog('fresh', { isRemoteHead: true }));
    await freshRequest;
    expect(useGitStore.getState().getDirectoryState('/repo')?.isLoadingLog).toBe(false);
  });

  test('does not refresh branches or history when lightweight polling finds no changes', async () => {
    let branchCalls = 0;
    let logCalls = 0;
    const git = createGitApi(async () => createStatus());
    git.getGitBranches = async () => {
      branchCalls += 1;
      return { all: [], current: 'main', branches: {} };
    };
    git.getGitLog = async () => {
      logCalls += 1;
      return createLog('head', { isRemoteHead: true });
    };

    await useGitStore.getState().fetchStatus('/repo', git);
    const refreshed = await useGitStore.getState().pollStatusAndRefreshRepository('/repo', git);

    expect(refreshed).toBe(false);
    expect(branchCalls).toBe(0);
    expect(logCalls).toBe(0);
  });

  test('refreshes authoritative history when polling observes a pushed branch', async () => {
    let nextStatus = { ...createStatus(), tracking: 'origin/main', ahead: 1 };
    const git = createGitApi(async () => nextStatus);
    git.getGitLog = async () => createLog(nextStatus.ahead === 0 ? 'pushed' : 'local-only', {
      isRemoteHead: nextStatus.ahead === 0,
    });

    await useGitStore.getState().fetchStatus('/repo', git);
    await useGitStore.getState().fetchLog('/repo', git);

    nextStatus = { ...nextStatus, ahead: 0 };
    const refreshed = await useGitStore.getState().pollStatusAndRefreshRepository('/repo', git);

    const state = useGitStore.getState().getDirectoryState('/repo');
    expect(refreshed).toBe(true);
    expect(state?.status?.ahead).toBe(0);
    expect(state?.log?.latest?.hash).toBe('pushed');
    expect(state?.log?.latest?.isRemoteHead).toBe(true);
  });

  test('refreshes history for external commits and branch changes', async () => {
    let nextStatus: GitStatus = {
      ...createStatus(),
      current: 'main',
      tracking: null,
      files: [{ path: 'src/index.ts', index: ' ', working_dir: 'M' }],
      isClean: false,
    };
    let logHash = 'before';
    let logCalls = 0;
    const git = createGitApi(async () => nextStatus);
    git.getGitLog = async () => {
      logCalls += 1;
      return createLog(logHash);
    };

    await useGitStore.getState().fetchStatus('/repo', git);

    nextStatus = { ...createStatus(), current: 'main', tracking: null };
    logHash = 'external-commit';
    await useGitStore.getState().pollStatusAndRefreshRepository('/repo', git);

    nextStatus = { ...nextStatus, current: 'feature', tracking: 'origin/feature' };
    logHash = 'feature-head';
    await useGitStore.getState().pollStatusAndRefreshRepository('/repo', git);

    const state = useGitStore.getState().getDirectoryState('/repo');
    expect(logCalls).toBe(2);
    expect(state?.status?.current).toBe('feature');
    expect(state?.status?.tracking).toBe('origin/feature');
    expect(state?.log?.latest?.hash).toBe('feature-head');
  });

  test('deduplicates overlapping repository polls', async () => {
    const statusRequest = createDeferred<GitStatus>();
    let statusCalls = 0;
    const git = createGitApi(() => {
      statusCalls += 1;
      return statusRequest.promise;
    });

    const first = useGitStore.getState().pollStatusAndRefreshRepository('/repo', git);
    const second = useGitStore.getState().pollStatusAndRefreshRepository('/repo', git);
    await Promise.resolve();

    expect(first).toBe(second);
    expect(statusCalls).toBe(1);

    statusRequest.resolve(createStatus());
    await Promise.all([first, second]);
  });

  test('retries an incomplete authoritative refresh on the next unchanged poll', async () => {
    const initialStatus = { ...createStatus(), tracking: 'origin/main', ahead: 1 };
    let nextStatus = initialStatus;
    let logAttempts = 0;
    const git = createGitApi(async () => nextStatus);
    git.getGitLog = async () => {
      logAttempts += 1;
      if (logAttempts === 1) {
        throw new Error('temporary history failure');
      }
      return createLog('pushed', { isRemoteHead: true });
    };

    await useGitStore.getState().fetchStatus('/repo', git);
    nextStatus = { ...initialStatus, ahead: 0 };

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      await useGitStore.getState().pollStatusAndRefreshRepository('/repo', git);
      expect(useGitStore.getState().getDirectoryState('/repo')?.log).toBeNull();

      await useGitStore.getState().pollStatusAndRefreshRepository('/repo', git);
    } finally {
      console.error = originalConsoleError;
    }

    expect(logAttempts).toBe(2);
    expect(useGitStore.getState().getDirectoryState('/repo')?.log?.latest?.hash).toBe('pushed');
  });

  test('opens history by default for newly tracked directories', () => {
    useGitStore.getState().setActiveDirectory('/repo');

    const state = useGitStore.getState().getDirectoryState('/repo');
    expect(state?.historySectionOpen).toBe(true);
  });

  test('skips host Git identity reads when repository data is requested without identity', async () => {
    let identityCalls = 0;
    const git = createGitApi(async () => createStatus({}));
    git.getCurrentGitIdentity = async () => {
      identityCalls += 1;
      return null;
    };

    await useGitStore.getState().ensureAll('/repo', git, { includeIdentity: false });
    expect(identityCalls).toBe(0);

    await useGitStore.getState().ensureAll('/repo-with-identity', git, { includeIdentity: true });
    expect(identityCalls).toBe(1);
  });
});


describe('Git operation-only status changes', () => {
  test('publishes rebase start, metadata changes and completion without changing files', async () => {
    const directory = '/rebase-state';
    useGitStore.setState({ directories: new Map(), activeDirectory: null });
    let status = createStatus();
    const git = createGitApi(async () => status);
    const refresh = () => useGitStore.getState().fetchStatus(directory, git, { silent: true, force: true });
    await refresh();
    status = { ...status, rebaseInProgress: { headName: '', onto: '' } };
    await refresh();
    expect(useGitStore.getState().directories.get(directory)?.status?.rebaseInProgress).toEqual({ headName: '', onto: '' });
    status = { ...status, headState: 'detached', rebaseInProgress: { headName: 'Dev', onto: 'abc1234' } };
    await refresh();
    expect(useGitStore.getState().directories.get(directory)?.status).toBe(status);
    const previousStatus = status;
    status = { ...status, rebaseInProgress: { ...status.rebaseInProgress! } };
    await refresh();
    expect(useGitStore.getState().directories.get(directory)?.status).toBe(previousStatus);
    status = { ...status, headState: 'branch', rebaseInProgress: null };
    await refresh();
    expect(useGitStore.getState().directories.get(directory)?.status).toBe(status);
  });
});
