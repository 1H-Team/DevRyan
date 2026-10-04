import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServerUtilsRuntime } from './server-utils-runtime.js';
import { createSettingsNormalizationRuntime } from './settings-normalization-runtime.js';

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

const createRuntime = (loginShellPath, options = {}) => createServerUtilsRuntime({
  fs: {},
  os,
  path,
  process,
  openCodeReadyGraceMs: 0,
  longRequestTimeoutMs: 0,
  getRuntime: () => ({}),
  getOpenCodeAuthHeaders: () => ({}),
  buildOpenCodeUrl: (route) => route,
  ensureOpenCodeApiPrefix: () => {},
  getUiNotificationClients: () => new Set(),
  getOpenCodePort: () => null,
  setOpenCodePortState: () => {},
  syncToHmrState: () => {},
  markOpenCodeNotReady: () => {},
  setOpenCodeNotReadySince: () => {},
  clearLastOpenCodeError: () => {},
  getLoginShellPath: () => loginShellPath,
  ...options,
});

describe('server utils runtime', () => {
  it('uses the selected runtime home for settings and helper paths without changing process HOME', () => {
    const originalHome = process.env.HOME;
    const homeDirectory = path.resolve('.cache/selected-runtime-home');
    process.env.PATH = '/usr/bin';
    const runtime = createRuntime('/bin', { homeDirectory });
    const settings = createSettingsNormalizationRuntime({ os, path, processLike: process, homeDirectory });
    expect(settings.normalizeDirectoryPath('~')).toBe(homeDirectory);
    expect(settings.normalizeDirectoryPath('~/project')).toBe(path.join(homeDirectory, 'project'));
    expect(runtime.buildManagedOpenCodePath().split(path.delimiter)).toContain(path.join(homeDirectory, '.local', 'bin'));
    expect(runtime.buildAugmentedPath().split(path.delimiter)).toContain(path.join(homeDirectory, '.local', 'bin'));
    expect(process.env.HOME).toBe(originalHome);
  });

  it('prefers shell PATH for managed OpenCode before appending process-only entries', () => {
    const home = os.homedir();
    const currentPath = [
      path.join(home, '.opencode', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, 'Library', 'pnpm'),
      '/opt/homebrew/bin',
      '/usr/bin',
    ].join(path.delimiter);
    process.env.PATH = currentPath;

    const runtime = createRuntime([
      path.join(home, '.opencode', 'bin'),
      path.join(home, '.bun', 'bin'),
      '/opt/homebrew/bin',
      '/usr/bin',
      path.join(home, '.cargo', 'bin'),
    ].join(path.delimiter));

    expect(runtime.buildManagedOpenCodePath()).toBe([
      path.join(home, '.opencode', 'bin'),
      path.join(home, '.bun', 'bin'),
      '/opt/homebrew/bin',
      '/usr/bin',
      path.join(home, '.cargo', 'bin'),
      path.join(home, '.local', 'bin'),
      path.join(home, 'Library', 'pnpm'),
    ].join(path.delimiter));
  });

  it('uses login shell PATH for managed OpenCode when process PATH is minimal', () => {
    const home = os.homedir();
    const loginShellPath = [
      path.join(home, '.opencode', 'bin'),
      path.join(home, '.bun', 'bin'),
      '/opt/homebrew/bin',
      '/usr/bin',
    ].join(path.delimiter);
    process.env.PATH = ['/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter);

    const runtime = createRuntime(loginShellPath);

    // Should prefer login shell PATH but merge in any process entries not already present.
    expect(runtime.buildManagedOpenCodePath()).toBe([
      path.join(home, '.opencode', 'bin'),
      path.join(home, '.bun', 'bin'),
      '/opt/homebrew/bin',
      '/usr/bin',
      path.join(home, '.local', 'bin'),
      '/usr/local/bin',
      '/bin',
    ].join(path.delimiter));
  });

  it('preserves user-configured process PATH order before appending shell-only entries', () => {
    const home = os.homedir();
    process.env.PATH = [
      path.join(home, '.bun', 'bin'),
      path.join(home, 'Library', 'pnpm'),
      '/opt/homebrew/bin',
      '/usr/bin',
    ].join(path.delimiter);

    const runtime = createRuntime([
      path.join(home, '.bun', 'bin'),
      '/opt/homebrew/bin',
      path.join(home, '.cargo', 'bin'),
      '/usr/bin',
    ].join(path.delimiter));

    expect(runtime.buildAugmentedPath()).toBe([
      path.join(home, '.bun', 'bin'),
      path.join(home, 'Library', 'pnpm'),
      '/opt/homebrew/bin',
      '/usr/bin',
      path.join(home, '.local', 'bin'),
      path.join(home, '.cargo', 'bin'),
    ].join(path.delimiter));
  });

  it('prefers login shell PATH when current process PATH is minimal', () => {
    const home = os.homedir();
    process.env.PATH = ['/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter);

    const runtime = createRuntime([
      path.join(home, '.bun', 'bin'),
      '/opt/homebrew/bin',
      '/usr/bin',
    ].join(path.delimiter));

    expect(runtime.buildAugmentedPath()).toBe([
      path.join(home, '.bun', 'bin'),
      '/opt/homebrew/bin',
      '/usr/bin',
      path.join(home, '.local', 'bin'),
      '/usr/local/bin',
      '/bin',
    ].join(path.delimiter));
  });
});

describe('server utils runtime snapshots on OpenCode 2', () => {
  const createSnapshotRuntime = (openCodeClient) => createServerUtilsRuntime({
    fs: {},
    os,
    path,
    process,
    openCodeReadyGraceMs: 0,
    longRequestTimeoutMs: 0,
    getRuntime: () => ({}),
    getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: (route) => `http://127.0.0.1:1${route}`,
    ensureOpenCodeApiPrefix: () => {},
    getUiNotificationClients: () => new Set(),
    getOpenCodePort: () => 4096,
    setOpenCodePortState: () => {},
    syncToHmrState: () => {},
    markOpenCodeNotReady: () => {},
    setOpenCodeNotReadySince: () => {},
    clearLastOpenCodeError: () => {},
    getLoginShellPath: () => null,
    openCodeClient,
  });

  it('reads the agents snapshot through the client with the requested location', async () => {
    const agents = vi.fn(async () => [{ name: 'build' }]);
    const runtime = createSnapshotRuntime(() => ({ generation: () => 2, catalog: { agents } }));

    expect(await runtime.fetchAgentsSnapshot({ directory: '/repo' })).toEqual([{ name: 'build' }]);
    expect(agents).toHaveBeenCalledWith({ directory: '/repo' });
  });

  it('applies the same array validation to the client value', async () => {
    const providerList = vi.fn(async () => ({ all: [], default: {}, connected: [] }));
    const runtime = createSnapshotRuntime({ generation: () => 2, catalog: { providerList } });

    await expect(runtime.fetchProvidersSnapshot({ directory: '/repo' })).rejects.toThrow('Invalid providers snapshot payload from OpenCode');
    expect(providerList).toHaveBeenCalledWith({ directory: '/repo' });
  });

  it('refuses generation 1 without fetching', async () => {
    const agents = vi.fn();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => Response.json([{ name: 'plan' }]));
    globalThis.fetch = fetchMock;
    try {
      const runtime = createSnapshotRuntime({ generation: () => 1, catalog: { agents } });
      await expect(runtime.fetchAgentsSnapshot({ directory: '/repo' })).rejects.toMatchObject({ code: 'opencode_generation_invalid', statusCode: 503 });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(agents).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed on an unknown generation', async () => {
    const runtime = createSnapshotRuntime({ generation: () => { throw new Error('The OpenCode runtime generation is unknown'); } });
    await expect(runtime.fetchAgentsSnapshot({ directory: '/repo' })).rejects.toThrow('The OpenCode runtime generation is unknown');
  });
});
