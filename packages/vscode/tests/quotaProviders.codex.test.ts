import { describe, expect, test } from 'bun:test';

import { fetchQuotaForProvider } from '../src/quotaProviders';

const readAuth = () => ({
  openai: {
    access: 'openai-access-token',
    accountId: 'account-id',
  },
});

const okResponse = (payload: unknown) => ({
  ok: true,
  status: 200,
  json: async () => payload,
});

const failedResponse = (status = 404) => ({
  ok: false,
  status,
  json: async () => ({}),
});

describe('VS Code Codex quota provider reset credits', () => {
  test('uses dedicated reset-credit details instead of the dollar credits row', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/wham/usage')) {
        return okResponse({
          rate_limit: {
            primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1783425600 },
            secondary_window: { used_percent: 50, limit_window_seconds: 604800, reset_at: 1783944000 },
          },
          credits: { balance: '12.34' },
          rate_limit_reset_credits: { available_count: 1 },
        });
      }
      return okResponse({
        available_count: 2,
        total_earned_count: 3,
        credits: [
          {
            id: 'RateLimitResetCredit_one',
            status: 'available',
            reset_type: 'codex_rate_limits',
            granted_at: '2026-07-01T00:00:00.000Z',
            expires_at: '2026-07-31T00:00:00.000Z',
          },
        ],
      });
    };

    const result = await fetchQuotaForProvider('codex', { readAuth, fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.usage?.windows.credits).toBeUndefined();
    expect(result.usage?.resetCredits).toMatchObject({
      availableCount: 2,
      totalEarnedCount: 3,
      source: 'dedicated',
      credits: [{
        id: 'RateLimitResetCredit_one',
        status: 'available',
        resetType: 'codex_rate_limits',
        grantedAt: Date.parse('2026-07-01T00:00:00.000Z'),
        expiresAt: Date.parse('2026-07-31T00:00:00.000Z'),
      }],
    });
    expect(calls[1]?.init?.headers).toMatchObject({
      'ChatGPT-Account-Id': 'account-id',
      'OpenAI-Beta': 'codex-1',
      originator: 'Codex Desktop',
    });
  });

  test('falls back to usage reset-credit count when dedicated endpoint fails', async () => {
    const fetchImpl = async (url: string) => {
      if (url.endsWith('/wham/usage')) {
        return okResponse({
          rate_limit_reset_credits: { available_count: 2 },
          credits: { balance: '12.34' },
        });
      }
      return failedResponse(404);
    };

    const result = await fetchQuotaForProvider('codex', { readAuth, fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.usage?.windows.credits).toBeUndefined();
    expect(result.usage?.resetCredits).toMatchObject({
      availableCount: 2,
      credits: [],
      source: 'usage',
    });
  });

  test('keeps legacy dollar credits when no reset-credit data is available', async () => {
    const fetchImpl = async (url: string) => {
      if (url.endsWith('/wham/usage')) {
        return okResponse({ credits: { balance: '12.34' } });
      }
      return failedResponse(404);
    };

    const result = await fetchQuotaForProvider('codex', { readAuth, fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.usage?.resetCredits).toBeUndefined();
    expect(result.usage?.windows.credits).toMatchObject({
      valueLabel: '$12.34 remaining',
    });
  });
});
