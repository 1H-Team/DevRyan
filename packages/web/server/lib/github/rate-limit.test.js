import { describe, expect, it } from 'vitest';
import {
  classifyGitHubApiError,
  createGitHubRateLimitTracker,
} from './rate-limit.js';

const rateLimitError = (resetAtSeconds) => ({
  status: 403,
  response: {
    headers: {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(resetAtSeconds),
    },
  },
});

describe('GitHub rate-limit cooldown', () => {
  it('keeps authentication, authorization, and rate-limit failures distinct', () => {
    expect(classifyGitHubApiError({ status: 401 })).toBe('authentication');
    expect(classifyGitHubApiError({ status: 403 })).toBe('forbidden');
    expect(classifyGitHubApiError(rateLimitError(120))).toBe('rate_limit');
    expect(classifyGitHubApiError({ status: 429 })).toBe('rate_limit');
  });

  it('reports an active cooldown and releases it after expiry', () => {
    let now = 10_000;
    const tracker = createGitHubRateLimitTracker({ now: () => now });

    expect(tracker.recordFailure(rateLimitError(20))).toEqual({
      retryAt: 20_000,
      retryAfterMs: 10_000,
    });
    expect(tracker.getCooldown()).toEqual({
      retryAt: 20_000,
      retryAfterMs: 10_000,
    });

    now = 20_000;
    expect(tracker.getCooldown()).toBeNull();
  });
});
