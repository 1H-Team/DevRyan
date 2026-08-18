import { describe, expect, test } from 'bun:test';

import {
  CODEX_RESET_CREDITS_URL,
  CODEX_USAGE_URL,
  DEEPSEEK_BALANCE_URL,
  KIMI_QUOTA_URL,
  XAI_BILLING_URL,
  XAI_CLIENT_VERSION,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_TOKEN_URL,
  ZAI_QUOTA_URL,
  fetchCodexQuotaAdapter,
  fetchDeepSeekQuotaAdapter,
  fetchKimiQuotaAdapter,
  fetchXaiQuotaAdapter,
  fetchZaiQuotaAdapter,
  refreshXaiOAuthToken,
  toQuotaTimestamp,
} from './quota-adapters.js';

const NOW = Date.parse('2026-08-11T12:00:00.000Z');
const now = () => NOW;

const response = (payload, status = 200, headers = {}, url = '') => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  headers: {
    get(name) {
      const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
      return entry?.[1] ?? null;
    },
  },
  json: async () => payload,
});

describe('z.ai shared quota adapter', () => {
  test('parses, sorts, suffixes, and warns for every token window', async () => {
    const result = await fetchZaiQuotaAdapter({
      credential: { apiKey: 'secret' },
      now,
      fetchImpl: async (url) => {
        expect(url).toBe(ZAI_QUOTA_URL);
        return response({
          data: {
            limits: [
              { type: 'TOKENS_LIMIT', number: '5', unit: '3', percentage: '130', nextResetTime: '1786456800' },
              { type: 'TOKENS_LIMIT', number: 1, unit: 3, percentage: 20, nextResetTime: '2026-08-11T13:00:00Z' },
              { type: 'TOKENS_LIMIT', number: 5, unit: 3, percentage: 40 },
              { type: 'TOKENS_LIMIT', number: 0, unit: 3, percentage: 10 },
              { type: 'TIME_LIMIT', number: 1, unit: 3, percentage: 50 },
            ],
          },
        });
      },
    });

    expect(result).toMatchObject({
      ok: true,
      fetchedAt: NOW,
      warnings: ['Token limit #4 was skipped because its duration was invalid.'],
    });
    expect(Object.keys(result.usage.windows)).toEqual(['1h', '5h', '5h #2']);
    expect(result.usage.windows['1h']).toMatchObject({ usedPercent: 20, resetAt: Date.parse('2026-08-11T13:00:00Z') });
    expect(result.usage.windows['5h']).toMatchObject({ usedPercent: 100, windowSeconds: 18_000 });
  });

  test('returns a parse error when claimed token limits are all malformed', async () => {
    const result = await fetchZaiQuotaAdapter({
      credential: { apiKey: 'secret' },
      now,
      fetchImpl: async () => response({ data: { limits: [{ type: 'TOKENS_LIMIT', number: 0 }] } }),
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'PARSE_ERROR' });
    expect(result.usage).toBeNull();
  });
});

describe('Kimi shared quota adapter', () => {
  test('uses percentage, used, then remaining precedence with numeric strings and reset variants', async () => {
    const result = await fetchKimiQuotaAdapter({
      credential: { apiKey: 'secret' },
      now,
      fetchImpl: async (url) => {
        expect(url).toBe(KIMI_QUOTA_URL);
        return response({
          usage: {
            percentage: '25',
            used: 99,
            limit: 100,
            reset_at: '1786456800',
          },
          limits: [
            {
              window: { duration: '5', timeUnit: 'TIME_UNIT_HOUR' },
              detail: { used: '20', limit: '80', remaining: 1, resetTime: '2026-08-12T00:00:00Z' },
            },
            {
              window: { duration: 1, timeUnit: 'TIME_UNIT_DAY' },
              detail: { remaining: '-20', limit: '100', next_reset_time: 1786536000 },
            },
            {
              window: { duration: 2, timeUnit: 'TIME_UNIT_DAY' },
              detail: { used: 1, limit: 0 },
            },
          ],
        });
      },
    });

    expect(result.usage.windows.weekly.usedPercent).toBe(25);
    expect(result.usage.windows['Rate Limit (5h)'].usedPercent).toBe(25);
    expect(result.usage.windows['1d'].usedPercent).toBe(100);
    expect(result.usage.windows['2d']).toBeUndefined();
    expect(result.warnings).toEqual(['2d usage was incomplete: the limit was not positive.']);
  });

  test('retains reset-only partial data and explains incomplete values', async () => {
    const result = await fetchKimiQuotaAdapter({
      credential: { apiKey: 'secret' },
      now,
      fetchImpl: async () => response({ usage: { resetAt: '2026-08-12T00:00:00Z' } }),
    });
    expect(result.usage.windows.weekly).toMatchObject({ usedPercent: null });
    expect(result.warnings?.[0]).toContain('incomplete');
  });
});

