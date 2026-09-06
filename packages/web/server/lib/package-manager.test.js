import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '/usr/local/bin', stderr: '' })),
  execFile: vi.fn((_command, _args, _options, callback) => callback(null, '/usr/local/bin', '')),
}));

const previousUpdateApiUrl = process.env.OPENCHAMBER_UPDATE_API_URL;
delete process.env.OPENCHAMBER_UPDATE_API_URL;
const { checkForUpdates } = await import('./package-manager.js');

function createFetchMock() {
  const handlers = new Map();

  const mock = vi.fn((url) => {
    const urlString = typeof url === 'string' ? url : url.toString();
    for (const [pattern, response] of handlers) {
      if (urlString.includes(pattern)) {
        return Promise.resolve(response);
      }
    }
    return Promise.reject(new Error(`Unexpected fetch call: ${urlString}`));
  });

  mock.when = (pattern, response) => {
    handlers.set(pattern, response);
    return mock;
  };

  return mock;
}

const githubRelease = (overrides = {}) => ({
  tag_name: 'v1.10.0',
  body: '## DevRyan 1.10.0\n\n- Great new feature',
  published_at: '2026-05-01T12:00:00Z',
  ...overrides,
});

describe('checkForUpdates', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = createFetchMock();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    if (previousUpdateApiUrl === undefined) {
      delete process.env.OPENCHAMBER_UPDATE_API_URL;
    } else {
      process.env.OPENCHAMBER_UPDATE_API_URL = previousUpdateApiUrl;
    }
  });

  it('uses the DevRyan GitHub release as the latest-version authority', async () => {
    fetchMock
      .when('api.github.com/repos/1H-Team/DevRyan/releases/latest', {
        ok: true,
        json: async () => githubRelease(),
      })
      .when('registry.npmjs.org', {
        ok: true,
        json: async () => ({ 'dist-tags': { latest: '1.10.0' } }),
      });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result).toMatchObject({
      available: true,
      version: '1.10.0',
      currentVersion: '1.9.10',
      body: '## DevRyan 1.10.0\n\n- Great new feature',
      date: '2026-05-01T12:00:00Z',
      nextSuggestedCheckInSec: 21_600,
    });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  });

  it('keeps web updates unavailable until the matching compatibility package is published', async () => {
    fetchMock
      .when('api.github.com/repos/1H-Team/DevRyan/releases/latest', {
        ok: true,
        json: async () => githubRelease(),
      })
      .when('registry.npmjs.org', {
        ok: true,
        json: async () => ({ 'dist-tags': { latest: '1.9.10' } }),
      });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
    expect(result.version).toBe('1.10.0');
  });

  it.each(['desktop-tauri', 'desktop-electron'])(
    'does not cross-check %s release availability against npm',
    async (appType) => {
      fetchMock.when('api.github.com/repos/1H-Team/DevRyan/releases/latest', {
        ok: true,
        json: async () => githubRelease(),
      });

      const result = await checkForUpdates({
        appType,
        currentVersion: '1.9.10',
      });

      expect(result.available).toBe(true);
      expect(result.version).toBe('1.10.0');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('reports the current DevRyan release without consulting npm', async () => {
    fetchMock.when('api.github.com/repos/1H-Team/DevRyan/releases/latest', {
      ok: true,
      json: async () => githubRelease({ tag_name: 'v1.9.10' }),
    });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
    expect(result.version).toBe('1.9.10');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to a newer OpenChamber npm version when GitHub is older', async () => {
    fetchMock.when('api.github.com/repos/1H-Team/DevRyan/releases/latest', {
      ok: true,
      json: async () => githubRelease({ tag_name: 'v1.9.9' }),
    });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
    expect(result.version).toBe('1.9.9');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the DevRyan GitHub release cannot be read', async () => {
    fetchMock.when(
      'api.github.com/repos/1H-Team/DevRyan/releases/latest',
      Promise.reject(new Error('Network error')),
    );

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result).toMatchObject({
      available: false,
      currentVersion: '1.9.10',
      error: 'Unable to check DevRyan releases',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed for invalid GitHub release metadata', async () => {
    fetchMock.when('api.github.com/repos/1H-Team/DevRyan/releases/latest', {
      ok: true,
      json: async () => ({ tag_name: null }),
    });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
    expect(result.error).toBe('Unable to check DevRyan releases');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
