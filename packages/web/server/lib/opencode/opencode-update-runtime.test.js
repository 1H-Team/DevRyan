import { describe, expect, it, vi } from 'vitest';
import {
  buildOpenCodeUpdateInfo,
  compareOpenCodeVersions,
  createOpenCodeUpdateRuntime,
  normalizeOpenCodeVersion,
} from './opencode-update-runtime.js';

describe('OpenCode version comparison', () => {
  it('normalizes v-prefixed stable and prerelease versions', () => {
    expect(normalizeOpenCodeVersion(' v1.18.10 ')).toBe('1.18.10');
    expect(normalizeOpenCodeVersion('1.19.0-beta.2+build.4')).toBe('1.19.0-beta.2');
    expect(normalizeOpenCodeVersion('latest')).toBeNull();
  });

  it('orders stable and prerelease versions deterministically', () => {
    expect(compareOpenCodeVersions('1.18.10', '1.18.9')).toBeGreaterThan(0);
    expect(compareOpenCodeVersions('1.18.10', '1.18.10')).toBe(0);
    expect(compareOpenCodeVersions('1.19.0-beta.2', '1.19.0-beta.10')).toBeLessThan(0);
    expect(compareOpenCodeVersions('1.19.0', '1.19.0-beta.10')).toBeGreaterThan(0);
    expect(compareOpenCodeVersions('invalid', '1.18.10')).toBeNull();
  });

  it('builds update and supported-version status independently', () => {
    expect(buildOpenCodeUpdateInfo({
      currentVersion: 'v1.18.10',
      latestVersion: 'v1.18.11',
      supportedVersion: '1.18.10',
    })).toEqual({
      currentVersion: '1.18.10',
      latestVersion: '1.18.11',
      supportedVersion: '1.18.10',
      updateAvailable: true,
      supportStatus: 'supported',
    });

    expect(buildOpenCodeUpdateInfo({
      currentVersion: '1.18.11',
      latestVersion: '1.18.10',
      supportedVersion: '1.18.10',
    })).toMatchObject({
      updateAvailable: false,
      supportStatus: 'newer',
    });

    expect(buildOpenCodeUpdateInfo({
      currentVersion: null,
      latestVersion: '1.18.10',
      supportedVersion: '1.18.10',
    })).toMatchObject({
      currentVersion: null,
      updateAvailable: null,
      supportStatus: 'unknown',
    });
  });
});

describe('OpenCode latest-release lookup', () => {
  it('uses the canonical stable release and caches successful checks for five minutes', async () => {
    let now = 1_000;
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ tag_name: 'v1.18.10' }),
    }));
    const createTimeoutSignal = vi.fn(() => ({ aborted: false }));
    const runtime = createOpenCodeUpdateRuntime({
      fetchImpl,
      now: () => now,
      createTimeoutSignal,
    });

    const first = await runtime.checkForUpdates({
      currentVersion: '1.18.9',
      supportedVersion: '1.18.10',
    });
    now += 299_999;
    const second = await runtime.checkForUpdates({
      currentVersion: '1.18.10',
      supportedVersion: '1.18.10',
    });

    expect(first.updateAvailable).toBe(true);
    expect(second.updateAvailable).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(createTimeoutSignal).toHaveBeenCalledWith(10_000);

    now += 2;
    await runtime.fetchLatestVersion();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not cache failed responses and returns safe errors', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ tag_name: 'not-semver' }) })
      .mockRejectedValueOnce(new Error('private network detail'));
    const runtime = createOpenCodeUpdateRuntime({
      fetchImpl,
      createTimeoutSignal: () => ({ aborted: false }),
    });

    await expect(runtime.fetchLatestVersion()).rejects.toThrow('OpenCode release check failed with 429');
    await expect(runtime.fetchLatestVersion()).rejects.toThrow('Unable to determine the latest OpenCode version');
    await expect(runtime.fetchLatestVersion()).rejects.toThrow('Unable to check the latest OpenCode version');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
