import { describe, expect, test } from 'bun:test';

import {
  CODEX_RESET_CREDITS_URL,
  CODEX_USAGE_URL,
  DEEPSEEK_BALANCE_URL,
  OPENCODE_GO_USAGE_URL,
  OPENCODE_CONSOLE_BASE_URL,
  OPENCODE_CONSOLE_CLIENT_ID,
  OPENCODE_ZEN_MAX_RESPONSE_BYTES,
  KIMI_QUOTA_URL,
  XAI_BILLING_URL,
  XAI_CLIENT_VERSION,
  XAI_RESET_BANK_URL,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_TOKEN_URL,
  ZAI_QUOTA_URL,
  fetchCodexQuotaAdapter,
  fetchDeepSeekQuotaAdapter,
  fetchKimiQuotaAdapter,
  fetchOpenCodeGoQuotaAdapter,
  exchangeOpenCodeConsoleDeviceCode,
  fetchOpenCodeZenQuotaAdapter,
  fetchXaiQuotaAdapter,
  fetchZaiQuotaAdapter,
  refreshOpenCodeConsoleToken,
  refreshXaiOAuthToken,
  startOpenCodeConsoleDeviceAuthorization,
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
  text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload),
  arrayBuffer: async () => {
    const bytes = payload instanceof Uint8Array
      ? payload
      : new TextEncoder().encode(typeof payload === 'string' ? payload : JSON.stringify(payload));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  },
});

const protoVarint = (value) => {
  const bytes = [];
  let remaining = value;
  do {
    const next = remaining % 128;
    remaining = Math.floor(remaining / 128);
    bytes.push(remaining > 0 ? next | 0x80 : next);
  } while (remaining > 0);
  return bytes;
};

const protoLengthField = (fieldNumber, value) => [
  ...protoVarint(fieldNumber * 8 + 2),
  ...protoVarint(value.length),
  ...value,
];

const resetToken = (tokenId, expiresAt) => {
  const timestamp = [
    ...protoVarint(8),
    ...protoVarint(Math.floor(expiresAt / 1000)),
  ];
  return [
    ...protoLengthField(10, [...new TextEncoder().encode(tokenId)]),
    ...protoLengthField(30, timestamp),
  ];
};

const resetBankResponse = (tokens) => {
  const payload = tokens.flatMap((token) => protoLengthField(10, token));
  return new Uint8Array([0, ...[0, 0, 0, payload.length], ...payload]);
};

const ZEN_ORG_ID = 'wrk_01K46JDFR0E75SG2Q8K172KF3Y';
const zenCredential = { orgId: ZEN_ORG_ID, accessToken: 'sess_access-token' };
const JSON_HEADERS = { 'content-type': 'application/json' };
const zenJson = (payload, status = 200) => response(payload, status, JSON_HEADERS);
const zenBillingStatus = (overrides = {}) => ({
  billingMode: 'prepaid',
  mode: 'pay-as-you-go',
  balanceMicroCents: '1999960750',
  creditLimitMicroCents: null,
  availableMicroCents: '1999960750',
  canPurchaseCredits: true,
  canEnableAutoRecharge: true,
  canEnrollInPrepaid: false,
  ...overrides,
});
const zenUsageSummary = (overrides = {}) => ({
  totalRequests: 12,
  totalInputTokens: 1000,
  totalOutputTokens: 500,
  totalCacheReadTokens: 0,
  totalCacheWrite5mTokens: 0,
  totalCacheWrite1hTokens: 0,
  totalCostMicroCents: '625000000',
  services: [],
  ...overrides,
});
const zenFetch = ({ status = zenJson(zenBillingStatus()), usage = zenJson(zenUsageSummary()) } = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith(`${OPENCODE_CONSOLE_BASE_URL}/api/billing/status`)) return typeof status === 'function' ? status() : status;
    if (url.startsWith(`${OPENCODE_CONSOLE_BASE_URL}/api/usage/summary`)) return typeof usage === 'function' ? usage() : usage;
    throw new Error(`unexpected ${url}`);
  };
  return { calls, fetchImpl };
};

