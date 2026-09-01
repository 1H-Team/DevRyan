import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_BROWSER_VERSION,
  AGENT_BROWSER_MANAGED_CONFIG_FILE,
  __test,
  createAgentBrowserInstaller,
  provisionAgentBrowserSkill,
  resolveAgentBrowserBinaryName,
  withdrawAgentBrowserSkill,
} from './install.js';

const temporaryDirectories = [];

const makeTemporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'devryan-agent-browser-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

const writeInstalledPackage = (installRoot, version = AGENT_BROWSER_VERSION) => {
  const packageRoot = join(installRoot, 'node_modules', 'agent-browser');
  const binaryPath = join(packageRoot, 'bin', 'agent-browser-darwin-arm64');
  mkdirSync(dirname(binaryPath), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({ version })}\n`, 'utf8');
  writeFileSync(binaryPath, `#!/bin/sh\nprintf 'agent-browser ${version}\\n'\n`, 'utf8');
  chmodSync(binaryPath, 0o755);
  writeFileSync(join(installRoot, AGENT_BROWSER_MANAGED_CONFIG_FILE), '{}\n', 'utf8');
  return binaryPath;
};

const writeFakeBun = (root) => {
  const executable = join(root, 'bun');
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, '#!/bin/sh\nprintf \'1.2.3\\n\'\n', 'utf8');
  chmodSync(executable, 0o755);
  return executable;
};