describe('ChatGPT shared quota adapter', () => {
  const run = async (usagePayload, resetPayload = null) => fetchCodexQuotaAdapter({
    credential: { accessToken: 'access', accountId: 'account' },
    now,
    fetchImpl: async (url, init) => {
      if (url === CODEX_USAGE_URL) {
        expect(init.headers['ChatGPT-Account-Id']).toBe('account');
        return response(usagePayload);
      }
      expect(url).toBe(CODEX_RESET_CREDITS_URL);
      return resetPayload ? response(resetPayload) : response({}, 404);
    },
  });

  test('preserves both windows and reset credits while adding reached spend control', async () => {
    const result = await run({
      rate_limit: {
        primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: 1_786_456_800 },
        secondary_window: { used_percent: 50, limit_window_seconds: 604_800, reset_at: 1_786_974_400 },
      },
      spend_control: { reached: true },
      credits: { balance: '12.34', available: true },
    }, {
      available_count: '2',
      total_earned_count: 3,
      credits: [{ id: 'credit', granted_at: '2026-08-01T00:00:00Z' }],
    });
    expect(result.usage.windows['5h'].usedPercent).toBe(25);
    expect(result.usage.windows.weekly.usedPercent).toBe(50);
    expect(result.usage.windows['extra-usage']).toMatchObject({
      usedPercent: null,
      valueLabel: 'Spend limit reached',
    });
    expect(result.usage.resetCredits).toMatchObject({ availableCount: 2, source: 'dedicated' });
  });

  test.each([
    [{ credits: { balance: '4.5', available: true } }, '$4.50 available'],
    [{ credits: { unlimited: true } }, 'Unlimited'],
    [{ credits: { available: false } }, 'Unavailable'],
    [{ credits: {} }, 'No credit balance reported'],
  ])('normalizes extra-usage state %#', async (payload, expected) => {
    const result = await run(payload);
    expect(result.usage.windows['extra-usage'].valueLabel).toBe(expected);
    expect(result.usage.windows['extra-usage'].usedPercent).toBeNull();
  });
});

