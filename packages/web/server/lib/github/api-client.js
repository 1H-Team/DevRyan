import { Octokit } from '@octokit/rest';

export const DEFAULT_GITHUB_API_TIMEOUT_MS = 15_000;

const createTimeoutError = (timeoutMs) => {
  const error = new Error(`GitHub API request timed out after ${timeoutMs}ms`);
  error.name = 'TimeoutError';
  error.code = 'GITHUB_API_TIMEOUT';
  return error;
};

export const createTimeoutFetch = ({
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_GITHUB_API_TIMEOUT_MS,
} = {}) => {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is required');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive number');
  }

  return async (input, init = {}) => {
    const controller = new AbortController();
    const upstreamSignal = init.signal;
    const forwardAbort = () => controller.abort(upstreamSignal?.reason);
    if (upstreamSignal?.aborted) {
      forwardAbort();
    } else {
      upstreamSignal?.addEventListener('abort', forwardAbort, { once: true });
    }

    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = createTimeoutError(timeoutMs);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        fetchImpl(input, { ...init, signal: controller.signal }),
        timeout,
      ]);
    } finally {
      clearTimeout(timeoutId);
      upstreamSignal?.removeEventListener('abort', forwardAbort);
    }
  };
};

export const fetchGitHubApi = (input, init, options) => {
  return createTimeoutFetch(options)(input, init);
};

export const createGitHubApiClient = ({
  auth,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_GITHUB_API_TIMEOUT_MS,
  OctokitClass = Octokit,
} = {}) => {
  const token = typeof auth === 'string' ? auth.trim() : '';
  if (!token) {
    throw new Error('GitHub auth token is required');
  }
  return new OctokitClass({
    auth: token,
    request: {
      fetch: createTimeoutFetch({ fetchImpl, timeoutMs }),
    },
  });
};
