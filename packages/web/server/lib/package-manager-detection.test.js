import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const probes = vi.hoisted(() => ({ execFile: vi.fn(), spawnSync: vi.fn() }));
vi.mock('node:child_process', async (original) => ({ ...await original(), ...probes }));

const packagePath = fileURLToPath(new URL('../../', import.meta.url));
let fixture;
let settings;
beforeAll(async () => { fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-package-detection-')); });
afterAll(async () => { await fs.rm(fixture, { recursive: true, force: true }); });

const commandResult = (command, args) => {
  const pm = path.basename(command).replace(/\.exe$/, '');
  if (!settings.available.includes(pm)) return { status: 1, stdout: '', stderr: '' };
  let stdout = '';
  if (args[0] === '--version') stdout = '1.0.0';
  else if (args[0] === 'root') stdout = path.join(fixture, pm, 'node_modules');
  else if (args[0] === 'prefix') stdout = path.join(fixture, pm);
  else if (args[0] === 'bin' || args.join(' ') === 'global bin' || args.join(' ') === 'pm bin -g') stdout = path.join(fixture, pm, 'bin');
  else if (args.join(' ') === 'global dir') stdout = path.join(fixture, pm);
  else if (settings.visible.includes(pm)) stdout = '@openchamber/web@1.0.0';
  return { status: 0, stdout, stderr: '' };
};

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  settings = { available: [], visible: [] };
  for (const key of ['OPENCHAMBER_RUNTIME', 'OPENCHAMBER_PACKAGE_MANAGER', 'npm_config_user_agent', 'npm_execpath', 'BUN_INSTALL']) vi.stubEnv(key, '');
  await fs.rm(fixture, { recursive: true, force: true });
  await fs.mkdir(fixture, { recursive: true });
  probes.spawnSync.mockImplementation(commandResult);
  probes.execFile.mockImplementation((command, args, _options, callback) => {
    const result = commandResult(command, args);
    queueMicrotask(() => callback(result.status === 0 ? null : Object.assign(new Error('unavailable'), { code: 1 }), result.stdout, result.stderr));
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const ownWithRoot = async (pm) => {
  const root = pm === 'bun' ? path.join(fixture, pm, 'install/global/node_modules') : path.join(fixture, pm, 'node_modules');
  await fs.mkdir(path.join(root, '@openchamber'), { recursive: true });
  await fs.symlink(packagePath, path.join(root, '@openchamber/web'), 'junction');
};

describe('async package manager selection matches synchronous CLI selection', () => {
  it.each([
    { name: 'forced available manager wins ownership', forced: 'yarn', available: ['yarn', 'npm'], owner: 'npm', expected: 'yarn' },
    { name: 'unavailable forced manager falls through to ownership', forced: 'yarn', available: ['npm'], owner: 'npm', expected: 'npm' },
    { name: 'ownership wins a conflicting environment hint', hint: 'bun/1.0', available: ['bun', 'pnpm'], visible: ['bun'], owner: 'pnpm', expected: 'pnpm' },
    { name: 'Bun global root ownership is retained', available: ['bun', 'npm'], owner: 'bun', expected: 'bun' },
    { name: 'visible user-agent hint wins runtime fallback', hint: 'yarn/1.0', available: ['yarn', 'npm'], visible: ['yarn', 'npm'], expected: 'yarn' },
    { name: 'invisible hint cannot select a package manager', hint: 'yarn/1.0', available: ['yarn', 'npm'], visible: ['npm'], expected: 'npm' },
    { name: 'last-resort visibility is retained', available: ['pnpm'], visible: ['pnpm'], expected: 'pnpm' },
    { name: 'no available manager uses npm fallback', available: [], expected: 'npm' },
  ])('$name', async (scenario) => {
    settings = { available: scenario.available, visible: scenario.visible ?? [] };
    vi.stubEnv('OPENCHAMBER_PACKAGE_MANAGER', scenario.forced ?? '');
    vi.stubEnv('npm_config_user_agent', scenario.hint ?? '');
    if (scenario.owner) await ownWithRoot(scenario.owner);
    const sync = await import('./package-manager.js');
    expect(sync.detectPackageManager()).toBe(scenario.expected);
    vi.resetModules();
    const asynchronous = await import('./package-manager.js');
    const before = probes.spawnSync.mock.calls.length;
    expect(await asynchronous.detectPackageManagerAsync()).toBe(scenario.expected);
    expect(probes.spawnSync).toHaveBeenCalledTimes(before);
    expect(probes.execFile.mock.calls.every(([, args, options]) => options.timeout === (args[0] === '--version' ? 5000 : 10000)
      && options.maxBuffer === 1024 * 1024 && options.killSignal === 'SIGKILL')).toBe(true);
  });

  it('resolves installation ownership through the global executable symlink', async () => {
    settings.available = ['yarn', 'npm'];
    await fs.mkdir(path.join(fixture, 'yarn/bin'), { recursive: true });
    const name = process.platform === 'win32' ? 'openchamber.cmd' : 'openchamber';
    await fs.symlink(path.join(packagePath, 'bin/cli.js'), path.join(fixture, 'yarn/bin', name));
    const sync = await import('./package-manager.js');
    expect(sync.detectPackageManager()).toBe('yarn');
    vi.resetModules();
    const asynchronous = await import('./package-manager.js');
    expect(await asynchronous.detectPackageManagerAsync()).toBe('yarn');
  });

  it('keeps desktop update ownership and skips every subprocess', async () => {
    vi.stubEnv('OPENCHAMBER_RUNTIME', 'desktop');
    const { detectPackageManager, detectPackageManagerAsync } = await import('./package-manager.js');
    expect(detectPackageManager()).toBe('electron');
    expect(await detectPackageManagerAsync()).toBe('electron');
    expect(probes.execFile).not.toHaveBeenCalled();
    expect(probes.spawnSync).not.toHaveBeenCalled();
  });

  it('shares one in-flight lookup and retains cached selection without more probes', async () => {
    settings.available = ['npm'];
    vi.stubEnv('OPENCHAMBER_PACKAGE_MANAGER', 'npm');
    const { detectPackageManagerAsync } = await import('./package-manager.js');
    expect(await Promise.all([detectPackageManagerAsync(), detectPackageManagerAsync()])).toEqual(['npm', 'npm']);
    const count = probes.execFile.mock.calls.length;
    expect(count).toBe(2);
    settings.available = [];
    expect(await detectPackageManagerAsync()).toBe('npm');
    expect(probes.execFile).toHaveBeenCalledTimes(count);
  });

  it('treats failed or timed-out probes as unavailable without promoting the forced manager', async () => {
    vi.stubEnv('OPENCHAMBER_PACKAGE_MANAGER', 'yarn');
    probes.execFile.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(Object.assign(new Error('probe stopped'), { killed: true, code: 'ETIMEDOUT' }), '@openchamber/web', ''));
    });
    const { detectPackageManagerAsync } = await import('./package-manager.js');
    expect(await detectPackageManagerAsync()).toBe('npm');
  });

  it('retains fallback semantics when a probe cannot be launched', async () => {
    vi.stubEnv('OPENCHAMBER_PACKAGE_MANAGER', 'yarn');
    probes.execFile.mockImplementation(() => { throw new TypeError('invalid command path'); });
    const { detectPackageManagerAsync } = await import('./package-manager.js');
    expect(await detectPackageManagerAsync()).toBe('npm');
  });
});

it('serves another HTTP request while update checking waits for real slow subprocess probes', async () => {
  vi.stubEnv('OPENCHAMBER_PACKAGE_MANAGER', 'npm');
  const { execFile: nativeExecFile } = await vi.importActual('node:child_process');
  let probeStarted;
  const started = new Promise((resolve) => { probeStarted = resolve; });
  probes.execFile.mockImplementation((_command, _args, options, callback) => {
    probeStarted();
    return nativeExecFile(process.execPath, ['-e', 'setTimeout(() => process.stdout.write("1.0.0"), 180)'], options, callback);
  });
  const { checkForUpdates } = await import('./package-manager.js');
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ tag_name: 'v1.9.10', body: '' }) }));
  let updateCompleted = false;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') { res.end('responsive'); return; }
    const result = await checkForUpdates({ currentVersion: '1.9.10' });
    updateCompleted = true;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const update = nativeFetch(`${origin}/update`);
    await started;
    const health = await nativeFetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) });
    expect(await health.text()).toBe('responsive');
    expect(updateCompleted).toBe(false);
    expect(await (await update).json()).toMatchObject({ available: false, packageManager: 'npm', updateCommand: 'openchamber update' });
    expect(probes.spawnSync).not.toHaveBeenCalled();
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
