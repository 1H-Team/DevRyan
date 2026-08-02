import crypto from 'node:crypto';
import { spawn as spawnChild } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_BROWSER_VERSION = '0.33.2';
export const AGENT_BROWSER_MANAGED_CONFIG_FILE = 'devryan-agent-browser.json';

const PACKAGE_NAME = 'agent-browser';
const SKILL_MANIFEST_VERSION = 1;
const DEFAULT_COMMAND_OUTPUT_BYTES = 64 * 1024;
const INSTALL_COMMAND_TIMEOUT_MS = 120_000;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const BUN_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_SKILL_SOURCE = fileURLToPath(
  new URL('./assets/agent-browser/SKILL.md', import.meta.url),
);

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readJson = (fsApi, filePath) => {
  try {
    const parsed = JSON.parse(fsApi.readFileSync(filePath, 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const writeFileAtomic = (fsApi, pathApi, filePath, content, mode) => {
  fsApi.mkdirSync(pathApi.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.devryan-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fsApi.writeFileSync(temporaryPath, content, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
    fsApi.renameSync(temporaryPath, filePath);
  } finally {
    try {
      if (fsApi.existsSync(temporaryPath)) fsApi.unlinkSync(temporaryPath);
    } catch {
    }
  }
};

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const detectMusl = () => {
  if (process.platform !== 'linux') return false;
  try {
    const report = process.report?.getReport?.();
    if (report?.header) return !report.header.glibcVersionRuntime;
  } catch {
  }
  return fs.existsSync('/etc/alpine-release')
    || fs.existsSync('/lib/ld-musl-x86_64.so.1')
    || fs.existsSync('/lib/ld-musl-aarch64.so.1');
};

export const resolveAgentBrowserBinaryName = ({
  platform = os.platform(),
  arch = os.arch(),
  musl = detectMusl(),
} = {}) => {
  const normalizedArch = arch === 'x86_64'
    ? 'x64'
    : arch === 'aarch64'
      ? 'arm64'
      : arch;
  if (normalizedArch !== 'x64' && normalizedArch !== 'arm64') return null;
  if (platform === 'darwin') return `agent-browser-darwin-${normalizedArch}`;
  if (platform === 'linux') return `agent-browser-${musl ? 'linux-musl' : 'linux'}-${normalizedArch}`;
  if (platform === 'win32') {
    return normalizedArch === 'x64' ? 'agent-browser-win32-x64.exe' : null;
  }
  return null;
};

const runCommandDefault = (command, args, options = {}) => new Promise((resolve) => {
  let child;
  try {
    child = spawnChild(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    resolve({ ok: false, code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
    return;
  }

  let settled = false;
  let stdout = '';
  let stderr = '';
  const append = (current, chunk) => {
    if (Buffer.byteLength(current) >= DEFAULT_COMMAND_OUTPUT_BYTES) return current;
    const remaining = DEFAULT_COMMAND_OUTPUT_BYTES - Buffer.byteLength(current);
    return current + Buffer.from(chunk).subarray(0, remaining).toString('utf8');
  };
  child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
  child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
  let forceKillTimer = null;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.trunc(options.timeoutMs)
    : INSTALL_COMMAND_TIMEOUT_MS;
  const cleanup = () => {
    clearTimeout(timeout);
    if (forceKillTimer) clearTimeout(forceKillTimer);
  };
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    try {
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 1_000);
      forceKillTimer.unref?.();
    } catch {
    }
    clearTimeout(timeout);
    resolve({ ok: false, code: null, stdout, stderr, timedOut: true });
  }, timeoutMs);
  timeout.unref?.();
  child.once('error', (error) => {
    if (settled) {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      return;
    }
    settled = true;
    cleanup();
    resolve({ ok: false, code: null, stdout, stderr: error instanceof Error ? error.message : String(error) });
  });
  child.once('close', (code) => {
    if (settled) {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      return;
    }
    settled = true;
    cleanup();
    resolve({ ok: code === 0, code, stdout, stderr, timedOut: false });
  });
});

const parseBinaryVersion = (value) => {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/);
  return match?.[1] ?? null;
};

const normalizeDataRoot = (dataRoot, pathApi, homeDir) => {
  const configured = typeof dataRoot === 'string' && dataRoot.trim()
    ? dataRoot.trim()
    : typeof process.env.OPENCHAMBER_DATA_DIR === 'string' && process.env.OPENCHAMBER_DATA_DIR.trim()
      ? process.env.OPENCHAMBER_DATA_DIR.trim()
      : pathApi.join(homeDir, '.config', 'openchamber');
  return pathApi.resolve(configured);
};

const collectBunExecutableCandidates = ({
  bunExecutable,
  currentExecutable,
  env,
  homeDir,
  pathApi,
  platform,
}) => {
  const executableName = platform === 'win32' ? 'bun.exe' : 'bun';
  const candidates = [];
  const seen = new Set();
  const add = (source, value) => {
    const candidate = typeof value === 'string' ? value.trim() : '';
    if (!candidate || !pathApi.isAbsolute(candidate)) return;
    const resolved = pathApi.resolve(candidate);
    const key = platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ source, path: resolved });
  };

  add('option', bunExecutable);
  add('environment', env.DEVRYAN_BUN_EXECUTABLE);
  add('environment', env.BUN_EXECUTABLE);
  if (typeof env.BUN_INSTALL === 'string' && env.BUN_INSTALL.trim() && pathApi.isAbsolute(env.BUN_INSTALL.trim())) {
    add('bun-install', pathApi.join(env.BUN_INSTALL.trim(), 'bin', executableName));
  }

  const currentBasename = typeof currentExecutable === 'string'
    ? pathApi.basename(currentExecutable).toLowerCase()
    : '';
  if (currentBasename === 'bun' || currentBasename === 'bun.exe') {
    add('current-executable', currentExecutable);
  }

  add('user-install', pathApi.join(homeDir, '.bun', 'bin', executableName));
  for (const key of ['HOME', 'USERPROFILE']) {
    const root = typeof env[key] === 'string' ? env[key].trim() : '';
    if (root && pathApi.isAbsolute(root)) {
      add('user-install', pathApi.join(root, '.bun', 'bin', executableName));
    }
  }

  const pathEntries = typeof env.PATH === 'string'
    ? env.PATH.split(pathApi.delimiter ?? path.delimiter)
    : [];
  for (const entry of pathEntries) {
    const root = entry.trim();
    if (root && pathApi.isAbsolute(root)) add('path', pathApi.join(root, executableName));
  }
  return candidates;
};

const isExecutableFile = ({ candidate, fsApi, platform }) => {
  try {
    if (!fsApi.existsSync(candidate)) return false;
    if (!fsApi.statSync(candidate).isFile()) return false;
    if (platform !== 'win32') {
      fsApi.accessSync(candidate, fsApi.constants?.X_OK ?? fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
};

const resolveBunExecutable = async ({
  candidates,
  fsApi,
  platform,
  probeBunExecutable,
}) => {
  const attempts = [];
  for (const candidate of candidates) {
    if (!isExecutableFile({ candidate: candidate.path, fsApi, platform })) {
      attempts.push({ ...candidate, reason: 'not-executable' });
      continue;
    }
    try {
      const probe = await probeBunExecutable(candidate.path);
      const version = normalizeVersion(probe?.version)
        ?? parseBinaryVersion(`${probe?.stdout ?? ''}\n${probe?.stderr ?? ''}`);
      if (probe?.ok && version) {
        return { ok: true, executable: candidate.path, source: candidate.source, version, attempts };
      }
      attempts.push({
        ...candidate,
        reason: probe?.timedOut ? 'probe-timeout' : 'invalid-version-output',
      });
    } catch {
      attempts.push({ ...candidate, reason: 'probe-failed' });
    }
  }
  return { ok: false, executable: null, source: null, version: null, attempts };
};

export const createAgentBrowserInstaller = (options = {}) => {
  const fsApi = options.fsApi ?? fs;
  const pathApi = options.pathApi ?? path;
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? os.platform();
  const arch = options.arch ?? os.arch();
  const musl = options.musl ?? (platform === 'linux' ? detectMusl() : false);
  const env = options.env ?? process.env;
  const log = options.log ?? console;
  const runCommand = options.runCommand ?? runCommandDefault;
  const currentExecutable = options.currentExecutable ?? process.execPath;
  const probeBunExecutable = options.probeBunExecutable ?? (async (candidate) => {
    const result = await runCommandDefault(candidate, ['--version'], {
      env,
      timeoutMs: BUN_PROBE_TIMEOUT_MS,
    });
    return {
      ...result,
      version: result.ok ? parseBinaryVersion(`${result.stdout}\n${result.stderr}`) : null,
    };
  });
  const probeBinaryVersion = options.probeBinaryVersion ?? (async (candidate) => {
    const result = await runCommandDefault(candidate, ['--version'], {
      env,
      timeoutMs: VERSION_PROBE_TIMEOUT_MS,
    });
    return {
      ...result,
      version: result.ok ? parseBinaryVersion(`${result.stdout}\n${result.stderr}`) : null,
    };
  });
  const dataRoot = normalizeDataRoot(options.dataRoot, pathApi, homeDir);
  const installRoot = pathApi.join(dataRoot, 'tools', 'agent-browser');
  const packageJsonPath = pathApi.join(installRoot, 'package.json');
  const configPath = pathApi.join(installRoot, AGENT_BROWSER_MANAGED_CONFIG_FILE);
  const installedPackageRoot = pathApi.join(installRoot, 'node_modules', PACKAGE_NAME);
  const installedPackageJsonPath = pathApi.join(installedPackageRoot, 'package.json');
  const binaryName = resolveAgentBrowserBinaryName({ platform, arch, musl });
  const binaryPath = pathApi.join(
    installedPackageRoot,
    'bin',
    binaryName ?? `agent-browser-unsupported-${platform}-${arch}`,
  );
  let mutationPromise = null;

  const resolveConfiguredBun = () => resolveBunExecutable({
    candidates: collectBunExecutableCandidates({
      bunExecutable: options.bunExecutable,
      currentExecutable,
      env,
      homeDir,
      pathApi,
      platform,
    }),
    fsApi,
    platform,
    probeBunExecutable,
  });

  const bunUnavailableIssue = () => ({
    code: 'bun-unavailable',
    message: `Bun is required to install agent-browser. Install it at ${pathApi.join(homeDir, '.bun', 'bin', platform === 'win32' ? 'bun.exe' : 'bun')}, set BUN_INSTALL, or set BUN_EXECUTABLE/DEVRYAN_BUN_EXECUTABLE to an absolute Bun executable.`,
  });

  const status = async () => {
    const issues = [];
    let binaryVersion = null;
    let bunExecutable = null;
    const rootManifest = readJson(fsApi, packageJsonPath);
    const managedConfig = readJson(fsApi, configPath);
    if (!managedConfig || Object.keys(managedConfig).length !== 0) {
      issues.push({
        code: managedConfig ? 'invalid-managed-config' : 'missing-managed-config',
        message: 'The managed agent-browser config must be an empty JSON object',
      });
    }
    const declaredVersion = normalizeVersion(rootManifest?.dependencies?.[PACKAGE_NAME]);
    if (declaredVersion !== AGENT_BROWSER_VERSION) {
      issues.push({
        code: declaredVersion ? 'dependency-version-mismatch' : 'missing-dependency',
        message: `Expected ${PACKAGE_NAME}@${AGENT_BROWSER_VERSION} in the managed install manifest`,
      });
    }

    const installedManifest = readJson(fsApi, installedPackageJsonPath);
    const installedVersion = normalizeVersion(installedManifest?.version);
    if (!installedManifest) {
      issues.push({ code: 'missing-package', message: 'The managed agent-browser package is not installed' });
    } else if (installedVersion !== AGENT_BROWSER_VERSION) {
      issues.push({
        code: 'version-mismatch',
        message: `Installed agent-browser version does not match ${AGENT_BROWSER_VERSION}`,
      });
    }

    if (!binaryName) {
      issues.push({
        code: 'unsupported-platform',
        message: `agent-browser does not provide a binary for ${platform}-${arch}`,
      });
    } else if (!fsApi.existsSync(binaryPath)) {
      issues.push({ code: 'missing-entrypoint', message: 'The managed platform binary is missing' });
    } else if (platform !== 'win32') {
      try {
        fsApi.accessSync(binaryPath, fsApi.constants?.X_OK ?? fs.constants.X_OK);
      } catch {
        issues.push({ code: 'not-executable', message: 'The managed platform binary is not executable' });
      }
    }

    const binaryCanBeProbed = Boolean(binaryName)
      && fsApi.existsSync(binaryPath)
      && !issues.some((issue) => issue.code === 'not-executable');
    if (binaryCanBeProbed) {
      try {
        const probe = await probeBinaryVersion(binaryPath, {
          env,
          timeoutMs: VERSION_PROBE_TIMEOUT_MS,
        });
        binaryVersion = normalizeVersion(probe?.version)
          ?? parseBinaryVersion(`${probe?.stdout ?? ''}\n${probe?.stderr ?? ''}`);
        if (!probe?.ok || !binaryVersion) {
          issues.push({
            code: 'version-probe-failed',
            message: probe?.timedOut
              ? 'The managed platform binary version check timed out'
              : 'The managed platform binary did not report a version',
          });
        } else if (binaryVersion !== AGENT_BROWSER_VERSION) {
          issues.push({
            code: 'binary-version-mismatch',
            message: `The managed platform binary reports ${binaryVersion}; expected ${AGENT_BROWSER_VERSION}`,
          });
        }
      } catch {
        issues.push({
          code: 'version-probe-failed',
          message: 'The managed platform binary version check failed',
        });
      }
    }

    const needsBunToRepair = Boolean(binaryName) && issues.some((issue) => ![
      'missing-managed-config',
      'invalid-managed-config',
    ].includes(issue.code));
    let bunUnavailable = false;
    if (needsBunToRepair) {
      const bun = await resolveConfiguredBun();
      bunExecutable = bun.executable;
      if (!bun.ok) {
        bunUnavailable = true;
        issues.push(bunUnavailableIssue());
      }
    }

    const ok = issues.length === 0;
    let state = installedManifest ? 'invalid' : 'missing';
    if (ok) state = 'ready';
    else if (issues.some((issue) => issue.code === 'unsupported-platform')) state = 'unsupported';
    else if (bunUnavailable) state = 'unavailable';
    return {
      ok,
      state,
      expectedVersion: AGENT_BROWSER_VERSION,
      installedVersion,
      binaryVersion,
      binaryPath,
      configPath,
      installRoot,
      bunExecutable,
      issues,
    };
  };

  const mutate = ({ repair = false } = {}) => {
    if (mutationPromise) return mutationPromise;
    mutationPromise = (async () => {
      const before = await status();
      if (before.state === 'unsupported') return before;
      if (before.ok && !repair) return { ...before, changed: false };

      try {
        const existing = readJson(fsApi, packageJsonPath) ?? {};
        const manifest = {
          ...existing,
          private: true,
          dependencies: {
            ...(isRecord(existing.dependencies) ? existing.dependencies : {}),
            [PACKAGE_NAME]: AGENT_BROWSER_VERSION,
          },
        };
        const nextManifest = `${JSON.stringify(manifest, null, 2)}\n`;
        const previousManifest = fsApi.existsSync(packageJsonPath)
          ? fsApi.readFileSync(packageJsonPath, 'utf8')
          : null;
        const manifestChanged = previousManifest !== nextManifest;
        if (manifestChanged) {
          writeFileAtomic(fsApi, pathApi, packageJsonPath, nextManifest);
        }
        const expectedConfig = '{}\n';
        const previousConfig = fsApi.existsSync(configPath)
          ? fsApi.readFileSync(configPath, 'utf8')
          : null;
        const configChanged = previousConfig !== expectedConfig;
        if (configChanged) {
          writeFileAtomic(fsApi, pathApi, configPath, expectedConfig);
        }
        const prepared = await status();
        if (prepared.ok && !repair) {
          return {
            ...prepared,
            changed: manifestChanged || configChanged,
          };
        }
        if (prepared.state === 'unavailable' && !prepared.bunExecutable) {
          return {
            ...prepared,
            repair,
            changed: manifestChanged || configChanged,
          };
        }

        const bun = prepared.bunExecutable
          ? { ok: true, executable: prepared.bunExecutable }
          : await resolveConfiguredBun();
        if (!bun.ok) {
          return {
            ...prepared,
            ok: false,
            state: 'unavailable',
            repair,
            changed: manifestChanged || configChanged,
            bunExecutable: null,
            issues: prepared.issues.some((issue) => issue.code === 'bun-unavailable')
              ? prepared.issues
              : [...prepared.issues, bunUnavailableIssue()],
          };
        }

        const args = ['install', '--ignore-scripts'];
        if (repair) args.push('--force');
        const command = await runCommand(bun.executable, args, {
          cwd: installRoot,
          env,
          timeoutMs: INSTALL_COMMAND_TIMEOUT_MS,
        });
        if (!command?.ok) {
          const failed = await status();
          return {
            ...failed,
            ok: false,
            state: 'error',
            repair,
            changed: manifestChanged || configChanged,
            bunExecutable: bun.executable,
            issues: [
              ...failed.issues,
              {
                code: 'bun-install-failed',
                message: command?.timedOut
                  ? 'bun install --ignore-scripts timed out'
                  : command?.stderr || command?.stdout || 'bun install --ignore-scripts failed',
              },
            ],
          };
        }

        if (binaryName && platform !== 'win32' && fsApi.existsSync(binaryPath)) {
          try {
            fsApi.chmodSync(binaryPath, 0o755);
          } catch (error) {
            log.warn?.('[AgentBrowser] Could not mark the managed binary executable:', error?.message ?? error);
          }
        }
        const after = await status();
        return {
          ...after,
          repair,
          changed: true,
          bunExecutable: bun.executable,
        };
      } catch (error) {
        const failed = await status().catch(() => ({
          ok: false,
          state: 'error',
          expectedVersion: AGENT_BROWSER_VERSION,
          installedVersion: null,
          binaryVersion: null,
          binaryPath,
          configPath,
          installRoot,
          issues: [],
        }));
        return {
          ...failed,
          ok: false,
          state: 'error',
          repair,
          issues: [
            ...failed.issues,
            {
              code: 'install-failed',
              message: error instanceof Error ? error.message : 'Managed agent-browser install failed',
            },
          ],
        };
      }
    })().finally(() => {
      mutationPromise = null;
    });
    return mutationPromise;
  };

  const install = () => mutate({ repair: false });
  const ensureInstalled = () => mutate({ repair: false });
  const repair = () => mutate({ repair: true });

  return {
    status,
    ensureInstalled,
    install,
    repair,
  };
};

export const __test = {
  INSTALL_COMMAND_TIMEOUT_MS,
  VERSION_PROBE_TIMEOUT_MS,
  BUN_PROBE_TIMEOUT_MS,
  collectBunExecutableCandidates,
  parseBinaryVersion,
  resolveBunExecutable,
  runCommandDefault,
};

function normalizeVersion(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^=/, '');
  return normalized || null;
}

export const provisionAgentBrowserSkill = async (options = {}) => {
  const fsApi = options.fsApi ?? fs;
  const pathApi = options.pathApi ?? path;
  const dataRoot = normalizeDataRoot(options.dataRoot, pathApi, options.homeDir ?? os.homedir());
  const homeDir = pathApi.resolve(options.homeDir ?? os.homedir());
  const sourceSkillPath = pathApi.resolve(options.sourceSkillPath ?? DEFAULT_SKILL_SOURCE);
  const targetSkillPath = pathApi.join(homeDir, '.agents', 'skills', 'agent-browser', 'SKILL.md');
  const manifestPath = pathApi.join(dataRoot, 'tools', 'agent-browser', 'skill-manifest.json');
  const baseResult = {
    targetSkillPath,
    sourceSkillPath,
    manifestPath,
  };
  if (options.managedElectron !== true) {
    return { ...baseResult, ok: true, state: 'skipped', changed: false, conflicts: [] };
  }

  try {
    const source = fsApi.readFileSync(sourceSkillPath, 'utf8');
    const sourceHash = sha256(source);
    const manifest = readJson(fsApi, manifestPath);
    const previousManagedHash = typeof manifest?.managedHash === 'string' ? manifest.managedHash : null;
    const targetExists = fsApi.existsSync(targetSkillPath);
    const target = targetExists ? fsApi.readFileSync(targetSkillPath, 'utf8') : null;
    const targetHash = target === null ? null : sha256(target);

    if (target !== null && targetHash !== sourceHash && targetHash !== previousManagedHash) {
      return {
        ...baseResult,
        ok: false,
        state: 'conflict',
        changed: false,
        conflicts: [{
          code: 'user-modified-skill',
          message: 'The existing agent-browser skill was modified and was preserved',
          path: targetSkillPath,
        }],
      };
    }

    let changed = false;
    if (targetHash !== sourceHash) {
      writeFileAtomic(fsApi, pathApi, targetSkillPath, source);
      changed = true;
    }
    const nextManifest = `${JSON.stringify({
      version: SKILL_MANIFEST_VERSION,
      managedHash: sourceHash,
      sourceHash,
      targetSkillPath,
    }, null, 2)}\n`;
    const previousManifest = fsApi.existsSync(manifestPath)
      ? fsApi.readFileSync(manifestPath, 'utf8')
      : null;
    if (previousManifest !== nextManifest) {
      writeFileAtomic(fsApi, pathApi, manifestPath, nextManifest);
      changed = true;
    }

    return {
      ...baseResult,
      ok: true,
      state: 'ready',
      changed,
      conflicts: [],
      managedHash: sourceHash,
    };
  } catch (error) {
    options.log?.warn?.('[AgentBrowser] Skill provisioning failed:', error?.message ?? error);
    return {
      ...baseResult,
      ok: false,
      state: 'error',
      changed: false,
      conflicts: [],
      issues: [{
        code: 'skill-provision-failed',
        message: error instanceof Error ? error.message : 'Agent browser skill provisioning failed',
      }],
    };
  }
};

export const withdrawAgentBrowserSkill = async (options = {}) => {
  const fsApi = options.fsApi ?? fs;
  const pathApi = options.pathApi ?? path;
  const dataRoot = normalizeDataRoot(options.dataRoot, pathApi, options.homeDir ?? os.homedir());
  const homeDir = pathApi.resolve(options.homeDir ?? os.homedir());
  const targetSkillPath = pathApi.join(homeDir, '.agents', 'skills', 'agent-browser', 'SKILL.md');
  const manifestPath = pathApi.join(dataRoot, 'tools', 'agent-browser', 'skill-manifest.json');
  const baseResult = { targetSkillPath, manifestPath };
  if (options.managedElectron !== true) {
    return { ...baseResult, ok: true, state: 'skipped', changed: false, conflicts: [] };
  }

  let changed = false;
  try {
    const targetExists = fsApi.existsSync(targetSkillPath);
    const manifestExists = fsApi.existsSync(manifestPath);
    if (!targetExists) {
      if (manifestExists) fsApi.unlinkSync(manifestPath);
      return {
        ...baseResult,
        ok: true,
        state: 'absent',
        changed: manifestExists,
        conflicts: [],
      };
    }

    const manifest = readJson(fsApi, manifestPath);
    const managedHash = typeof manifest?.managedHash === 'string' ? manifest.managedHash : null;
    const recordedTarget = typeof manifest?.targetSkillPath === 'string'
      ? pathApi.resolve(manifest.targetSkillPath)
      : null;
    const targetHash = sha256(fsApi.readFileSync(targetSkillPath, 'utf8'));
    if (!managedHash || recordedTarget !== targetSkillPath || targetHash !== managedHash) {
      return {
        ...baseResult,
        ok: false,
        state: 'conflict',
        changed: false,
        conflicts: [{
          code: 'user-modified-skill',
          message: 'The existing agent-browser skill is not an untouched managed copy and was preserved',
          path: targetSkillPath,
        }],
      };
    }

    fsApi.unlinkSync(targetSkillPath);
    changed = true;
    if (manifestExists) fsApi.unlinkSync(manifestPath);
    return {
      ...baseResult,
      ok: true,
      state: 'withdrawn',
      changed,
      conflicts: [],
    };
  } catch (error) {
    options.log?.warn?.('[AgentBrowser] Skill withdrawal failed:', error?.message ?? error);
    return {
      ...baseResult,
      ok: false,
      state: 'error',
      changed,
      conflicts: [],
      issues: [{
        code: 'skill-withdrawal-failed',
        message: error instanceof Error ? error.message : 'Agent browser skill withdrawal failed',
      }],
    };
  }
};