describe('managed agent-browser installer', () => {
  it('resolves every packaged platform binary name', () => {
    expect(resolveAgentBrowserBinaryName({ platform: 'darwin', arch: 'arm64' }))
      .toBe('agent-browser-darwin-arm64');
    expect(resolveAgentBrowserBinaryName({ platform: 'linux', arch: 'x64', musl: true }))
      .toBe('agent-browser-linux-musl-x64');
    expect(resolveAgentBrowserBinaryName({ platform: 'win32', arch: 'x64' }))
      .toBe('agent-browser-win32-x64.exe');
    expect(resolveAgentBrowserBinaryName({ platform: 'win32', arch: 'arm64' })).toBeNull();
    expect(resolveAgentBrowserBinaryName({ platform: 'freebsd', arch: 'x64' })).toBeNull();
  });

  it('installs the exact pin with ignore-scripts and returns a deterministic native path', async () => {
    const dataRoot = makeTemporaryDirectory();
    const bunExecutable = writeFakeBun(makeTemporaryDirectory());
    let installRoot;
    const runCommand = vi.fn(async (_command, _args, options) => {
      installRoot = options.cwd;
      writeInstalledPackage(installRoot);
      return { ok: true, code: 0, stdout: '', stderr: '' };
    });
    const installer = createAgentBrowserInstaller({
      dataRoot,
      platform: 'darwin',
      arch: 'arm64',
      bunExecutable,
      runCommand,
    });

    const result = await installer.ensureInstalled();

    expect(result).toMatchObject({
      ok: true,
      state: 'ready',
      expectedVersion: AGENT_BROWSER_VERSION,
      installedVersion: AGENT_BROWSER_VERSION,
      changed: true,
    });
    expect(result.binaryPath).toBe(join(
      dataRoot,
      'tools',
      'agent-browser',
      'node_modules',
      'agent-browser',
      'bin',
      'agent-browser-darwin-arm64',
    ));
    expect(result.configPath).toBe(join(dataRoot, 'tools', 'agent-browser', AGENT_BROWSER_MANAGED_CONFIG_FILE));
    expect(runCommand).toHaveBeenCalledWith(
      bunExecutable,
      ['install', '--ignore-scripts'],
      expect.objectContaining({ cwd: join(dataRoot, 'tools', 'agent-browser') }),
    );
    expect(JSON.parse(readFileSync(join(installRoot, 'package.json'), 'utf8')).dependencies)
      .toEqual({ 'agent-browser': AGENT_BROWSER_VERSION });
  });

  it('does no command work for a valid install and repairs on demand', async () => {
    const dataRoot = makeTemporaryDirectory();
    const bunExecutable = writeFakeBun(makeTemporaryDirectory());
    const installRoot = join(dataRoot, 'tools', 'agent-browser');
    mkdirSync(installRoot, { recursive: true });
    writeFileSync(join(installRoot, 'package.json'), `${JSON.stringify({
      private: true,
      dependencies: { 'agent-browser': AGENT_BROWSER_VERSION },
    })}\n`, 'utf8');
    writeInstalledPackage(installRoot);
    const runCommand = vi.fn(async () => ({ ok: true, code: 0, stdout: '', stderr: '' }));
    const installer = createAgentBrowserInstaller({
      dataRoot,
      platform: 'darwin',
      arch: 'arm64',
      bunExecutable,
      runCommand,
    });

    await expect(installer.ensureInstalled()).resolves.toMatchObject({ ok: true, changed: false });
    expect(runCommand).not.toHaveBeenCalled();
    writeFileSync(join(installRoot, AGENT_BROWSER_MANAGED_CONFIG_FILE), '{"provider":"external"}\n', 'utf8');
    await expect(installer.ensureInstalled()).resolves.toMatchObject({ ok: true, changed: true });
    expect(readFileSync(join(installRoot, AGENT_BROWSER_MANAGED_CONFIG_FILE), 'utf8')).toBe('{}\n');
    expect(runCommand).not.toHaveBeenCalled();
    await expect(installer.repair()).resolves.toMatchObject({ ok: true, repair: true });
    expect(runCommand).toHaveBeenCalledWith(
      bunExecutable,
      ['install', '--ignore-scripts', '--force'],
      expect.any(Object),
    );
  });

  it('updates a stale pin and reports nonfatal command failures', async () => {
    const dataRoot = makeTemporaryDirectory();
    const bunExecutable = writeFakeBun(makeTemporaryDirectory());
    const installRoot = join(dataRoot, 'tools', 'agent-browser');
    mkdirSync(installRoot, { recursive: true });
    writeFileSync(join(installRoot, 'package.json'), `${JSON.stringify({
      dependencies: { 'agent-browser': '0.26.0' },
    })}\n`, 'utf8');
    writeInstalledPackage(installRoot, '0.26.0');
    const installer = createAgentBrowserInstaller({
      dataRoot,
      platform: 'darwin',
      arch: 'arm64',
      bunExecutable,
      runCommand: vi.fn(async () => ({
        ok: false,
        code: 1,
        stdout: '',
        stderr: 'network unavailable',
      })),
    });

    const result = await installer.install();
    expect(result).toMatchObject({ ok: false, state: 'error', expectedVersion: AGENT_BROWSER_VERSION });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'bun-install-failed' }));
    expect(JSON.parse(readFileSync(join(installRoot, 'package.json'), 'utf8')).dependencies['agent-browser'])
      .toBe(AGENT_BROWSER_VERSION);
  });

  it('shares concurrent install work through one singleflight', async () => {
    const dataRoot = makeTemporaryDirectory();
    const bunExecutable = writeFakeBun(makeTemporaryDirectory());
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const runCommand = vi.fn(async (_command, _args, options) => {
      await gate;
      writeInstalledPackage(options.cwd);
      return { ok: true, code: 0, stdout: '', stderr: '' };
    });
    const installer = createAgentBrowserInstaller({
      dataRoot,
      platform: 'darwin',
      arch: 'arm64',
      bunExecutable,
      runCommand,
    });
    const first = installer.ensureInstalled();
    const second = installer.install();
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));
    release();
    expect(await first).toEqual(await second);
  });

  it('resolves and validates Bun from option, environment, current runtime, and the user install path', async () => {
    const cases = [
      {
        name: 'option',
        prepare: (root, homeDir) => ({
          homeDir,
          env: { PATH: '' },
          currentExecutable: join(root, 'DevRyan'),
          bunExecutable: writeFakeBun(join(root, 'option')),
        }),
      },
      {
        name: 'environment',
        prepare: (root, homeDir) => {
          const bunInstall = join(root, 'bun-install');
          const executable = writeFakeBun(join(bunInstall, 'bin'));
          return {
            homeDir,
            env: { PATH: '', BUN_INSTALL: bunInstall },
            currentExecutable: join(root, 'DevRyan'),
            expected: executable,
          };
        },
      },
      {
        name: 'current executable',
        prepare: (root, homeDir) => ({
          homeDir,
          env: { PATH: '' },
          currentExecutable: writeFakeBun(join(root, 'runtime')),
        }),
      },
      {
        name: 'user install',
        prepare: (root, homeDir) => ({
          homeDir,
          env: { PATH: '' },
          currentExecutable: join(root, 'DevRyan'),
          expected: writeFakeBun(join(homeDir, '.bun', 'bin')),
        }),
      },
    ];

    for (const entry of cases) {
      const root = makeTemporaryDirectory();
      const homeDir = join(root, 'home');
      const options = entry.prepare(root, homeDir);
      const expected = options.expected ?? options.bunExecutable ?? options.currentExecutable;
      const runCommand = vi.fn(async (_command, _args, commandOptions) => {
        writeInstalledPackage(commandOptions.cwd);
        return { ok: true, code: 0, stdout: '', stderr: '' };
      });
      const installer = createAgentBrowserInstaller({
        dataRoot: join(root, 'data'),
        platform: 'darwin',
        arch: 'arm64',
        runCommand,
        ...options,
      });

      const result = await installer.ensureInstalled();
      expect(result, entry.name).toMatchObject({ ok: true, bunExecutable: expected });
      expect(runCommand, entry.name).toHaveBeenCalledWith(
        expected,
        ['install', '--ignore-scripts'],
        expect.any(Object),
      );
    }
  });

  it('reports an actionable unavailable state when no validated Bun executable exists', async () => {
    const root = makeTemporaryDirectory();
    const runCommand = vi.fn();
    const installer = createAgentBrowserInstaller({
      dataRoot: join(root, 'data'),
      homeDir: join(root, 'home'),
      platform: 'darwin',
      arch: 'arm64',
      env: { PATH: '' },
      currentExecutable: join(root, 'DevRyan'),
      bunExecutable: join(root, 'missing-bun'),
      runCommand,
    });

    const unavailable = {
      ok: false,
      state: 'unavailable',
      bunExecutable: null,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'bun-unavailable', message: expect.stringContaining('BUN_INSTALL') }),
      ]),
    };
    await expect(installer.status()).resolves.toMatchObject(unavailable);
    await expect(installer.ensureInstalled()).resolves.toMatchObject(unavailable);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('rejects a non-Bun executable and falls through to the validated user install', async () => {
    const root = makeTemporaryDirectory();
    const invalidExecutable = join(root, 'invalid', 'bun');
    mkdirSync(dirname(invalidExecutable), { recursive: true });
    writeFileSync(invalidExecutable, '#!/bin/sh\nprintf \'not-bun\\n\'\n', 'utf8');
    chmodSync(invalidExecutable, 0o755);
    const homeDir = join(root, 'home');
    const expected = writeFakeBun(join(homeDir, '.bun', 'bin'));
    const runCommand = vi.fn(async (_command, _args, options) => {
      writeInstalledPackage(options.cwd);
      return { ok: true, code: 0, stdout: '', stderr: '' };
    });
    const installer = createAgentBrowserInstaller({
      dataRoot: join(root, 'data'),
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      env: { PATH: '' },
      currentExecutable: join(root, 'DevRyan'),
      bunExecutable: invalidExecutable,
      runCommand,
    });

    await expect(installer.ensureInstalled()).resolves.toMatchObject({
      ok: true,
      bunExecutable: expected,
    });
    expect(runCommand).toHaveBeenCalledWith(expected, ['install', '--ignore-scripts'], expect.any(Object));
  });

  it('probes the selected native binary version and reports failure or mismatch', async () => {
    const dataRoot = makeTemporaryDirectory();
    const bunExecutable = writeFakeBun(makeTemporaryDirectory());
    const installRoot = join(dataRoot, 'tools', 'agent-browser');
    mkdirSync(installRoot, { recursive: true });
    writeFileSync(join(installRoot, 'package.json'), `${JSON.stringify({
      dependencies: { 'agent-browser': AGENT_BROWSER_VERSION },
    })}\n`, 'utf8');
    writeInstalledPackage(installRoot);

    const mismatch = createAgentBrowserInstaller({
      dataRoot,
      platform: 'darwin',
      arch: 'arm64',
      bunExecutable,
      probeBinaryVersion: vi.fn(async () => ({ ok: true, version: '0.33.1' })),
    });
    await expect(mismatch.status()).resolves.toMatchObject({
      ok: false,
      state: 'invalid',
      binaryVersion: '0.33.1',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'binary-version-mismatch' }),
      ]),
    });

    const failed = createAgentBrowserInstaller({
      dataRoot,
      platform: 'darwin',
      arch: 'arm64',
      bunExecutable,
      probeBinaryVersion: vi.fn(async () => ({ ok: false, timedOut: true })),
    });
    await expect(failed.status()).resolves.toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'version-probe-failed' }),
      ]),
    });
  });

  it('bounds and terminates a hung installer subprocess', async () => {
    const result = await __test.runCommandDefault(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { env: process.env, timeoutMs: 10 },
    );
    expect(result).toMatchObject({ ok: false, timedOut: true });
  });
});

