import { describe, expect, it, vi } from 'vitest';

import { fetchGoogleQuota } from './index.js';
import { resolveGoogleAuthSources } from './auth.js';

// Never read the real OpenCode auth store from a deterministic test.
vi.mock('../../../opencode/auth.js', () => ({
  readAuthFile: vi.fn(() => ({
    google: { type: 'oauth', refresh: 'fixture-refresh|fixture-project', access: 'fixture-access', expires: 0 },
  })),
}));

const makeSource = (sourceId) => ({
  sourceId,
  sourceLabel: sourceId,
  accessToken: `${sourceId}-access-token`,
  projectId: `${sourceId}-project`,
});

describe('Google quota', () => {
  it('fetches only Gemini source usage for the Google provider', async () => {
    const fetchModels = vi.fn(async (_accessToken, _projectId, sourceId) => ({
      models: {
        [`${sourceId}-model`]: {
          quotaInfo: {
            remainingFraction: 0.25,
            resetTime: '2026-01-01T00:00:00.000Z',
          },
        },
      },
    }));

    const result = await fetchGoogleQuota({
      authSources: [makeSource('gemini'), makeSource('antigravity')],
      fetchModels,
      fetchQuotaBuckets: async () => ({ buckets: [] }),
    });

    expect(result.providerId).toBe('google');
    expect(result.providerName).toBe('Google');
    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(fetchModels.mock.calls[0][2]).toBe('gemini');
    expect(result.usage.windows).toEqual({});
    expect(Object.keys(result.usage.models)).toEqual(['gemini/gemini-model']);
  });

  it('does not treat a non-Gemini source as configured Google usage', async () => {
    const result = await fetchGoogleQuota({
      authSources: [makeSource('antigravity')],
      fetchModels: vi.fn(),
      fetchQuotaBuckets: vi.fn(),
    });

    expect(result.providerId).toBe('google');
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
  });

  it('resolves Gemini CLI auth as the only Google quota source', () => {
    expect(resolveGoogleAuthSources().map((source) => source.sourceId)).toEqual(['gemini']);
  });
});
