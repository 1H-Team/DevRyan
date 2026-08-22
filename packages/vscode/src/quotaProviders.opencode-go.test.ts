import { describe, expect, it, vi } from 'vitest';

import { fetchOpenCodeGoQuota, resolveOpenCodeGoCredentials } from './quotaProviders';

const usageResponse = (status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({ usage: {
    rolling: { percent: 10, resetsAt: '2026-08-20T18:00:00Z' },
    weekly: { percent: 20, resetsAt: '2026-08-27T13:00:00Z' },
    monthly: { percent: 30, resetsAt: '2026-09-20T13:00:00Z' },
  } }),
});

describe('VS Code OpenCode Go quota provider', () => {
  it('selects key, token, then access while rejecting newline-bearing values', () => {
    expect(resolveOpenCodeGoCredentials({
      readAuth: () => ({ 'opencode-go': { key: ' key ', token: 'token', access: 'access' } }),
    })).toMatchObject({ apiConfigured: true, apiKey: 'key', source: 'auth' });
    expect(resolveOpenCodeGoCredentials({
      readAuth: () => ({ 'opencode-go': { key: 'bad\nkey', token: 'token' } }),
    })).toMatchObject({ apiConfigured: true, apiKey: 'token' });
  });

  it('performs field-scoped cleanup only after a successful refresh', async () => {
    const auth = {
      'opencode-go': {
        key: 'api-key',
        usageWorkspaceId: 'wrk_old',
        usageAuthCookie: 'cookie',
        preserved: true,
      },
      anthropic: { access: 'keep' },
    };
    const deleteLegacyOpenCodeGoCredential = vi.fn();
    const mutateOpenCodeAuth = vi.fn((mutator) => mutator(auth));
    const result = await fetchOpenCodeGoQuota({
      readAuth: () => auth,
      fetchImpl: async () => usageResponse(),
      deleteLegacyOpenCodeGoCredential,
      mutateOpenCodeAuth,
      now: () => Date.parse('2026-08-20T13:00:00Z'),
    });

    expect(result.ok).toBe(true);
    expect(deleteLegacyOpenCodeGoCredential).toHaveBeenCalledOnce();
    expect(mutateOpenCodeAuth).toHaveBeenCalledOnce();
    expect(auth).toEqual({
      'opencode-go': { key: 'api-key', preserved: true },
      anthropic: { access: 'keep' },
    });
  });

  it('does not clean on API failure and sanitizes cleanup failures', async () => {
    const deleteLegacyOpenCodeGoCredential = vi.fn();
    const mutateOpenCodeAuth = vi.fn();
    const rejected = await fetchOpenCodeGoQuota({
      readAuth: () => ({ 'opencode-go': { key: 'api-key' } }),
      fetchImpl: async () => usageResponse(401),
      deleteLegacyOpenCodeGoCredential,
      mutateOpenCodeAuth,
    });
    expect(rejected).toMatchObject({ ok: false, errorCode: 'AUTHENTICATION_FAILED' });
    expect(deleteLegacyOpenCodeGoCredential).not.toHaveBeenCalled();
    expect(mutateOpenCodeAuth).not.toHaveBeenCalled();

    const cleanupFailure = await fetchOpenCodeGoQuota({
      readAuth: () => ({ 'opencode-go': { key: 'api-key' } }),
      fetchImpl: async () => usageResponse(),
      deleteLegacyOpenCodeGoCredential: () => { throw new Error('/private/path'); },
      mutateOpenCodeAuth: () => { throw new Error('secret'); },
    });
    expect(cleanupFailure.ok).toBe(true);
    expect(cleanupFailure.warnings).toContain('OpenCode Go usage refreshed, but legacy credential cleanup failed.');
    expect(JSON.stringify(cleanupFailure)).not.toContain('/private/path');
  });
});