describe('managed agent-browser skill provisioning', () => {
  it.each([false, true])('delivers the bundled inspection guidance while preserving modified copies (modified: %s)', async (modified) => {
    const root = makeTemporaryDirectory();
    const options = {
      dataRoot: join(root, 'data'),
      homeDir: join(root, 'home'),
      managedElectron: true,
    };
    const previousSourcePath = join(root, 'previous-SKILL.md');
    writeFileSync(previousSourcePath, '---\nname: agent-browser\n---\n\nPrevious managed guidance\n', 'utf8');
    const previous = await provisionAgentBrowserSkill({ ...options, sourceSkillPath: previousSourcePath });
    expect(previous).toMatchObject({ ok: true, state: 'ready' });
    const previousManifest = readFileSync(previous.manifestPath, 'utf8');
    const userContent = '---\nname: agent-browser\n---\n\nUser browser workflow\n';
    if (modified) writeFileSync(previous.targetSkillPath, userContent, 'utf8');

    const result = await provisionAgentBrowserSkill(options);
    const bundledSource = readFileSync(new URL('./assets/agent-browser/SKILL.md', import.meta.url), 'utf8');
    expect(bundledSource).toContain('command: "inspect"');

    if (modified) {
      expect(result).toMatchObject({
        ok: false,
        state: 'conflict',
        changed: false,
        conflicts: [{ code: 'user-modified-skill', path: previous.targetSkillPath }],
      });
      expect(readFileSync(previous.targetSkillPath, 'utf8')).toBe(userContent);
      expect(readFileSync(previous.manifestPath, 'utf8')).toBe(previousManifest);
      return;
    }

    expect(result).toMatchObject({ ok: true, state: 'ready', changed: true, conflicts: [] });
    expect(readFileSync(result.targetSkillPath, 'utf8')).toBe(bundledSource);
    expect(JSON.parse(readFileSync(result.manifestPath, 'utf8'))).toMatchObject({
      managedHash: result.managedHash,
      sourceHash: result.managedHash,
      targetSkillPath: result.targetSkillPath,
    });
    expect(readFileSync(result.manifestPath, 'utf8')).not.toBe(previousManifest);
    await expect(provisionAgentBrowserSkill(options)).resolves.toMatchObject({ ok: true, changed: false });
  });

  it('installs, updates untouched copies, and no-ops when unchanged', async () => {
    const root = makeTemporaryDirectory();
    const dataRoot = join(root, 'data');
    const homeDir = join(root, 'home');
    const sourceSkillPath = join(root, 'source', 'SKILL.md');
    mkdirSync(dirname(sourceSkillPath), { recursive: true });
    writeFileSync(sourceSkillPath, '---\nname: agent-browser\ndescription: First\n---\n\nFirst\n', 'utf8');
    const options = { dataRoot, homeDir, sourceSkillPath, managedElectron: true };

    await expect(provisionAgentBrowserSkill(options)).resolves.toMatchObject({
      ok: true,
      state: 'ready',
      changed: true,
    });
    await expect(provisionAgentBrowserSkill(options)).resolves.toMatchObject({ changed: false });
    writeFileSync(sourceSkillPath, '---\nname: agent-browser\ndescription: Second\n---\n\nSecond\n', 'utf8');
    const updated = await provisionAgentBrowserSkill(options);
    expect(updated).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(updated.targetSkillPath, 'utf8')).toContain('Second');
  });

  it('preserves user-modified copies and skips non-managed runtimes', async () => {
    const root = makeTemporaryDirectory();
    const dataRoot = join(root, 'data');
    const homeDir = join(root, 'home');
    const sourceSkillPath = join(root, 'source', 'SKILL.md');
    mkdirSync(dirname(sourceSkillPath), { recursive: true });
    writeFileSync(sourceSkillPath, 'managed v1', 'utf8');
    const options = { dataRoot, homeDir, sourceSkillPath, managedElectron: true };
    const installed = await provisionAgentBrowserSkill(options);
    writeFileSync(installed.targetSkillPath, 'user edit', 'utf8');
    writeFileSync(sourceSkillPath, 'managed v2', 'utf8');

    const conflict = await provisionAgentBrowserSkill(options);
    expect(conflict).toMatchObject({ ok: false, state: 'conflict', changed: false });
    expect(readFileSync(installed.targetSkillPath, 'utf8')).toBe('user edit');

    const skippedRoot = makeTemporaryDirectory();
    const skipped = await provisionAgentBrowserSkill({
      dataRoot: join(skippedRoot, 'data'),
      homeDir: join(skippedRoot, 'home'),
      sourceSkillPath,
      managedElectron: false,
    });
    expect(skipped).toMatchObject({ ok: true, state: 'skipped', changed: false });
  });

  it('withdraws only an untouched manifest-owned skill and clears its ownership manifest', async () => {
    const root = makeTemporaryDirectory();
    const options = {
      dataRoot: join(root, 'data'),
      homeDir: join(root, 'home'),
      sourceSkillPath: join(root, 'source', 'SKILL.md'),
      managedElectron: true,
    };
    mkdirSync(dirname(options.sourceSkillPath), { recursive: true });
    writeFileSync(options.sourceSkillPath, 'managed skill', 'utf8');
    const installed = await provisionAgentBrowserSkill(options);

    const withdrawn = await withdrawAgentBrowserSkill(options);

    expect(withdrawn).toMatchObject({ ok: true, state: 'withdrawn', changed: true });
    expect(existsSync(installed.targetSkillPath)).toBe(false);
    expect(existsSync(installed.manifestPath)).toBe(false);
    await expect(withdrawAgentBrowserSkill(options)).resolves.toMatchObject({
      ok: true,
      state: 'absent',
      changed: false,
    });
  });

  it('preserves a modified skill during withdrawal and remains a no-op outside managed Electron', async () => {
    const root = makeTemporaryDirectory();
    const options = {
      dataRoot: join(root, 'data'),
      homeDir: join(root, 'home'),
      sourceSkillPath: join(root, 'source', 'SKILL.md'),
      managedElectron: true,
    };
    mkdirSync(dirname(options.sourceSkillPath), { recursive: true });
    writeFileSync(options.sourceSkillPath, 'managed skill', 'utf8');
    const installed = await provisionAgentBrowserSkill(options);
    writeFileSync(installed.targetSkillPath, 'user modification', 'utf8');

    await expect(withdrawAgentBrowserSkill(options)).resolves.toMatchObject({
      ok: false,
      state: 'conflict',
      changed: false,
      conflicts: [expect.objectContaining({ code: 'user-modified-skill' })],
    });
    expect(readFileSync(installed.targetSkillPath, 'utf8')).toBe('user modification');
    expect(existsSync(installed.manifestPath)).toBe(true);

    await expect(withdrawAgentBrowserSkill({ ...options, managedElectron: false })).resolves.toMatchObject({
      ok: true,
      state: 'skipped',
      changed: false,
    });
    expect(readFileSync(installed.targetSkillPath, 'utf8')).toBe('user modification');
  });
});