describe('xAI shared quota adapter', () => {
  test('sends pinned headers without redirects and normalizes reported billing data', async () => {
    const result = await fetchXaiQuotaAdapter({
      credential: { accessToken: 'access' },
      now,
      fetchImpl: async (url, init) => {
        expect(url).toBe(XAI_BILLING_URL);
        expect(init).toMatchObject({
          method: 'GET',
          redirect: 'manual',
          headers: {
            Authorization: 'Bearer access',
            Accept: 'application/json',
            'x-xai-token-auth': 'xai-grok-cli',
            'x-grok-client-version': XAI_CLIENT_VERSION,
          },
        });
        return response({
          config: {
            creditUsagePercent: '37.5',
            currentPeriod: {
              type: 'USAGE_PERIOD_TYPE_WEEKLY',
              start: '2026-08-08T00:00:00Z',
              end: '2026-08-15T00:00:00Z',
            },
          },
          credits: { balance: '42' },
        });
      },
    });
    expect(result.usage.windows.weekly).toMatchObject({ usedPercent: 37.5, windowSeconds: 604_800 });
    expect(result.usage.windows.credits).toMatchObject({ usedPercent: null, valueLabel: '42 credits' });
  });

  test('refreshes once on 401 and retries with the new access token', async () => {
    const calls = [];
    const refreshes = [];
    const result = await fetchXaiQuotaAdapter({
      credential: { accessToken: 'old', refreshToken: 'refresh' },
      now,
      fetchImpl: async (_url, init) => {
        calls.push(init.headers.Authorization);
        return calls.length === 1
          ? response({}, 401)
          : response({ creditUsagePercent: 10, billingPeriodEnd: '2026-08-18T00:00:00Z' });
      },
      refreshAccessToken: async (credential) => {
        refreshes.push(credential);
        return { accessToken: 'new' };
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['Bearer old', 'Bearer new']);
    expect(refreshes).toEqual([{ accessToken: 'old', refreshToken: 'refresh' }]);
  });

  test.each([403, 429])('returns the HTTP status for %s', async (status) => {
    const result = await fetchXaiQuotaAdapter({
      credential: { accessToken: 'access' },
      now,
      fetchImpl: async () => response({}, status),
    });
    expect(result).toMatchObject({ ok: false, error: `API error: ${status}` });
  });

  test('requires reauthentication when 401 cannot be refreshed', async () => {
    const result = await fetchXaiQuotaAdapter({
      credential: { accessToken: 'access' },
      now,
      fetchImpl: async () => response({}, 401),
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'REAUTHENTICATION_REQUIRED' });
  });

  test('rejects redirects before following them', async () => {
    const result = await fetchXaiQuotaAdapter({
      credential: { accessToken: 'access' },
      now,
      fetchImpl: async () => response({}, 302, { location: 'https://example.com/steal' }),
    });
    expect(result).toMatchObject({ ok: false, error: 'xAI billing redirect to an untrusted host was rejected.' });
  });

  test('rejects a successful response reported from an untrusted final origin', async () => {
    const result = await fetchXaiQuotaAdapter({
      credential: { accessToken: 'access' },
      now,
      fetchImpl: async () => response({}, 200, {}, 'https://example.com/billing'),
    });
    expect(result).toMatchObject({
      ok: false,
      error: 'xAI billing response came from an untrusted host.',
    });
  });

  test('warns on unrecognized response drift without inventing a window', async () => {
    const result = await fetchXaiQuotaAdapter({
      credential: { accessToken: 'access' },
      now,
      fetchImpl: async () => response({ newProtocol: true }),
    });
    expect(result).toMatchObject({ ok: true, usage: { windows: {} } });
    expect(result.warnings?.[0]).toContain('did not include');
  });

  test('refresh helper uses the pinned public OAuth client and retains rotated credentials', async () => {
    const refreshed = await refreshXaiOAuthToken({
      refreshToken: 'old-refresh',
      now,
      fetchImpl: async (url, init) => {
        expect(url).toBe(XAI_OAUTH_TOKEN_URL);
        expect(init.redirect).toBe('manual');
        const body = new URLSearchParams(init.body);
        expect(body.get('client_id')).toBe(XAI_OAUTH_CLIENT_ID);
        expect(body.get('refresh_token')).toBe('old-refresh');
        return response({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: '3600' });
      },
    });
    expect(refreshed).toEqual({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: NOW + 3_600_000,
    });
  });
});

describe('DeepSeek shared quota adapter', () => {
  test('emits one value-only currency row and warning for an unavailable account', async () => {
    const result = await fetchDeepSeekQuotaAdapter({
      credential: { apiKey: 'secret' },
      now,
      fetchImpl: async (url) => {
        expect(url).toBe(DEEPSEEK_BALANCE_URL);
        return response({
          is_available: false,
          balance_infos: [
            { currency: 'usd', total_balance: '12.5', granted_balance: '10', topped_up_balance: '2.5' },
            { currency: 'CNY', total_balance: 20, granted_balance: 5, topped_up_balance: 15 },
            { currency: '', total_balance: 1 },
          ],
        });
      },
    });
    expect(result.usage.windows.USD).toMatchObject({
      usedPercent: null,
      resetAt: null,
      valueLabel: 'USD 12.50',
      description: 'Granted: USD 10.00 · Topped up: USD 2.50',
    });
    expect(result.usage.windows.CNY.valueLabel).toBe('CNY 20.00');
    expect(result.warnings).toHaveLength(2);
  });
});

test('numeric timestamp strings normalize as seconds while ISO strings remain supported', () => {
  expect(toQuotaTimestamp('1786456800')).toBe(1_786_456_800_000);
  expect(toQuotaTimestamp('2026-08-11T13:00:00Z')).toBe(Date.parse('2026-08-11T13:00:00Z'));
});
