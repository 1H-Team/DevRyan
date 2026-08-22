import { describe, expect, it, vi } from 'vitest';

import { fetchQuota, isConfigured, resolveOpenCodeGoCredentials } from './opencode-go.js';

const usageResponse = (status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({
    usage: {
      rolling: { percent: 10, resetsAt: '2026-08-20T18:00:00Z' },
      weekly: { percent: 20, resetsAt: '2026-08-27T13:00:00Z' },
      monthly: { percent: 30, resetsAt: '2026-09-20T13:00:00Z' },
    },
  }),
});

describe('OpenCode Go quota provider', () => {
  it('discovers the first safe auth value in key, token, access order', () => {
    expect(resolveOpenCodeGoCredentials({
      readAuth: () => ({ 'opencode-go': { key: ' key-value ', token: 'token-value', access: 'access-value' } }),
    })).toMatchObject({ apiConfigured: true, apiKey: 'key-value', source: 'auth' });
    expect(resolveOpenCodeGoCredentials({
      readAuth: () => ({ 'opencode-go': { key: 'bad\nkey', token: 'token-value' } }),
    })).toMatchObject({ apiConfigured: true, apiKey: 'token-value' });
    expect(isConfigured({ readAuth: () => ({ 'opencode-go': { access: 'access-value' } }) })).toBe(true);
  });

  it('cleans only legacy fields after a successful API refresh', async () => {
    const auth = {
      'opencode-go': {
        key: 'api-key',
        usageWorkspaceId: 'wrk_old',
        usageAuthCookie: 'old-cookie',
        preserved: { nested: true },
      },
      anthropic: { access: 'keep-me' },
    };
    const deleteManagedCredential = vi.fn();
    const mutateAuth = vi.fn((mutator) => mutator(auth));
    const result = await fetchQuota({
      readAuth: () => auth,
      fetchImpl: async () => usageResponse(),
      deleteManagedCredential,
      mutateAuth,
      now: () => Date.parse('2026-08-20T13:00:00Z'),
    });

    expect(result.ok).toBe(true);
    expect(deleteManagedCredential).toHaveBeenCalledOnce();
    expect(mutateAuth).toHaveBeenCalledOnce();
    expect(auth).toEqual({
      'opencode-go': { key: 'api-key', preserved: { nested: true } },
      anthropic: { access: 'keep-me' },
    });
  });

  it('does not clean credentials when configuration or the API request fails', async () => {
    const deleteManagedCredential = vi.fn();
    const mutateAuth = vi.fn();
    const missing = await fetchQuota({
      readAuth: () => ({}),
      deleteManagedCredential,
      mutateAuth,
    });
    const rejected = await fetchQuota({
      readAuth: () => ({ 'opencode-go': { key: 'api-key' } }),
      fetchImpl: async () => usageResponse(401),
      deleteManagedCredential,
      mutateAuth,
    });
    expect(missing).toMatchObject({ ok: false, configured: false });
    expect(rejected).toMatchObject({ ok: false, errorCode: 'AUTHENTICATION_FAILED' });
    expect(deleteManagedCredential).not.toHaveBeenCalled();
    expect(mutateAuth).not.toHaveBeenCalled();
  });

  it('keeps successful usage and adds one sanitized warning when cleanup fails', async () => {
    const result = await fetchQuota({
      readAuth: () => ({ 'opencode-go': { key: 'api-key' } }),
      fetchImpl: async () => usageResponse(),
      deleteManagedCredential: () => { throw new Error('/secret/path'); },
      mutateAuth: () => { throw new Error('cookie=secret'); },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(['OpenCode Go usage refreshed, but legacy credential cleanup failed.']);
    expect(JSON.stringify(result)).not.toContain('/secret/path');
    expect(JSON.stringify(result)).not.toContain('cookie=secret');
  });
});
