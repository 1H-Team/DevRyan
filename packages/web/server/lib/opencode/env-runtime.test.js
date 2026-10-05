import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpenCodeEnvRuntime } from './env-runtime.js';

const originalOpencodeBinary = process.env.OPENCODE_BINARY;
const originalPlatform = process.platform;
const originalPath = process.env.PATH;
const tempDirs = [];

const setPlatform = (platform) => {
  Object.defineProperty(process, 'platform', {
    value: platform,
  });
};

afterEach(() => {
  process.env.PATH = originalPath;
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
  });

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (typeof originalOpencodeBinary === 'string') {
    process.env.OPENCODE_BINARY = originalOpencodeBinary;
    return;
  }
  delete process.env.OPENCODE_BINARY;
});

const createRuntime = (settings, overrides = {}) => {
  const state = {
    cachedLoginShellEnvSnapshot: null,
    resolvedOpencodeBinary: null,
    resolvedOpencodeBinarySource: null,
    useWslForOpencode: false,
    resolvedWslBinary: null,
    resolvedWslOpencodePath: null,
    resolvedWslDistro: null,
    resolvedNodeBinary: null,
    resolvedBunBinary: null,
    managedOpenCodeShellEnvSnapshot: null,
  };

  const runtime = createOpenCodeEnvRuntime({
    state,
    normalizeDirectoryPath: (value) => value,
    readSettingsFromDiskMigrated: async () => settings,
    ENV_CONFIGURED_OPENCODE_WSL_DISTRO: null,
    ...overrides,
  });

  return { runtime, state };
};

describe('bounded discovery probes', () => {
  const fixture = (overrides = {}) => createRuntime({}, {
    homeDirectory: '/fixture/home', environmentPath: '',
    shellCandidates: ['/fixture/a', '/fixture/a', '/fixture/b', '/fixture/c', '/fixture/d'],
    isExecutable: (file) => file.startsWith('/fixture/'),
    ...overrides,
  });

  it('deduplicates shells, reduces the final timeout, and skips exhausted attempts', () => {
    let now = 100_000;
    const attempts = [];
    const { runtime, state } = fixture({ executeProbe: (file, args, options) => {
      attempts.push({ file, timeout: options.timeout, signal: options.killSignal });
      now += attempts.length === 1 ? 4_000 : options.timeout;
      return { status: 1, stdout: 'PATH=/invalid\0' };
    }, probeNow: () => now });
    state.cachedLoginShellEnvSnapshot = undefined;
    expect(runtime.getLoginShellEnvSnapshot()).toBeNull();
    expect(attempts).toEqual([
      { file: '/fixture/a', timeout: 5_000, signal: 'SIGKILL' },
      { file: '/fixture/b', timeout: 5_000, signal: 'SIGKILL' },
      { file: '/fixture/c', timeout: 1_000, signal: 'SIGKILL' },
    ]);
    runtime.getLoginShellEnvSnapshot();
    expect(attempts).toHaveLength(3);
  });

  it('rejects partial timeout output and malformed environments, then accepts the fallback', () => {
    let count = 0;
    const { runtime, state } = fixture({ executeProbe: () => {
      count += 1;
      if (count === 1) return { status: 0, error: { code: 'ETIMEDOUT' }, stdout: 'PATH=/partial\0' };
      return { status: 0, stdout: count === 2 ? 'malformed' : 'PATH=/fixture/bin\0VALUE=a=b\0' };
    } });
    state.cachedLoginShellEnvSnapshot = undefined;
    expect(runtime.getLoginShellEnvSnapshot()).toEqual({ PATH: '/fixture/bin', VALUE: 'a=b' });
    expect(count).toBe(3);
  });

  it('shares the Windows environment budget across PowerShell and CMD', () => {
    setPlatform('win32');
    let now = 0;
    const timeouts = [];
    const { runtime, state } = fixture({ probeNow: () => now, executeProbe: (file, args, options) => {
      timeouts.push(options.timeout);
      now += 3_000;
      return { status: 0, stdout: args.includes('set') ? 'PATH=C:\\fixture\r\n' : 'invalid' };
    } });
    state.cachedLoginShellEnvSnapshot = undefined;
    expect(runtime.getLoginShellEnvSnapshot()).toBeNull();
    expect(timeouts).toEqual([5_000, 5_000, 4_000, 1_000]);
  });

  it('accepts CMD environment fallback and Windows executable paths containing spaces', () => {
    setPlatform('win32');
    const binary = 'C:\\Program Files\\Fixture\\opencode.exe';
    const { runtime, state } = fixture({ isExecutable: (file) => file === binary,
      executeProbe: (_file, args) => ({ status: 0, stdout: args.includes('set')
        ? '=C:=C:\\fixture\r\nPATH=C:\\fixture\r\n'
        : args[0] === 'opencode' ? `${binary}\r\n` : 'malformed' }),
    });
    state.cachedLoginShellEnvSnapshot = undefined;
    expect(runtime.getLoginShellEnvSnapshot()).toEqual({ PATH: 'C:\\fixture' });
    expect(runtime.isExecutable(binary)).toBe(true);
    expect(runtime.resolveOpencodeCliPath).toBeUndefined();
  });

  it('forcefully terminates an isolated process that ignores SIGTERM', () => {
    let result;
    const { runtime, state } = fixture({ shellCandidates: ['/fixture/process'], probeTimeoutMs: 150, probeBudgetMs: 200,
      executeProbe: (_file, _args, options) => {
        result = spawnSync(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('PATH=/partial\\0'); setInterval(() => {}, 1000)"],
          { ...options, cwd: process.cwd(), env: {} });
        return result;
      },
    });
    state.cachedLoginShellEnvSnapshot = undefined;
    const started = performance.now();
    expect(runtime.getLoginShellEnvSnapshot()).toBeNull();
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(result.error.code).toBe('ETIMEDOUT');
    expect(result.signal).toBe('SIGKILL');
    expect(() => process.kill(result.pid, 0)).toThrow();
  });
});

