import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpenCodeEnvRuntime } from './env-runtime.js';

const originalOpencodeBinary = process.env.OPENCODE_BINARY;
const originalPlatform = process.platform;
const originalPath = process.env.PATH;
const tempDirs = [];

const createTempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

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

describe('OpenCode env runtime', () => {
  it('prefers the canonical OpenCode installer binary over a PATH shadow', () => {
    const home = createTempDir('openchamber-opencode-home-');
    const canonicalDir = path.join(home, '.opencode', 'bin');
    const pathDir = createTempDir('openchamber-opencode-path-');
    const canonicalBinary = path.join(canonicalDir, 'opencode');
    const pathBinary = path.join(pathDir, 'opencode');
    fs.mkdirSync(canonicalDir, { recursive: true });
    fs.writeFileSync(canonicalBinary, '#!/bin/sh\nexit 0\n');
    fs.writeFileSync(pathBinary, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(canonicalBinary, 0o755);
    fs.chmodSync(pathBinary, 0o755);

    const { runtime, state } = createRuntime({}, {
      homeDirectory: home,
      environmentPath: pathDir,
    });

    expect(runtime.resolveOpencodeCliPath()).toBe(canonicalBinary);
    expect(state.resolvedOpencodeBinarySource).toBe('canonical');
  });

  it('throws a specific error for a missing configured OpenCode binary in strict mode', async () => {
    const { runtime } = createRuntime({ opencodeBinary: '/missing/opencode' });

    await expect(runtime.applyOpencodeBinaryFromSettings({ strict: true })).rejects.toMatchObject({
      code: 'OPENCODE_BINARY_INVALID',
      message: expect.stringContaining('Configured OpenCode binary not found: /missing/opencode'),
    });
  });

  it('throws a specific error for a configured directory without an executable CLI in strict mode', async () => {
    const dir = createTempDir('openchamber-opencode-dir-');
    const { runtime } = createRuntime({ opencodeBinary: dir });

    await expect(runtime.applyOpencodeBinaryFromSettings({ strict: true })).rejects.toMatchObject({
      code: 'OPENCODE_BINARY_INVALID',
      message: expect.stringContaining('Configured OpenCode binary directory does not contain an executable'),
    });
  });

  it('applies a valid configured executable OpenCode binary', async () => {
    const dir = createTempDir('openchamber-opencode-bin-');
    const binary = path.join(dir, 'opencode');
    fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(binary, 0o755);
    const { runtime, state } = createRuntime({ opencodeBinary: binary });

    await expect(runtime.applyOpencodeBinaryFromSettings({ strict: true })).resolves.toBe(binary);
    expect(process.env.OPENCODE_BINARY).toBe(binary);
    expect(state.resolvedOpencodeBinary).toBe(binary);
    expect(state.resolvedOpencodeBinarySource).toBe('settings');
  });

  it.runIf(process.platform === 'darwin')('rejects known macOS OpenCode app bundle executable paths', async () => {
    const { runtime } = createRuntime({ opencodeBinary: '/Applications/OpenCode.app/Contents/MacOS/OpenCode' });

    await expect(runtime.applyOpencodeBinaryFromSettings({ strict: true })).rejects.toMatchObject({
      code: 'OPENCODE_BINARY_INVALID',
      message: expect.stringContaining('macOS desktop app bundle'),
    });
  });

  it('does not classify failed WSL resolution as an invalid configured binary in strict mode', async () => {
    setPlatform('win32');
    const { runtime } = createRuntime({ opencodeBinary: 'wsl:/usr/local/bin/opencode' }, {
      isExecutable: () => false,
      executeProbe: () => ({ status: 1, stdout: '' }),
    });

    await expect(runtime.applyOpencodeBinaryFromSettings({ strict: true })).rejects.toThrow('uses WSL');
    await runtime.applyOpencodeBinaryFromSettings({ strict: true }).catch((error) => {
      expect(error.code).toBeUndefined();
    });
  });
});

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
    expect(runtime.resolveOpencodeCliPath()).toBe(binary);
  });

  it('rejects thrown, signalled and malformed shell results before using a valid path', () => {
    let calls = 0;
    const { runtime } = fixture({
      isExecutable: (file) => ['/fixture/a', '/fixture/b', '/fixture/c', '/fixture/d', '/fixture/bin/opencode'].includes(file),
      executeProbe: () => {
        calls += 1;
        if (calls === 1) throw new Error('probe failed');
        if (calls === 2) return { status: 0, signal: 'SIGKILL', stdout: '/fixture/bin/opencode' };
        if (calls === 3) return { status: 0, stdout: 'unexpected banner\n/fixture/bin/opencode' };
        return { status: 0, stdout: '/fixture/bin/opencode\n' };
      },
    });
    expect(runtime.resolveOpencodeCliPath()).toBe('/fixture/bin/opencode');
    expect(calls).toBe(4);
  });

  it.each([0, 7_000])('constrains the WSL six-second ceiling after %i ms of discovery', (elapsed) => {
    setPlatform('win32');
    let now = 0;
    const calls = [];
    const wsl = 'C:\\fixture\\wsl.exe';
    const { runtime, state } = fixture({
      isExecutable: (file) => file === wsl,
      probeNow: () => now,
      executeProbe: (file, args, options) => {
        calls.push({ file, timeout: options.timeout });
        if (args[0] === 'opencode') { now += elapsed / 2; return { status: 1, stdout: '' }; }
        if (args[0] === 'wsl') { now += elapsed / 2; return { status: 0, stdout: `${wsl}\r\n` }; }
        return { status: 0, stdout: '/usr/local/bin/opencode\n' };
      },
    });
    expect(runtime.resolveOpencodeCliPath()).toBe('wsl:/usr/local/bin/opencode');
    expect(state.resolvedWslBinary).toBe(wsl);
    expect(state.resolvedWslOpencodePath).toBe('/usr/local/bin/opencode');
    expect(calls.at(-1)).toEqual({ file: wsl, timeout: Math.min(6_000, 10_000 - elapsed) });
  });

  it('bounds OpenCode shell lookup and discards a failed executable result', () => {
    const attempts = [];
    const { runtime } = fixture({ isExecutable: (file) => ['/fixture/a', '/fixture/b', '/fixture/bin/opencode'].includes(file),
      executeProbe: (file, args, options) => {
        attempts.push(options.timeout);
        return { status: file === '/fixture/a' ? 1 : 0, stdout: '/fixture/bin/opencode\n' };
      } });
    expect(runtime.resolveOpencodeCliPath()).toBe('/fixture/bin/opencode');
    expect(attempts).toEqual([5_000, 5_000]);
  });

  it.each(['node', 'bun'])('bounds %s discovery needed by a configured shim', async (interpreter) => {
    const dir = createTempDir('devryan-probe-shim-');
    const shim = path.join(dir, 'opencode');
    fs.writeFileSync(shim, `#!/usr/bin/env ${interpreter}\n`);
    const calls = [];
    const { runtime, state } = createRuntime({ opencodeBinary: shim }, {
      environmentPath: '', homeDirectory: dir, shellCandidates: ['/fixture/shell'],
      isExecutable: (file) => [shim, '/fixture/shell', `/fixture/bin/${interpreter}`].includes(file),
      executeProbe: (file, args, options) => {
        calls.push({ command: args.at(-1), timeout: options.timeout });
        return { status: 0, stdout: `/fixture/bin/${interpreter}\n` };
      },
    });
    await runtime.applyOpencodeBinaryFromSettings({ strict: true });
    expect(calls).toEqual([{ command: `command -v ${interpreter}`, timeout: 5_000 }]);
    expect(state[interpreter === 'node' ? 'resolvedNodeBinary' : 'resolvedBunBinary']).toBe(`/fixture/bin/${interpreter}`);
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
