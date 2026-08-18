import { describe, expect, test } from 'bun:test';

import {
  fetchCodexQuota,
  fetchDeepSeekQuota,
  fetchKimiQuota,
  fetchQuotaForProvider,
  fetchXaiQuota,
  fetchZaiQuota,
  listConfiguredQuotaProviders,
  resolveCursorQuotaCredential,
  resolveOllamaCloudCredential,
  resolveOpenCodeGoCredentials,
} from '../src/quotaProviders';
import * as webCodex from '../../web/server/lib/quota/providers/codex.js';
import * as webDeepSeek from '../../web/server/lib/quota/providers/deepseek.js';
import * as webKimi from '../../web/server/lib/quota/providers/kimi.js';
import * as webXai from '../../web/server/lib/quota/providers/xai.js';
import * as webZai from '../../web/server/lib/quota/providers/zai.js';

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

describe('shared web and VS Code quota provider parity', () => {
  const fixedNow = () => Date.parse('2026-08-11T12:00:00.000Z');
  const ok = (payload: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => structuredClone(payload),
  });

  test('discovers the same configured touched providers in the same order', () => {
    const auth = {
      openai: { access: 'codex' },
      xai: { access: 'xai' },
      deepseek: { key: 'deepseek' },
      'zai-coding-plan': { key: 'zai' },
      'kimi-for-coding': { key: 'kimi' },
    };
    const touched = ['codex', 'xai', 'deepseek', 'zai-coding-plan', 'kimi-for-coding'];
    const webConfigured = [webCodex, webXai, webDeepSeek, webZai, webKimi]
      .filter((provider) => provider.isConfigured({ readAuth: () => auth }))
      .map((provider) => provider.providerId);
    const vscodeConfigured = listConfiguredQuotaProviders({
      readAuth: () => auth,
      isExternalRuntime: true,
    }).filter((providerId) => touched.includes(providerId));

    expect(vscodeConfigured).toEqual(webConfigured);
  });

  test.each([
    {
      name: 'z.ai',
      auth: { 'zai-coding-plan': { key: 'secret' } },
      payload: {
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', number: '5', unit: '3', percentage: '20', nextResetTime: '1786456800' },
            { type: 'TOKENS_LIMIT', number: 0, unit: 3, percentage: 10 },
          ],
        },
      },
      webFetch: webZai.fetchQuota,
      vscodeFetch: fetchZaiQuota,
    },
    {
      name: 'Kimi',
      auth: { 'kimi-for-coding': { key: 'secret' } },
      payload: {
        usage: { percentage: '25', reset_at: '1786456800' },
        limits: [{
          window: { duration: '5', timeUnit: 'TIME_UNIT_HOUR' },
          detail: { used: '20', limit: '80', resetTime: '2026-08-12T00:00:00Z' },
        }],
      },
      webFetch: webKimi.fetchQuota,
      vscodeFetch: fetchKimiQuota,
    },
    {
      name: 'ChatGPT',
      auth: { openai: { access: 'secret', accountId: 'account' } },
      payload: {
        rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18_000, reset_at: 1_786_456_800 } },
        spend_control: { reached: false },
        credits: { balance: '8.5', available: true },
      },
      webFetch: webCodex.fetchQuota,
      vscodeFetch: fetchCodexQuota,
    },
    {
      name: 'xAI',
      auth: { xai: { access: 'secret' } },
      payload: {
        config: {
          creditUsagePercent: '44',
          currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-08-18T00:00:00Z' },
        },
      },
      webFetch: webXai.fetchQuota,
      vscodeFetch: fetchXaiQuota,
    },
    {
      name: 'DeepSeek',
      auth: { deepseek: { key: 'secret' } },
      payload: {
        is_available: false,
        balance_infos: [{ currency: 'USD', total_balance: '12.5', granted_balance: '10', topped_up_balance: '2.5' }],
      },
      webFetch: webDeepSeek.fetchQuota,
      vscodeFetch: fetchDeepSeekQuota,
    },
  ])('emits exactly equal normalized $name results', async ({ auth, payload, webFetch, vscodeFetch }) => {
    const fetchFactory = () => async (url: string) => (
      url.includes('rate-limit-reset-credits') ? ok({}, 404) : ok(payload)
    );
    const webResult = await webFetch({ readAuth: () => auth, fetchImpl: fetchFactory(), now: fixedNow });
    const vscodeResult = await vscodeFetch({ readAuth: () => auth, fetchImpl: fetchFactory(), now: fixedNow });

    expect(vscodeResult).toEqual(webResult);
  });

  test('routes Grok aliases and persists a rotated OAuth token before the retry', async () => {
    const auth = { xai: { type: 'oauth', access: 'old', refresh: 'old-refresh' } };
    const writes: unknown[] = [];
    let billingCalls = 0;
    const result = await fetchQuotaForProvider('grok', {
      readAuth: () => auth,
      writeAuth: (next) => writes.push(structuredClone(next)),
      now: fixedNow,
      fetchImpl: async (url) => {
        if (url.includes('/oauth2/token')) {
          return ok({ access_token: 'new', refresh_token: 'new-refresh', expires_in: 3600 });
        }
        billingCalls += 1;
        return billingCalls === 1
          ? ok({}, 401)
          : ok({ creditUsagePercent: 12, billingPeriodEnd: '2026-08-18T00:00:00Z' });
      },
    });

    expect(result).toMatchObject({ ok: true, providerId: 'xai' });
    expect(writes).toEqual([{
      xai: {
        type: 'oauth',
        access: 'new',
        refresh: 'new-refresh',
        expires: fixedNow() + 3_600_000,
      },
    }]);
    expect(billingCalls).toBe(2);
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
