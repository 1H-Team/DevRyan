import { describe, expect, it, vi } from 'vitest';
import {
  createGitHubApiClient,
  createTimeoutFetch,
} from './api-client.js';

describe('GitHub API client factory', () => {
  it('creates clients with the selected token and shared fetch wrapper', async () => {
    let options;
    class FakeOctokit {
      constructor(nextOptions) {
        options = nextOptions;
      }
    }
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));

    const client = createGitHubApiClient({
      auth: ' selected-token ',
      fetchImpl,
      timeoutMs: 500,
      OctokitClass: FakeOctokit,
    });

    expect(client).toBeInstanceOf(FakeOctokit);
    expect(options.auth).toBe('selected-token');
    await options.request.fetch('https://api.github.test/repos/example/project');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts and rejects a request when its timeout expires', async () => {
    let requestSignal;
    const fetchImpl = vi.fn((_input, init) => {
      requestSignal = init.signal;
      return new Promise(() => {});
    });
    const timeoutFetch = createTimeoutFetch({ fetchImpl, timeoutMs: 5 });

    await expect(timeoutFetch('https://api.github.test/slow')).rejects.toMatchObject({
      name: 'TimeoutError',
      code: 'GITHUB_API_TIMEOUT',
    });
    expect(requestSignal.aborted).toBe(true);
  });

  it('rejects missing credentials before constructing a client', () => {
    const OctokitClass = vi.fn();

    expect(() => createGitHubApiClient({ auth: ' ', OctokitClass })).toThrow('GitHub auth token is required');
    expect(OctokitClass).not.toHaveBeenCalled();
  });
});
