import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readAuthFile } from '../../opencode/auth.js';
import { fetchQuota, isConfigured, resolveOpenCodeGoCredentials } from './opencode-go.js';

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: vi.fn(() => ({})),
}));
vi.mock('../credentials/providers.js', () => ({
  readManagedQuotaCredential: vi.fn(() => null),
}));

const ORIGINAL_ENV = { ...process.env };

const makeDashboardHtml = () => [
  'rollingUsage:$R[1]={usagePercent:3,resetInSec:17460}',
  'weeklyUsage:$R[2]={usagePercent:14,resetInSec:482400}',
  'monthlyUsage:$R[3]={usagePercent:83,resetInSec:1569600}',
].join('\n');

const makeDirectDashboardHtml = () => [
  '"rollingUsage":{"usagePercent":3,"resetInSec":17460}',
  'weeklyUsage:{usagePercent:14,resetInSec:482400}',
  'monthlyUsage:$R[3]={"usagePercent":83,"resetInSec":1569600}',
].join('\n');

describe('OpenCode Go quota provider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-07T12:00:00.000Z'));
    process.env = { ...ORIGINAL_ENV };
    delete process.env.OPENCODE_GO_WORKSPACE_ID;
    delete process.env.OPENCODE_GO_AUTH_COOKIE;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...ORIGINAL_ENV };
  });

  it('returns not configured when API auth and usage credentials are missing', async () => {
    readAuthFile.mockReturnValue({});
    const fetchImpl = vi.fn();

    expect(isConfigured()).toBe(false);

    const result = await fetchQuota({ fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      providerId: 'opencode-go',
      providerName: 'OpenCode Go',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  });

  it('returns a configured setup error when API auth exists but dashboard usage credentials are missing', async () => {
    readAuthFile.mockReturnValue({ 'opencode-go': { key: 'go-api-key' } });
    const fetchImpl = vi.fn();

    expect(isConfigured()).toBe(true);

    const result = await fetchQuota({ fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      providerId: 'opencode-go',
      providerName: 'OpenCode Go',
      ok: false,
      configured: true,
      error: 'OpenCode Go usage tracking requires OPENCODE_GO_WORKSPACE_ID and OPENCODE_GO_AUTH_COOKIE, or usageWorkspaceId and usageAuthCookie in auth["opencode-go"].',
    });
  });

  it('maps authenticated dashboard usage fields to quota windows', async () => {
    readAuthFile.mockReturnValue({
      'opencode-go': {
        usageWorkspaceId: 'wrk_abc123',
        usageAuthCookie: 'Fe26.2**secret-cookie',
      },
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => makeDashboardHtml(),
    }));

    const result = await fetchQuota({ fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith('https://opencode.ai/workspace/wrk_abc123/go', expect.objectContaining({
      headers: expect.objectContaining({
        Cookie: 'auth=Fe26.2**secret-cookie',
      }),
    }));
    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage.windows.rolling).toMatchObject({
      usedPercent: 3,
      windowSeconds: 5 * 60 * 60,
      resetAfterSeconds: 17460,
      description: '$12 of usage every 5 hours.',
    });
    expect(result.usage.windows.weekly).toMatchObject({
      usedPercent: 14,
      windowSeconds: 7 * 24 * 60 * 60,
      resetAfterSeconds: 482400,
      description: '$30 of usage per week.',
    });
    expect(result.usage.windows.monthly).toMatchObject({
      usedPercent: 83,
      windowSeconds: 30 * 24 * 60 * 60,
      resetAfterSeconds: 1569600,
      description: '$60 of usage per month.',
    });
    expect(JSON.stringify(result)).not.toContain('secret-cookie');
  });

  it('maps dashboard usage fields when the page renders direct serialized objects', async () => {
    readAuthFile.mockReturnValue({
      'opencode-go': {
        usageWorkspaceId: 'wrk_abc123',
        usageAuthCookie: 'Fe26.2**secret-cookie',
      },
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => makeDirectDashboardHtml(),
    }));

    const result = await fetchQuota({ fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.usage.windows.rolling).toMatchObject({
      usedPercent: 3,
      resetAfterSeconds: 17460,
    });
    expect(result.usage.windows.weekly).toMatchObject({
      usedPercent: 14,
      resetAfterSeconds: 482400,
    });
    expect(result.usage.windows.monthly).toMatchObject({
      usedPercent: 83,
      resetAfterSeconds: 1569600,
    });
  });

  it('returns an auth-cookie error for unauthorized dashboard responses', async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = 'wrk_env123';
    process.env.OPENCODE_GO_AUTH_COOKIE = 'Fe26.2**env-cookie';
    readAuthFile.mockReturnValue({});
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
    }));

    const result = await fetchQuota({ fetchImpl });

    expect(result).toMatchObject({
      providerId: 'opencode-go',
      providerName: 'OpenCode Go',
      ok: false,
      configured: true,
      error: 'OpenCode Go dashboard authentication failed. Update OPENCODE_GO_AUTH_COOKIE or auth["opencode-go"].usageAuthCookie.',
    });
    expect(JSON.stringify(result)).not.toContain('env-cookie');
  });

  it('rejects invalid workspace IDs before making a dashboard request', async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = 'workspace/with/slash';
    process.env.OPENCODE_GO_AUTH_COOKIE = 'Fe26.2**env-cookie';
    readAuthFile.mockReturnValue({});
    const fetchImpl = vi.fn();

    const result = await fetchQuota({ fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      providerId: 'opencode-go',
      providerName: 'OpenCode Go',
      ok: false,
      configured: true,
      error: 'Invalid OpenCode Go workspace ID format.',
    });
  });

  it('uses environment, managed, then legacy usage credentials without mixing sources', () => {
    const readAuth = () => ({
      'opencode-go': {
        usageWorkspaceId: 'wrk_legacy',
        usageAuthCookie: 'legacy-cookie',
      },
    });
    const readManagedCredential = () => ({
      workspaceId: 'wrk_managed',
      authCookie: 'managed-cookie',
    });

    expect(resolveOpenCodeGoCredentials({ readAuth, readManagedCredential, env: {} })).toMatchObject({
      workspaceId: 'wrk_managed',
      authCookie: 'managed-cookie',
      source: 'managed',
    });
    expect(resolveOpenCodeGoCredentials({
      readAuth,
      readManagedCredential,
      env: { OPENCODE_GO_WORKSPACE_ID: 'wrk_environment' },
    })).toMatchObject({
      workspaceId: 'wrk_environment',
      authCookie: '',
      usageConfigured: false,
      source: 'environment',
    });
    expect(resolveOpenCodeGoCredentials({ readAuth, readManagedCredential: () => null, env: {} })).toMatchObject({
      workspaceId: 'wrk_legacy',
      authCookie: 'legacy-cookie',
      source: 'legacy',
    });
  });
});
