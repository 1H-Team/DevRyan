import { describe, expect, test } from 'bun:test';

import {
  fetchQuotaForProvider,
  resolveCursorQuotaCredential,
  resolveOllamaCloudCredential,
  resolveOpenCodeGoCredentials,
} from '../src/quotaProviders';

describe('VS Code Cursor ACP quota provider', () => {
  test('maps Cursor dashboard usage summary buckets to quota windows', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        billingCycleStart: '2026-04-02T14:11:55.000Z',
        billingCycleEnd: '2026-05-02T14:11:55.000Z',
        individualUsage: {
          plan: {
            totalPercentUsed: 86,
            autoPercentUsed: 82,
            apiPercentUsed: 100,
          },
        },
      }),
    });

    const result = await fetchQuotaForProvider('cursor-acp', {
      readAuth: () => ({ 'cursor-acp': { usageSessionToken: 'secret-token' } }),
      fetchImpl,
    });

    expect(result.providerId).toBe('cursor-acp');
    expect(result.providerName).toBe('Cursor');
    expect(result.ok).toBe(true);
    expect(result.usage?.windows.total).toBeUndefined();
    expect(result.usage?.windows['auto-composer'].usedPercent).toBe(82);
    expect(result.usage?.windows.api.usedPercent).toBe(100);
  });

  test('maps Cursor current-period dashboard buckets to quota windows', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        planUsage: {
          autoPercentUsed: 82,
          apiPercentUsed: 100,
        },
      }),
    });

    const result = await fetchQuotaForProvider('cursor-acp', {
      readAuth: () => ({ 'cursor-acp': { usageSessionToken: 'secret-token' } }),
      fetchImpl,
    });

    expect(result.providerId).toBe('cursor-acp');
    expect(result.providerName).toBe('Cursor');
    expect(result.ok).toBe(true);
    expect(result.usage?.windows.total).toBeUndefined();
    expect(result.usage?.windows['auto-composer'].usedPercent).toBe(82);
    expect(result.usage?.windows.api.usedPercent).toBe(100);
  });

  test('uses the Cursor alias without creating a second provider identity', async () => {
    const result = await fetchQuotaForProvider('cursor', {
      env: {},
      readAuth: () => ({}),
      readManagedCredential: () => ({ sessionToken: 'managed-dashboard' }),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ planUsage: { autoPercentUsed: 10, apiPercentUsed: 20 } }),
      }),
    });

    expect(result.providerId).toBe('cursor-acp');
    expect(result.ok).toBe(true);
  });

  test('persists refreshed OAuth tokens only for the managed source', async () => {
    const expired = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.signature`;
    const writes: unknown[] = [];
    const fetchImpl = async (url: string) => url.endsWith('/oauth/token')
      ? { ok: true, status: 200, json: async () => ({ access_token: 'refreshed' }) }
      : {
          ok: true,
          status: 200,
          json: async () => ({ planUsage: { autoPercentUsed: 10, apiPercentUsed: 20 } }),
        };

    const managed = await fetchQuotaForProvider('cursor-acp', {
      env: {},
      readAuth: () => ({}),
      readManagedCredential: () => ({ accessToken: expired, refreshToken: 'refresh' }),
      writeManagedCredential: (_providerId, credential) => writes.push(credential),
      fetchImpl,
    });
    expect(managed.ok).toBe(true);
    expect(writes).toEqual([{ accessToken: 'refreshed', refreshToken: 'refresh' }]);

    writes.length = 0;
    const environment = await fetchQuotaForProvider('cursor-acp', {
      env: { CURSOR_ACCESS_TOKEN: expired, CURSOR_REFRESH_TOKEN: 'refresh' },
      readAuth: () => ({}),
      readManagedCredential: () => null,
      writeManagedCredential: (_providerId, credential) => writes.push(credential),
      fetchImpl,
    });
    expect(environment.ok).toBe(true);
    expect(writes).toEqual([]);
  });

  test('resolves environment, token-file, managed, then legacy sources', () => {
    const common = {
      readAuth: () => ({ 'cursor-acp': { usageSessionToken: 'legacy' } }),
      readManagedCredential: () => ({ sessionToken: 'managed' } as const),
    };
    expect(resolveCursorQuotaCredential({
      ...common,
      env: { CURSOR_ACCESS_TOKEN: 'environment' },
      readTokenFile: () => 'file',
    }).source).toBe('environment');
    expect(resolveCursorQuotaCredential({
      ...common,
      env: { CURSOR_TOKEN_FILE: '/token' },
      readTokenFile: () => 'file',
    }).source).toBe('token-file');
    expect(resolveCursorQuotaCredential({
      ...common,
      env: {},
      readTokenFile: () => '',
    }).source).toBe('managed');
  });
});

describe('VS Code OpenCode Go quota provider', () => {
  test('maps dashboard rolling weekly and monthly usage to quota windows', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => [
        'rollingUsage:$R[1]={usagePercent:3,resetInSec:17460}',
        'weeklyUsage:$R[2]={usagePercent:14,resetInSec:482400}',
        'monthlyUsage:$R[3]={usagePercent:83,resetInSec:1569600}',
      ].join('\n'),
    });

    const result = await fetchQuotaForProvider('opencode-go', {
      readAuth: () => ({
        'opencode-go': {
          usageWorkspaceId: 'wrk_abc123',
          usageAuthCookie: 'Fe26.2**secret-cookie',
        },
      }),
      fetchImpl,
    });

    expect(result.providerId).toBe('opencode-go');
    expect(result.providerName).toBe('OpenCode Go');
    expect(result.ok).toBe(true);
    expect(result.usage?.windows.rolling).toMatchObject({
      usedPercent: 3,
      windowSeconds: 5 * 60 * 60,
      description: '$12 of usage every 5 hours.',
    });
    expect(result.usage?.windows.weekly).toMatchObject({
      usedPercent: 14,
      windowSeconds: 7 * 24 * 60 * 60,
      description: '$30 of usage per week.',
    });
    expect(result.usage?.windows.monthly).toMatchObject({
      usedPercent: 83,
      windowSeconds: 30 * 24 * 60 * 60,
      description: '$60 of usage per month.',
    });
    expect(JSON.stringify(result)).not.toContain('secret-cookie');
  });

  test('maps dashboard usage when the page renders direct serialized objects', async () => {
    const originalDateNow = Date.now;
    Date.now = () => Date.parse('2026-07-08T12:00:00.000Z');
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => [
        '"rollingUsage":{"usagePercent":3,"resetInSec":17460}',
        'weeklyUsage:{usagePercent:14,resetInSec:482400}',
        'monthlyUsage:$R[3]={"usagePercent":83,"resetInSec":1569600}',
      ].join('\n'),
    });

    try {
      const result = await fetchQuotaForProvider('opencode-go', {
        readAuth: () => ({
          'opencode-go': {
            usageWorkspaceId: 'wrk_abc123',
            usageAuthCookie: 'Fe26.2**secret-cookie',
          },
        }),
        fetchImpl,
      });

      expect(result.ok).toBe(true);
      expect(result.usage?.windows.rolling).toMatchObject({
        usedPercent: 3,
        resetAfterSeconds: 17460,
      });
      expect(result.usage?.windows.weekly).toMatchObject({
        usedPercent: 14,
        resetAfterSeconds: 482400,
      });
      expect(result.usage?.windows.monthly).toMatchObject({
        usedPercent: 83,
        resetAfterSeconds: 1569600,
      });
    } finally {
      Date.now = originalDateNow;
    }
  });

  test('prefers managed OpenCode Go credentials over legacy auth fields', () => {
    expect(resolveOpenCodeGoCredentials({
      env: {},
      readManagedCredential: () => ({ workspaceId: 'wrk_managed', authCookie: 'managed' }),
      readAuth: () => ({
        'opencode-go': { usageWorkspaceId: 'wrk_legacy', usageAuthCookie: 'legacy' },
      }),
    })).toMatchObject({
      workspaceId: 'wrk_managed',
      authCookie: 'managed',
      source: 'managed',
    });
  });
});

describe('VS Code Ollama Cloud quota provider', () => {
  test('uses the managed cookie before preserving the legacy fallback', () => {
    expect(resolveOllamaCloudCredential({
      readManagedCredential: () => ({ cookie: 'managed' }),
      readLegacyOllamaCookie: () => 'legacy',
    })).toEqual({ credential: { cookie: 'managed' }, source: 'managed' });
    expect(resolveOllamaCloudCredential({
      readManagedCredential: () => null,
      readLegacyOllamaCookie: () => 'legacy',
    })).toEqual({ credential: { cookie: 'legacy' }, source: 'legacy' });
  });
});

describe('VS Code GitHub Copilot quota provider', () => {
  test('shows token-based billing quota as AI Credits', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        quota_reset_date_utc: '2026-07-01T00:00:00.000Z',
        token_based_billing: true,
        quota_snapshots: {
          premium_interactions: {
            entitlement: 7000,
            remaining: 5250,
          },
        },
      }),
    });

    const result = await fetchQuotaForProvider('github-copilot', {
      readAuth: () => ({ 'github-copilot': { access: 'copilot-token' } }),
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.usage?.windows.premium).toBeUndefined();
    expect(result.usage?.windows['ai-credits']).toMatchObject({
      usedPercent: 25,
      resetAt: Date.parse('2026-07-01T00:00:00.000Z'),
      valueLabel: '5250 / 7000 credits left',
      description: 'AI Credits are consumed from token usage, including input, output, and cached tokens.',
    });
  });

  test('keeps legacy premium request labeling for request-based quota payloads', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        quota_reset_date: '2026-07-01',
        quota_snapshots: {
          premium_interactions: {
            entitlement: 300,
            remaining: 225,
          },
        },
      }),
    });

    const result = await fetchQuotaForProvider('github-copilot', {
      readAuth: () => ({ 'github-copilot': { access: 'copilot-token' } }),
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.usage?.windows['ai-credits']).toBeUndefined();
    expect(result.usage?.windows.premium).toMatchObject({
      usedPercent: 25,
      valueLabel: '225 / 300 requests left',
    });
  });
});