describe('OpenCode Zen shared quota adapter', () => {
  test('reads console billing status and current-UTC-month spend with bearer and workspace scope', async () => {
    const { calls, fetchImpl } = zenFetch();
    const result = await fetchOpenCodeZenQuotaAdapter({ credential: zenCredential, fetchImpl, now });

    expect(calls.map(({ url }) => url).sort()).toEqual([
      `${OPENCODE_CONSOLE_BASE_URL}/api/billing/status`,
      `${OPENCODE_CONSOLE_BASE_URL}/api/usage/summary?since=${encodeURIComponent('2026-08-01T00:00:00.000Z')}`,
    ]);
    for (const { init } of calls) {
      expect(init).toMatchObject({
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer sess_access-token',
          'x-org-id': ZEN_ORG_ID,
        },
      });
      expect(init.headers.Cookie).toBeUndefined();
    }
    expect(result).toMatchObject({ providerId: 'opencode', providerName: 'OpenCode Zen', ok: true, configured: true });
    expect(result.usage.windows.credits).toMatchObject({
      valueLabel: '$6.25 used / $20.00 available',
      windowSeconds: null,
      resetAt: null,
    });
    expect(result.usage.windows.credits.usedPercent).toBeCloseTo(23.81, 2);
  });

  test('accepts numeric micro-cents and handles empty and overdrawn credit pools', async () => {
    const empty = await fetchOpenCodeZenQuotaAdapter({
      credential: zenCredential,
      now,
      fetchImpl: zenFetch({
        status: zenJson(zenBillingStatus({ balanceMicroCents: 0, availableMicroCents: 0 })),
        usage: zenJson(zenUsageSummary({ totalCostMicroCents: 0 })),
      }).fetchImpl,
    });
    expect(empty.usage.windows.credits).toMatchObject({ usedPercent: 0, valueLabel: '$0.00 used / $0.00 available' });

    const overdrawn = await fetchOpenCodeZenQuotaAdapter({
      credential: zenCredential,
      now,
      fetchImpl: zenFetch({
        status: zenJson(zenBillingStatus({ balanceMicroCents: '-100000000', availableMicroCents: '-100000000' })),
        usage: zenJson(zenUsageSummary({ totalCostMicroCents: '300000000' })),
      }).fetchImpl,
    });
    expect(overdrawn.usage.windows.credits).toMatchObject({ usedPercent: 100, valueLabel: '$3.00 used / -$1.00 available' });
  });

  test('rejects invalid credentials without any request', async () => {
    let requests = 0;
    const fetchImpl = async () => { requests += 1; return zenJson({}); };
    for (const credential of [
      null,
      { orgId: 'bad', accessToken: 'token' },
      { orgId: ZEN_ORG_ID, accessToken: 'has space' },
      { orgId: ZEN_ORG_ID, accessToken: 'line\nbreak' },
      { workspaceId: ZEN_ORG_ID, authCookie: 'legacy-cookie' },
    ]) {
      expect(await fetchOpenCodeZenQuotaAdapter({ credential, fetchImpl, now }))
        .toMatchObject({ ok: false, configured: false, errorCode: 'NOT_CONFIGURED' });
    }
    expect(requests).toBe(0);
  });

  test('classifies expired tokens, workspace denials, redirects, and upstream failures', async () => {
    const cases = [
      [{ status: zenJson({ _tag: 'Unauthorized' }, 401) }, 'AUTHENTICATION_FAILED'],
      [{ usage: zenJson({ _tag: 'Unauthorized' }, 401), status: zenJson({ _tag: 'Forbidden' }, 403) }, 'AUTHENTICATION_FAILED'],
      [{ status: zenJson({ _tag: 'Forbidden' }, 403) }, 'WORKSPACE_INACCESSIBLE'],
      [{ status: zenJson({ _tag: 'OrgRequired' }, 400) }, 'WORKSPACE_INACCESSIBLE'],
      [{ usage: zenJson({ _tag: 'NotFound' }, 404) }, 'WORKSPACE_INACCESSIBLE'],
      [{ status: response('', 302, { location: 'https://opencode.ai/console/login' }) }, 'API_ERROR'],
      [{ status: zenJson({}, 500) }, 'API_ERROR'],
    ];
    for (const [responses, errorCode] of cases) {
      const result = await fetchOpenCodeZenQuotaAdapter({ credential: zenCredential, now, fetchImpl: zenFetch(responses).fetchImpl });
      expect(result).toMatchObject({ ok: false, configured: true, errorCode });
      expect(result.error).not.toContain('Unauthorized');
    }
  });

  test('distinguishes timeout from network failures without echoing thrown messages', async () => {
    const timeout = await fetchOpenCodeZenQuotaAdapter({
      credential: zenCredential,
      now,
      fetchImpl: async () => { throw Object.assign(new Error('secret timeout detail'), { name: 'TimeoutError' }); },
    });
    expect(timeout).toMatchObject({ errorCode: 'TIMEOUT', error: 'OpenCode Console billing request timed out. Try again.' });
    const network = await fetchOpenCodeZenQuotaAdapter({
      credential: zenCredential,
      now,
      fetchImpl: async () => { throw new Error('secret network detail'); },
    });
    expect(network).toMatchObject({ errorCode: 'API_ERROR', error: 'OpenCode Console billing request failed.' });
  });

  test('fails closed for non-JSON, malformed, and oversized payloads', async () => {
    const cases = [
      { status: response('<!doctype html>', 200, { 'content-type': 'text/html' }) },
      { status: zenJson('not json{') },
      { status: zenJson(zenBillingStatus({ balanceMicroCents: '12.5' })) },
      { status: zenJson(zenBillingStatus({ availableMicroCents: undefined })) },
      { usage: zenJson(zenUsageSummary({ totalCostMicroCents: '-1' })) },
      { usage: zenJson(zenUsageSummary({ totalCostMicroCents: 'NaN' })) },
      { status: response(zenBillingStatus(), 200, { ...JSON_HEADERS, 'content-length': String(OPENCODE_ZEN_MAX_RESPONSE_BYTES + 1) }) },
    ];
    for (const responses of cases) {
      expect(await fetchOpenCodeZenQuotaAdapter({ credential: zenCredential, now, fetchImpl: zenFetch(responses).fetchImpl }))
        .toMatchObject({ ok: false, configured: true, errorCode: 'PARSE_ERROR' });
    }
  });
});