describe('applyLoginShellEnvSnapshot filter', () => {
  const NAMES = ['OPENCODE_HOST', 'OPENCODE_BINARY', 'OPENCODE_SKIP_START', 'OPENCODE_DB', 'DEVRYAN_OPENCODE_GENERATION', 'DEVRYAN_RUNTIME_BUNDLE_ROOT',
    'OPENCHAMBER_ELECTRON_DEV', 'DEVRYAN_EXECUTION_ARTIFACTS', 'DEVRYAN_DEFAULT_CONFIG_ROOT', 'OPENCHAMBER_ELECTRON_USER_DATA_DIR',
    'OPENCHAMBER_DATA_DIR', 'DEVRYAN_PRIMARY_RECOVERY_MODE', 'DEVRYAN_PACKAGED_DESKTOP'];
  const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const shell = { OPENCODE_HOST: 'https://fixture.invalid:4096', OPENCODE_BINARY: '/fixture/bin/opencode', OPENCODE_SKIP_START: 'true',
    OPENCODE_DB: 'relative.db', DEVRYAN_OPENCODE_GENERATION: '1', DEVRYAN_RUNTIME_BUNDLE_ROOT: '/fixture/bundles',
    OPENCHAMBER_ELECTRON_DEV: '1', DEVRYAN_EXECUTION_ARTIFACTS: '/fixture/artifacts', DEVRYAN_DEFAULT_CONFIG_ROOT: '/fixture/default-config',
    OPENCHAMBER_ELECTRON_USER_DATA_DIR: '/fixture/user-data', OPENCHAMBER_DATA_DIR: '/fixture/data', DEVRYAN_PRIMARY_RECOVERY_MODE: 'legacy' };
  const apply = ({ launch = {}, packaged = false } = {}) => {
    for (const name of NAMES) delete process.env[name];
    Object.assign(process.env, launch);
    if (packaged) process.env.DEVRYAN_PACKAGED_DESKTOP = '1';
    const info = [];
    const { runtime, state } = createRuntime({}, { shellCandidates: ['/fixture/zsh'], isExecutable: (file) => file === '/fixture/zsh',
      executeProbe: () => ({ status: 0, stdout: `${Object.entries(shell).map(([key, value]) => `${key}=${value}`).join('\0')}\0` }),
      logger: { info: (message) => info.push(message) } });
    state.cachedLoginShellEnvSnapshot = undefined;
    runtime.applyLoginShellEnvSnapshot();
    runtime.applyLoginShellEnvSnapshot();
    return { env: Object.fromEntries(NAMES.map((name) => [name, process.env[name] ?? null])), info };
  };
  const provisioning = ['DEVRYAN_OPENCODE_GENERATION', 'DEVRYAN_RUNTIME_BUNDLE_ROOT', 'OPENCODE_BINARY', 'OPENCODE_DB', 'OPENCODE_HOST', 'OPENCODE_SKIP_START'];
  const redirections = ['DEVRYAN_DEFAULT_CONFIG_ROOT', 'DEVRYAN_EXECUTION_ARTIFACTS', 'OPENCHAMBER_ELECTRON_DEV', 'OPENCHAMBER_ELECTRON_USER_DATA_DIR'];

  it('drops provisioning-refused login-shell values in every runtime, merges the rest and logs names once', () => {
    const { env, info } = apply();
    for (const name of provisioning) expect(env[name], name).toBeNull();
    for (const name of [...redirections, 'OPENCHAMBER_DATA_DIR', 'DEVRYAN_PRIMARY_RECOVERY_MODE']) expect(env[name], name).toBe(shell[name]);
    expect(info).toEqual([`[shell-env] server ignored login-shell variables the runtime does not support: ${provisioning.join(', ')}`]);
  });

  it('drops dev/packaging redirections only under the packaged desktop marker', () => {
    const { env, info } = apply({ packaged: true });
    for (const name of [...provisioning, ...redirections]) expect(env[name], name).toBeNull();
    expect(env.OPENCHAMBER_DATA_DIR).toBe('/fixture/data');
    expect(info).toHaveLength(1);
    for (const name of [...provisioning, ...redirections]) expect(info[0]).toContain(name);
    for (const value of Object.values(shell)) expect(info[0]).not.toContain(value);
  });

  it('never touches launch-environment values', () => {
    const launch = { OPENCODE_HOST: 'http://127.0.0.1:9999', OPENCHAMBER_ELECTRON_DEV: '0', DEVRYAN_EXECUTION_ARTIFACTS: '/launch/artifacts' };
    const { env, info } = apply({ launch, packaged: true });
    for (const [name, value] of Object.entries(launch)) expect(env[name]).toBe(value);
    expect(info[0]).not.toMatch(/OPENCODE_HOST|OPENCHAMBER_ELECTRON_DEV|DEVRYAN_EXECUTION_ARTIFACTS/);
  });
});
