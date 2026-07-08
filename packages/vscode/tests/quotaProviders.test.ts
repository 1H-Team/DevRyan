import { describe, expect, test } from 'bun:test';

import { fetchQuotaForProvider } from '../src/quotaProviders';

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