describe('OpenCode Console device authorization', () => {
  const authFetch = (payload, status = 200) => {
    const calls = [];
    return {
      calls,
      fetchImpl: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body), init });
        return zenJson(typeof payload === 'function' ? payload(calls.length) : payload, status);
      },
    };
  };

  test('starts device authorization as DevRyan and resolves console-relative verification links', async () => {
    const { calls, fetchImpl } = authFetch({
      device_code: 'device-secret',
      user_code: 'PPSQ-ZZSW',
      verification_uri: '/console/device',
      verification_uri_complete: '/console/device?user_code=PPSQ-ZZSW&client_id=devryan',
      expires_in: 900,
      interval: 5,
    });
    const flow = await startOpenCodeConsoleDeviceAuthorization({ fetchImpl });
    expect(calls[0]).toMatchObject({
      url: `${OPENCODE_CONSOLE_BASE_URL}/auth/device/code`,
      body: { client_id: OPENCODE_CONSOLE_CLIENT_ID, supports_org_scope: true },
      init: { method: 'POST', redirect: 'manual' },
    });
    expect(flow).toEqual({
      deviceCode: 'device-secret',
      userCode: 'PPSQ-ZZSW',
      verificationUri: 'https://opencode.ai/console/device',
      verificationUriComplete: 'https://opencode.ai/console/device?user_code=PPSQ-ZZSW&client_id=devryan',
      expiresIn: 900,
      interval: 5,
    });
  });

  test('refuses verification links outside the console origin and failed starts', async () => {
    await expect(startOpenCodeConsoleDeviceAuthorization({
      fetchImpl: authFetch({ device_code: 'd', user_code: 'U', verification_uri: 'https://evil.example/device' }).fetchImpl,
    })).rejects.toMatchObject({ name: 'OpenCodeConsoleAuthError', code: 'API_ERROR' });
    await expect(startOpenCodeConsoleDeviceAuthorization({
      fetchImpl: authFetch({ _tag: 'DeviceAuthFailed', message: 'Device authorization failed' }, 400).fetchImpl,
    })).rejects.toMatchObject({ code: 'API_ERROR' });
  });

  test('maps RFC 8628 token states and validates approved tokens', async () => {
    const states = [
      ['authorization_pending', 'pending'],
      ['slow_down', 'slow_down'],
      ['access_denied', 'denied'],
      ['expired_token', 'expired'],
      ['invalid_grant', 'invalid'],
    ];
    for (const [error, status] of states) {
      const result = await exchangeOpenCodeConsoleDeviceCode({
        deviceCode: 'device-secret',
        fetchImpl: authFetch({ _tag: 'DeviceTokenError', error, error_description: 'x' }, 400).fetchImpl,
      });
      expect(result).toEqual({ status });
    }

    const { calls, fetchImpl } = authFetch({
      access_token: 'sess_access',
      refresh_token: 'rt_refresh',
      token_type: 'Bearer',
      expires_in: 3600,
      org_id: ZEN_ORG_ID,
    });
    expect(await exchangeOpenCodeConsoleDeviceCode({ deviceCode: 'device-secret', fetchImpl })).toEqual({
      status: 'approved',
      token: { accessToken: 'sess_access', refreshToken: 'rt_refresh', expiresIn: 3600, orgId: ZEN_ORG_ID },
    });
    expect(calls[0]).toMatchObject({
      url: `${OPENCODE_CONSOLE_BASE_URL}/auth/device/token`,
      body: {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: 'device-secret',
        client_id: OPENCODE_CONSOLE_CLIENT_ID,
      },
    });

    await expect(exchangeOpenCodeConsoleDeviceCode({
      deviceCode: 'device-secret',
      fetchImpl: authFetch({ access_token: 'has space', refresh_token: 'rt', expires_in: 60 }).fetchImpl,
    })).rejects.toMatchObject({ code: 'PARSE_ERROR' });
  });

  test('refreshes with the refresh-token grant and reports upstream outages as errors', async () => {
    const { calls, fetchImpl } = authFetch({ access_token: 'sess_next', refresh_token: 'rt_next', expires_in: 3600 });
    expect(await refreshOpenCodeConsoleToken({ refreshToken: 'rt_old', fetchImpl })).toEqual({
      status: 'approved',
      token: { accessToken: 'sess_next', refreshToken: 'rt_next', expiresIn: 3600, orgId: null },
    });
    expect(calls[0].body).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt_old', client_id: OPENCODE_CONSOLE_CLIENT_ID });

    await expect(refreshOpenCodeConsoleToken({ refreshToken: 'rt_old', fetchImpl: authFetch({}, 503).fetchImpl }))
      .rejects.toMatchObject({ code: 'API_ERROR' });
    await expect(refreshOpenCodeConsoleToken({
      refreshToken: 'rt_old',
      fetchImpl: async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); },
    })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(await refreshOpenCodeConsoleToken({ refreshToken: '' })).toEqual({ status: 'invalid' });
  });
});

