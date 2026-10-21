import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  configureCursorSdkRipgrep,
  resolveCursorRipgrepPath,
} from './ripgrep-path.js';

let tempDir = null;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

const createExecutable = (filePath) => {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, '#!/bin/sh\nexit 0\n');
  chmodSync(filePath, 0o755);
  return filePath;
};

const createPlatformRipgrep = (resourcesPath, packageName) => (
  createExecutable(join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@cursor', packageName, 'bin', 'rg'))
);

describe('Cursor SDK ripgrep path resolution', () => {
  test('resolves Electron app.asar.unpacked ripgrep for darwin arm64', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-rg-electron-arm64-'));
    const resourcesPath = join(tempDir, 'Resources');
    const rgPath = createPlatformRipgrep(resourcesPath, 'sdk-darwin-arm64');

    expect(resolveCursorRipgrepPath({
      env: {},
      pathValue: '',
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath,
    })).toEqual({ path: rgPath, source: 'electron-resources' });
  });

  test('resolves Electron app.asar.unpacked ripgrep for darwin x64', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-rg-electron-x64-'));
    const resourcesPath = join(tempDir, 'Resources');
    const rgPath = createPlatformRipgrep(resourcesPath, 'sdk-darwin-x64');

    expect(resolveCursorRipgrepPath({
      env: {},
      pathValue: '',
      platform: 'darwin',
      arch: 'x64',
      resourcesPath,
    })).toEqual({ path: rgPath, source: 'electron-resources' });
  });

  test('resolves package ripgrep from a mocked platform package path', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-rg-package-'));
    const packageRoot = join(tempDir, 'node_modules', '@cursor', 'sdk-linux-x64');
    const packageJsonPath = join(packageRoot, 'package.json');
    const rgPath = createExecutable(join(packageRoot, 'bin', 'rg'));
    writeFileSync(packageJsonPath, '{"name":"@cursor/sdk-linux-x64"}\n');

    expect(resolveCursorRipgrepPath({
      env: {},
      pathValue: '',
      platform: 'linux',
      arch: 'x64',
      requireResolve: (specifier) => {
        expect(specifier).toBe('@cursor/sdk-linux-x64/package.json');
        return packageJsonPath;
      },
    })).toEqual({ path: rgPath, source: 'package' });
  });

  test('resolves package ripgrep from Bun central-store optional packages', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-rg-bun-store-'));
    const packageRoot = join(tempDir, 'node_modules', '.bun', 'node_modules', '@cursor', 'sdk-linux-x64');
    const rgPath = createExecutable(join(packageRoot, 'bin', 'rg'));
    writeFileSync(join(packageRoot, 'package.json'), '{"name":"@cursor/sdk-linux-x64"}\n');

    expect(resolveCursorRipgrepPath({
      env: {},
      pathValue: '',
      platform: 'linux',
      arch: 'x64',
      resourcesPath: '',
      packageSearchRoots: [tempDir],
      requireResolve: () => {
        throw new Error('package unavailable through normal resolution');
      },
    })).toEqual({ path: rgPath, source: 'package' });
  });

  test('uses CURSOR_SDK_RIPGREP_PATH before auto detection', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-rg-env-'));
    const envPath = createExecutable(join(tempDir, 'custom-rg'));

    expect(resolveCursorRipgrepPath({
      env: { CURSOR_SDK_RIPGREP_PATH: envPath },
      pathValue: '',
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath: join(tempDir, 'missing-resources'),
    })).toEqual({ path: envPath, source: 'explicit' });
  });

  test('ignores unusable explicit ripgrep paths', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-rg-invalid-explicit-'));
    const envPath = join(tempDir, 'not-rg');
    writeFileSync(envPath, 'not executable\n');
    chmodSync(envPath, 0o644);

    expect(resolveCursorRipgrepPath({
      env: { CURSOR_SDK_RIPGREP_PATH: envPath },
      pathValue: '',
      platform: 'linux',
      arch: 'unsupported',
      resourcesPath: '',
      requireResolve: () => {
        throw new Error('package unavailable');
      },
    })).toEqual({ path: '', source: 'missing' });
  });

  test('ignores non-executable PATH ripgrep candidates on POSIX', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-rg-path-exec-'));
    const rgPath = join(tempDir, 'rg');
    writeFileSync(rgPath, '#!/bin/sh\nexit 0\n');
    chmodSync(rgPath, 0o644);

    expect(resolveCursorRipgrepPath({
      env: {},
      pathValue: tempDir,
      platform: 'linux',
      arch: 'unsupported',
      resourcesPath: '',
      requireResolve: () => {
        throw new Error('package unavailable');
      },
    })).toEqual({ path: '', source: 'missing' });
  });

  test('configures the SDK exactly once when configureRipgrepPath is exported', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-rg-configure-'));
    const rgPath = createExecutable(join(tempDir, 'rg'));
    const calls = [];
    const sdk = {
      configureRipgrepPath: (value) => calls.push(value),
    };

    expect(configureCursorSdkRipgrep(sdk, {
      explicitRipgrepPath: rgPath,
      env: {},
      pathValue: '',
    })).toEqual({ configured: true, source: 'explicit' });
    expect(calls).toEqual([rgPath]);

    expect(configureCursorSdkRipgrep(sdk, {
      explicitRipgrepPath: rgPath,
      env: {},
      pathValue: '',
    })).toEqual({ configured: true, source: 'explicit' });
    expect(calls).toEqual([rgPath]);
  });

  test('returns unsupported without throwing when the SDK has no configure export', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-rg-unsupported-'));
    const rgPath = createExecutable(join(tempDir, 'rg'));

    expect(configureCursorSdkRipgrep({}, {
      explicitRipgrepPath: rgPath,
      env: {},
      pathValue: '',
    })).toEqual({
      configured: false,
      source: 'unsupported',
      usable: true,
      resolvedSource: 'explicit',
      configureSupported: false,
    });
  });
});
