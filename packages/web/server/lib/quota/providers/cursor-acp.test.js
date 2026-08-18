import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readAuthFile } from '../../opencode/auth.js';
import { fetchQuotaForProvider } from './index.js';
import { fetchCursorAcpQuota, resolveCursorQuotaCredential } from './cursor-acp.js';

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: vi.fn(() => ({})),
}));
vi.mock('../credentials/providers.js', () => ({
  readManagedQuotaCredential: vi.fn(() => null),
  writeManagedQuotaCredential: vi.fn(),
}));

const ORIGINAL_ENV = { ...process.env };
const CURSOR_CREDENTIAL_ENV_KEYS = [
  'CURSOR_TOKEN',
  'CURSOR_ACCESS_TOKEN',
  'CURSOR_REFRESH_TOKEN',
  'CURSOR_TOKEN_FILE',
  'CURSOR_REFRESH_TOKEN_FILE',
];

const makeUsageSummary = () => ({
  billingCycleStart: '2026-04-02T14:11:55.000Z',
  billingCycleEnd: '2026-05-02T14:11:55.000Z',
  individualUsage: {
    plan: {
      autoPercentUsed: 82,
      apiPercentUsed: 100,
      totalPercentUsed: 86,
    },
  },
});

describe('Cursor ACP quota provider', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    for (const key of CURSOR_CREDENTIAL_ENV_KEYS) delete process.env[key];
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('returns not configured when the Cursor usage session token is missing', async () => {
    readAuthFile.mockReturnValue({ 'cursor-acp': { access: 'chat-auth-token' } });
    const fetchImpl = vi.fn();

    const result = await fetchQuotaForProvider('cursor-acp', { fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      providerId: 'cursor-acp',
      providerName: 'Cursor',
      ok: false,
      configured: false,
      error: 'Cursor usage tracking is not configured.',
    });
  });

  it('maps Cursor dashboard usage buckets to quota windows', async () => {
    readAuthFile.mockReturnValue({ 'cursor-acp': { usageSessionToken: 'secret-token' } });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => makeUsageSummary(),
    }));

    const result = await fetchQuotaForProvider('cursor-acp', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith('https://cursor.com/api/dashboard/get-current-period-usage', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Origin: 'https://cursor.com',
        Referer: 'https://cursor.com/dashboard?tab=spending',
        Cookie: 'WorkosCursorSessionToken=secret-token',
      }),
      body: '{}',
    }));
    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage.windows.total).toBeUndefined();
    expect(result.usage.windows['auto-composer'].usedPercent).toBe(82);
    expect(result.usage.windows['auto-composer'].resetAt).toBe(Date.parse('2026-05-02T14:11:55.000Z'));
    expect(result.usage.windows['auto-composer'].windowSeconds).toBe(30 * 24 * 60 * 60);
    expect(result.usage.windows['auto-composer'].description).toBeUndefined();
    expect(result.usage.windows.api.usedPercent).toBe(100);
    expect(result.usage.windows.api.description).toBeUndefined();
  });

  it('maps Cursor current-period dashboard response buckets to quota windows', async () => {
    readAuthFile.mockReturnValue({ 'cursor-acp': { usageSessionToken: 'secret-token' } });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        planUsage: {
          autoPercentUsed: 82,
          apiPercentUsed: 100,
          limit: 7000,
        },
      }),
    }));

    const result = await fetchQuotaForProvider('cursor-acp', { fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage.windows.total).toBeUndefined();
    expect(result.usage.windows['auto-composer'].usedPercent).toBe(82);
    expect(result.usage.windows.api.usedPercent).toBe(100);
  });

  it('returns a Cursor-specific expired-session error without exposing the token', async () => {
    readAuthFile.mockReturnValue({ 'cursor-acp': { usageSessionToken: 'secret-token' } });
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401 }));

    const result = await fetchQuotaForProvider('cursor-acp', { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('Cursor session expired. Update the Cursor usage session token.');
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('retries decoded Cursor session tokens with a cookie-encoded separator', async () => {
    readAuthFile.mockReturnValue({ 'cursor-acp': { usageSessionToken: 'user_123::jwt-token' } });
    const fetchImpl = vi.fn(async (_url, init) => {
      if (init.headers.Cookie === 'WorkosCursorSessionToken=user_123%3A%3Ajwt-token') {
        return {
          ok: true,
          status: 200,
          json: async () => makeUsageSummary(),
        };
      }
      return { ok: false, status: 401 };
    });

    const result = await fetchQuotaForProvider('cursor-acp', { fetchImpl });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://cursor.com/api/dashboard/get-current-period-usage', expect.objectContaining({
      headers: expect.objectContaining({
        Cookie: 'WorkosCursorSessionToken=user_123::jwt-token',
      }),
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://cursor.com/api/dashboard/get-current-period-usage', expect.objectContaining({
      headers: expect.objectContaining({
        Cookie: 'WorkosCursorSessionToken=user_123%3A%3Ajwt-token',
      }),
    }));
  });

  it('retries encoded Cursor session tokens with a decoded separator', async () => {
    readAuthFile.mockReturnValue({ 'cursor-acp': { usageSessionToken: 'user_123%3A%3Ajwt-token' } });
    const fetchImpl = vi.fn(async (_url, init) => {
      if (init.headers.Cookie === 'WorkosCursorSessionToken=user_123::jwt-token') {
        return {
          ok: true,
          status: 200,
          json: async () => makeUsageSummary(),
        };
      }
      return { ok: false, status: 401 };
    });

    const result = await fetchQuotaForProvider('cursor-acp', { fetchImpl });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://cursor.com/api/dashboard/get-current-period-usage', expect.objectContaining({
      headers: expect.objectContaining({
        Cookie: 'WorkosCursorSessionToken=user_123%3A%3Ajwt-token',
      }),
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://cursor.com/api/dashboard/get-current-period-usage', expect.objectContaining({
      headers: expect.objectContaining({
        Cookie: 'WorkosCursorSessionToken=user_123::jwt-token',
      }),
    }));
  });

  it('returns a deterministic error when the Cursor summary payload is missing usage buckets', async () => {
    readAuthFile.mockReturnValue({ 'cursor-acp': { usageSessionToken: 'secret-token' } });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ billingCycleEnd: '2026-05-02T14:11:55.000Z' }),
    }));

    const result = await fetchQuotaForProvider('cursor-acp', { fetchImpl });

    expect(result).toMatchObject({
      providerId: 'cursor-acp',
      providerName: 'Cursor',
      ok: false,
      configured: true,
      error: 'Cursor usage response did not include plan usage buckets.',
    });
  });

  it('resolves OAuth environment and token files before managed and legacy dashboard credentials', () => {
    const common = {
      readAuth: () => ({ 'cursor-acp': { usageSessionToken: 'legacy' } }),
      readManagedCredential: () => ({ sessionToken: 'managed' }),
    };
    expect(resolveCursorQuotaCredential({
      ...common,
      env: { CURSOR_ACCESS_TOKEN: 'environment' },
      readTokenFile: () => 'file',
    })).toMatchObject({ kind: 'oauth', source: 'environment', credential: { accessToken: 'environment' } });
    expect(resolveCursorQuotaCredential({
      ...common,
      env: { CURSOR_TOKEN_FILE: '/token' },
      readTokenFile: () => 'file',
    })).toMatchObject({ kind: 'oauth', source: 'token-file', credential: { accessToken: 'file' } });
    expect(resolveCursorQuotaCredential({ ...common, env: {}, readTokenFile: () => '' })).toMatchObject({
      kind: 'dashboard',
      source: 'managed',
      credential: { sessionToken: 'managed' },
    });
  });

  it('persists refreshed OAuth access tokens only for managed credentials', async () => {
    const expiredToken = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.signature`;
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/oauth/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'refreshed' }) };
      }
      return { ok: true, status: 200, json: async () => makeUsageSummary() };
    });
    const writeManagedCredential = vi.fn();

    const managedResult = await fetchCursorAcpQuota({
      env: {},
      readAuth: () => ({}),
      readManagedCredential: () => ({ accessToken: expiredToken, refreshToken: 'refresh' }),
      writeManagedCredential,
      fetchImpl,
    });
    expect(managedResult.ok).toBe(true);
    expect(writeManagedCredential).toHaveBeenCalledWith('cursor-acp', {
      accessToken: 'refreshed',
      refreshToken: 'refresh',
    });

    writeManagedCredential.mockClear();
    const environmentResult = await fetchCursorAcpQuota({
      env: { CURSOR_ACCESS_TOKEN: expiredToken, CURSOR_REFRESH_TOKEN: 'refresh' },
      readAuth: () => ({}),
      readManagedCredential: () => null,
      writeManagedCredential,
      fetchImpl,
    });
    expect(environmentResult.ok).toBe(true);
    expect(writeManagedCredential).not.toHaveBeenCalled();
  });
});
