import { describe, expect, test } from 'bun:test';
import {
  AsyncTaskLimiter,
  loadDirectoriesInDepthBatches,
  runOwnedDirectoryLoad,
  type DirectoryLoadRegistry,
} from './sidebarFilesTreeRefresh';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('sidebar file-tree refresh coordination', () => {
  test('deduplicates an in-flight directory request', async () => {
    const request = deferred<string>();
    const inFlight: DirectoryLoadRegistry = new Map();
    let loaded = false;
    let requestCount = 0;
    const options = {
      directory: '/repo',
      inFlight,
      shouldStart: () => !loaded,
      request: () => {
        requestCount += 1;
        return request.promise;
      },
      shouldCommit: () => true,
      commit: () => { loaded = true; },
    };

    const first = runOwnedDirectoryLoad(options);
    const second = runOwnedDirectoryLoad(options);
    expect(requestCount).toBe(1);
    request.resolve('done');
    await Promise.all([first, second]);

    expect(requestCount).toBe(1);
    expect(inFlight.size).toBe(0);
  });

  test('suppresses an old generation and retries it for the new owner', async () => {
    const oldRequest = deferred<string>();
    const inFlight: DirectoryLoadRegistry = new Map();
    const commits: string[] = [];
    let generation = 1;
    let requestCount = 0;

    const load = (owner: number) => runOwnedDirectoryLoad({
      directory: '/repo',
      inFlight,
      shouldStart: () => generation === owner && commits.length === 0,
      request: () => {
        requestCount += 1;
        return requestCount === 1 ? oldRequest.promise : Promise.resolve('new');
      },
      shouldCommit: () => generation === owner,
      commit: (value) => commits.push(value),
    });

    const first = load(1);
    generation = 2;
    const second = load(2);
    oldRequest.resolve('old');
    await Promise.all([first, second]);

    expect(requestCount).toBe(2);
    expect(commits).toEqual(['new']);
  });

  test('loads shallow directories first and never exceeds three active requests', async () => {
    const limiter = new AsyncTaskLimiter(3);
    const starts: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const directories = ['/repo/a/deep', '/repo/c', '/repo/b', '/repo/a'];

    await loadDirectoriesInDepthBatches(directories, (directory) => limiter.run(async () => {
      starts.push(directory);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
    }), () => true);

    expect(starts.slice(0, 3)).toEqual(['/repo/a', '/repo/b', '/repo/c']);
    expect(maximumActive).toBe(3);
  });
});