describe('OpenCode Go shared quota adapter', () => {
  test('uses the JSON API and maps valid windows with clamped percentages', async () => {
    const result = await fetchOpenCodeGoQuotaAdapter({
      credential: { apiKey: 'go-secret' },
      now,
      fetchImpl: async (url, init) => {
        expect(url).toBe(OPENCODE_GO_USAGE_URL);
        expect(init).toMatchObject({
          method: 'GET',
          redirect: 'manual',
          headers: { Accept: 'application/json', Authorization: 'Bearer go-secret' },
        });
        expect(init.headers.Cookie).toBeUndefined();
        expect(init.signal).toBeDefined();
        return response({
          usage: {
            rolling: { percent: 120, resetsAt: '2026-08-11T17:00:00Z' },
            weekly: { percent: -4, resetsAt: '2026-08-18T12:00:00Z' },
            monthly: { percent: 42.5, resetsAt: '2026-09-11T12:00:00+00:00' },
          },
        });
      },
    });
    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h']).toMatchObject({ usedPercent: 100, windowSeconds: 18_000 });
    expect(result.usage.windows.weekly).toMatchObject({ usedPercent: 0, windowSeconds: 604_800 });
    expect(result.usage.windows.monthly).toMatchObject({ usedPercent: 42.5, windowSeconds: 2_592_000 });
  });

  test('skips malformed windows and fails parsing when none are usable', async () => {
    const partial = await fetchOpenCodeGoQuotaAdapter({
      credential: { apiKey: 'safe' },
      now,
      fetchImpl: async () => response({ usage: {
        rolling: { percent: 25, resetsAt: '2026-08-11T17:00:00Z' },
        weekly: { percent: '50', resetsAt: '2026-08-18T12:00:00Z' },
        monthly: { percent: 50, resetsAt: 'not-iso' },
      } }),
    });
    expect(partial.ok).toBe(true);
    expect(Object.keys(partial.usage.windows)).toEqual(['5h']);
    expect(partial.warnings).toHaveLength(2);

    const invalid = await fetchOpenCodeGoQuotaAdapter({
      credential: { apiKey: 'safe' },
      now,
      fetchImpl: async () => ({
        ...response(null),
        json: async () => { throw new Error('raw body'); },
      }),
    });
    expect(invalid).toMatchObject({ ok: false, errorCode: 'PARSE_ERROR' });
    expect(JSON.stringify(invalid)).not.toContain('raw body');
  });

  test('returns sanitized configuration, authentication, redirect, and API errors', async () => {
    expect(await fetchOpenCodeGoQuotaAdapter({ credential: { apiKey: 'line\nbreak' }, now }))
      .toMatchObject({ configured: false, errorCode: 'NOT_CONFIGURED' });
    for (const [status, errorCode] of [[401, 'AUTHENTICATION_FAILED'], [403, 'AUTHENTICATION_FAILED'], [302, 'API_ERROR'], [503, 'API_ERROR']]) {
      const result = await fetchOpenCodeGoQuotaAdapter({
        credential: { apiKey: 'never-echo-me' },
        now,
        fetchImpl: async () => response({}, status),
      });
      expect(result).toMatchObject({ ok: false, errorCode });
      expect(JSON.stringify(result)).not.toContain('never-echo-me');
    }
  });
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
        if (url === XAI_RESET_BANK_URL) return response(new Uint8Array(), 200, {}, url);
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

  test('treats an omitted percentage in a valid weekly period as zero usage', async () => {
    const resetAt = Date.parse('2026-08-18T00:00:00Z');
    const result = await fetchXaiQuotaAdapter({
      credential: { accessToken: 'access' },
      now,
      fetchImpl: async (url) => url === XAI_RESET_BANK_URL
        ? response(new Uint8Array(), 200, {}, url)
        : response({
          config: {
            currentPeriod: {
              type: 'USAGE_PERIOD_TYPE_WEEKLY',
              start: '2026-08-11T00:00:00Z',
              end: '2026-08-18T00:00:00Z',
            },
          },
        }),
    });

    expect(result.usage.windows.weekly).toMatchObject({
      usedPercent: 0,
      remainingPercent: 100,
      windowSeconds: 604_800,
      resetAt,
    });
    expect(result.warnings).toBeUndefined();
  });

  test('warns when a present xAI usage percentage is malformed', async () => {
    const result = await fetchXaiQuotaAdapter({
      credential: { accessToken: 'access' },
      now,
      fetchImpl: async (url) => url === XAI_RESET_BANK_URL
        ? response(new Uint8Array(), 200, {}, url)
        : response({
          config: {
            creditUsagePercent: 'invalid',
            currentPeriod: {
              type: 'USAGE_PERIOD_TYPE_WEEKLY',
              start: '2026-08-11T00:00:00Z',
              end: '2026-08-18T00:00:00Z',
            },
          },
        }),
    });

    expect(result.usage.windows.weekly).toMatchObject({ usedPercent: null });
    expect(result.warnings).toContain('weekly billing did not include a usage percentage.');
  });

  test('normalizes valid reset tokens without exposing provider token IDs', async () => {
    const soon = Date.parse('2026-08-20T00:00:00Z');
    const later = Date.parse('2026-09-12T00:00:00Z');
    const expired = Date.parse('2026-08-01T00:00:00Z');
    const result = await fetchXaiQuotaAdapter({
      credential: { accessToken: 'access' },
      now,
      fetchImpl: async (url) => url === XAI_RESET_BANK_URL
        ? response(resetBankResponse([
          resetToken('later-secret-token', later),
          resetToken('soon-secret-token', soon),
          resetToken('soon-secret-token', soon),
          resetToken('expired-secret-token', expired),
          [0x08, 0x01],
        ]), 200, {}, url)
        : response({ creditUsagePercent: 10, billingPeriodEnd: '2026-08-18T00:00:00Z' }),
    });

    expect(result.usage.resetCredits).toMatchObject({
      availableCount: 2,
      totalEarnedCount: null,
      source: 'dedicated',
      credits: [
        { status: 'available', resetType: null, expiresAt: soon },
        { status: 'available', resetType: null, expiresAt: later },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  test('hides an empty reset bank without adding a warning', async () => {
    const result = await fetchXaiQuotaAdapter({
      credential: { accessToken: 'access' },
      now,
      fetchImpl: async (url) => url === XAI_RESET_BANK_URL
        ? response(new Uint8Array(), 200, {}, url)
        : response({ creditUsagePercent: 10, billingPeriodEnd: '2026-08-18T00:00:00Z' }),
    });
    expect(result.usage.resetCredits).toBeUndefined();
    expect(result.warnings).toBeUndefined();
  });

  test.each([
    ['HTTP rejection', response({}, 403)],
    ['redirect', response({}, 302, { location: 'https://example.com/steal' })],
    ['malformed payload', response(new Uint8Array([0, 0, 0, 0, 10, 1]))],
    ['oversized payload', response(new Uint8Array(), 200, { 'content-length': '65537' })],
  ])('keeps billing usage when the reset bank has an %s', async (_label, resetResponse) => {
    const result = await fetchXaiQuotaAdapter({
      credential: { accessToken: 'access' },
      now,
      fetchImpl: async (url) => url === XAI_RESET_BANK_URL
        ? resetResponse
        : response({ creditUsagePercent: 10, billingPeriodEnd: '2026-08-18T00:00:00Z' }),
    });
    expect(result).toMatchObject({ ok: true, usage: { windows: { usage: { usedPercent: 10 } } } });
    expect(result.usage.resetCredits).toBeUndefined();
    expect(result.warnings).toContain('The xAI reset bank could not be refreshed.');
  });

  test('refreshes once on 401 and retries with the new access token', async () => {
    const calls = [];
    const refreshes = [];
    const result = await fetchXaiQuotaAdapter({
      credential: { accessToken: 'old', refreshToken: 'refresh' },
      now,
      fetchImpl: async (url, init) => {
        if (url === XAI_RESET_BANK_URL) {
          expect(init.headers.Authorization).toBe('Bearer new');
          return response(new Uint8Array(), 200, {}, url);
        }
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
