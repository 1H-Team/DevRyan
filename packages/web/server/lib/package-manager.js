import { execFile, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PACKAGE_NAME = '@openchamber/web';
const PACKAGE_PATH_SEGMENTS = PACKAGE_NAME.split('/');
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}`;
const GITHUB_REPOSITORY_OWNER = '1H-Team';
const GITHUB_REPOSITORY_NAME = 'DevRyan';
const GITHUB_LATEST_RELEASE_API_URL =
  `https://api.github.com/repos/${GITHUB_REPOSITORY_OWNER}/${GITHUB_REPOSITORY_NAME}/releases/latest`;
const COMPATIBILITY_UPDATE_CHECK_URL = process.env.OPENCHAMBER_UPDATE_API_URL;
const UPDATE_CHECK_URL = COMPATIBILITY_UPDATE_CHECK_URL || GITHUB_LATEST_RELEASE_API_URL;
const DEFAULT_UPDATE_CHECK_INTERVAL_SEC = 6 * 60 * 60;
let cachedDetectedPm = null;
let pendingDetectedPm = null;

function getSpawnSyncBaseOptions() {
  return process.platform === 'win32' ? { windowsHide: true } : {};
}
function getOpenChamberConfigDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) return path.join(appData, 'openchamber');
  }

  return path.join(os.homedir(), '.config', 'openchamber');
}

function sanitizeInstallScope(scope) {
  if (scope === 'desktop-electron' || scope === 'desktop-tauri' || scope === 'web') return scope;
  return 'web';
}

function getOrCreateInstallId(scope = 'web') {
  const configDir = getOpenChamberConfigDir();
  const normalizedScope = sanitizeInstallScope(scope);
  const idPath = path.join(configDir, `install-id-${normalizedScope}`);

  try {
    const existing = fs.readFileSync(idPath, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // Generate new id.
  }

  const installId = crypto.randomUUID();
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(idPath, `${installId}\n`, { encoding: 'utf8', mode: 0o600 });
  return installId;
}

function mapPlatform(value) {
  if (value === 'darwin') return 'macos';
  if (value === 'win32') return 'windows';
  if (value === 'linux') return 'linux';
  return 'web';
}

function mapArch(value) {
  if (value === 'arm64' || value === 'aarch64') return 'arm64';
  if (value === 'x64' || value === 'amd64') return 'x64';
  return 'unknown';
}

function normalizeAppType(value) {
  if (value === 'web' || value === 'desktop-electron' || value === 'desktop-tauri') return value;
  return 'web';
}

function normalizeDeviceClass(value) {
  if (value === 'mobile' || value === 'tablet' || value === 'desktop' || value === 'unknown') return value;
  return 'unknown';
}



async function checkForUpdatesFromGithub(currentVersion) {
  try {
    const response = await fetch(UPDATE_CHECK_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `DevRyan/${currentVersion}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;
    const data = await response.json();
    const latestVersion = typeof data?.tag_name === 'string'
      ? data.tag_name.trim().replace(/^v/, '')
      : '';
    if (!latestVersion) return null;

    return {
      available: compareVersions(latestVersion, currentVersion) > 0,
      version: latestVersion,
      currentVersion,
      body: typeof data.body === 'string' ? data.body : undefined,
      date: typeof data.published_at === 'string' ? data.published_at : undefined,
      nextSuggestedCheckInSec: DEFAULT_UPDATE_CHECK_INTERVAL_SEC,
    };
  } catch {
    return null;
  }
}

async function checkForUpdatesFromCompatibilityApi(currentVersion, options = {}) {
  try {
    const appType = normalizeAppType(options.appType);
    const hostPlatform = mapPlatform(process.platform);
    const hostArch = mapArch(process.arch);
    const platform = hostPlatform;
    const arch = hostArch;
    const payload = {
      appType,
      deviceClass: normalizeDeviceClass(options.deviceClass),
      platform,
      arch,
      channel: 'stable',
      currentVersion,
      installId: getOrCreateInstallId(appType),
      instanceMode: options.instanceMode || 'unknown',
      reportUsage: options.reportUsage !== false,
    };

    const response = await fetch(UPDATE_CHECK_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;
    const data = await response.json();
    if (typeof data?.latestVersion !== 'string') return null;

    const versionComparison = compareVersions(data.latestVersion, currentVersion);
    if (versionComparison < 0) return null;

    return {
      available: Boolean(data.updateAvailable) && versionComparison > 0,
      version: data.latestVersion,
      currentVersion,
      body: typeof data.releaseNotes === 'string' ? data.releaseNotes : undefined,
      nextSuggestedCheckInSec:
        typeof data.nextSuggestedCheckInSec === 'number' && Number.isFinite(data.nextSuggestedCheckInSec)
          ? data.nextSuggestedCheckInSec
          : undefined,
    };
  } catch {
    return null;
  }
}

async function checkForUpdatesFromApi(currentVersion, options = {}) {
  if (!COMPATIBILITY_UPDATE_CHECK_URL) {
    return checkForUpdatesFromGithub(currentVersion);
  }
  return checkForUpdatesFromCompatibilityApi(currentVersion, options);
}

function normalizePathForComparison(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const normalized = path.normalize(path.resolve(filePath));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function getComparablePaths(filePath) {
  const paths = new Set();
  const normalized = normalizePathForComparison(filePath);
  if (normalized) {
    paths.add(normalized);
  }

  try {
    const realPath = fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
    const normalizedRealPath = normalizePathForComparison(realPath);
    if (normalizedRealPath) {
      paths.add(normalizedRealPath);
    }
  } catch {
  }

  return paths;
}

function pathSetContains(a, b) {
  for (const value of a) {
    if (b.has(value)) {
      return true;
    }
  }
  return false;
}

function getCurrentPackagePath() {
  return path.resolve(__dirname, '..', '..');
}

function getPackagePathForGlobalRoot(rootPath) {
  if (!rootPath) return null;
  return path.join(rootPath, ...PACKAGE_PATH_SEGMENTS);
}

function getUniquePaths(paths) {
  const seen = new Set();
  const result = [];
  for (const value of paths) {
    const normalized = normalizePathForComparison(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(path.resolve(value));
  }
  return result;
}

function getCommandOutput(command, args) {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      ...getSpawnSyncBaseOptions(),
    });

    if (result.status !== 0) {
      return null;
    }

    const stdout = result.stdout.trim();
    return stdout || null;
  } catch {
    return null;
  }
}

function getGlobalBinDirs(pm) {
  const pmCommand = resolvePackageManagerCommand(pm);
  if (!isCommandAvailable(pmCommand)) {
    return [];
  }

  const dirs = [];
  switch (pm) {
    case 'pnpm': {
      const pnpmBin = getCommandOutput(pmCommand, ['bin', '-g']);
      if (pnpmBin) dirs.push(pnpmBin);
      const pnpmPrefix = getCommandOutput(pmCommand, ['prefix', '-g']);
      if (pnpmPrefix) dirs.push(process.platform === 'win32' ? pnpmPrefix : path.join(pnpmPrefix, 'bin'));
      break;
    }
    case 'yarn': {
      const yarnBin = getCommandOutput(pmCommand, ['global', 'bin']);
      if (yarnBin) dirs.push(yarnBin);
      break;
    }
    case 'bun': {
      const bunBin = getCommandOutput(pmCommand, ['pm', 'bin', '-g']);
      if (bunBin) dirs.push(bunBin);
      break;
    }
    default: {
      const npmPrefix = getCommandOutput(pmCommand, ['prefix', '-g']);
      if (npmPrefix) dirs.push(process.platform === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin'));
      break;
    }
  }

  return getUniquePaths(dirs);
}

function getGlobalNodeModulesRoots(pm) {
  try {
    const pmCommand = resolvePackageManagerCommand(pm);
    if (!isCommandAvailable(pmCommand)) {
      return [];
    }

    const roots = [];

    switch (pm) {
      case 'pnpm': {
        const pnpmRoot = getCommandOutput(pmCommand, ['root', '-g']);
        if (pnpmRoot) roots.push(pnpmRoot);
        const pnpmPrefix = getCommandOutput(pmCommand, ['prefix', '-g']);
        if (pnpmPrefix) roots.push(process.platform === 'win32' ? path.join(pnpmPrefix, 'node_modules') : path.join(pnpmPrefix, 'lib', 'node_modules'));
        break;
      }
      case 'yarn': {
        const yarnDir = getCommandOutput(pmCommand, ['global', 'dir']);
        if (yarnDir) roots.push(path.join(yarnDir, 'node_modules'));
        break;
      }
      case 'bun': {
        const bunBinDir = getCommandOutput(pmCommand, ['pm', 'bin', '-g']);
        if (bunBinDir) {
          roots.push(path.resolve(bunBinDir, '..', 'install', 'global', 'node_modules'));
          roots.push(path.resolve(bunBinDir, '..', '..', 'node_modules'));
        }
        break;
      }
      default:
      {
        const npmRoot = getCommandOutput(pmCommand, ['root', '-g']);
        if (npmRoot) roots.push(npmRoot);
        const npmPrefix = getCommandOutput(pmCommand, ['prefix', '-g']);
        if (npmPrefix) roots.push(process.platform === 'win32' ? path.join(npmPrefix, 'node_modules') : path.join(npmPrefix, 'lib', 'node_modules'));
        break;
      }
    }

    return getUniquePaths(roots);
  } catch {
    return [];
  }
}

function getOwnedPackagePathsFromGlobalBins(pm) {
  const packagePaths = [];
  for (const binDir of getGlobalBinDirs(pm)) {
    const binaryName = process.platform === 'win32' ? 'openchamber.cmd' : 'openchamber';
    const binaryPath = path.join(binDir, binaryName);
    if (!fs.existsSync(binaryPath)) continue;

    try {
      const realBinaryPath = fs.realpathSync.native ? fs.realpathSync.native(binaryPath) : fs.realpathSync(binaryPath);
      packagePaths.push(path.resolve(realBinaryPath, '..', '..'));
    } catch {
    }
  }

  return getUniquePaths(packagePaths);
}

function detectPackageManagerFromCurrentInstallPath() {
  return detectPackageManagerFromInstallPath(getCurrentPackagePath());
}

function packageManagerOwnsCurrentInstall(pm) {
  const currentPackagePaths = getComparablePaths(getCurrentPackagePath());
  const candidatePackagePaths = [
    ...getGlobalNodeModulesRoots(pm).map(getPackagePathForGlobalRoot),
    ...getOwnedPackagePathsFromGlobalBins(pm),
  ];

  for (const candidatePath of candidatePackagePaths) {
    if (!candidatePath) continue;
    if (pathSetContains(currentPackagePaths, getComparablePaths(candidatePath))) {
      return true;
    }
  }

  return false;
}

export function detectPackageManagerDetails() {
  // In desktop (Electron) runtime, package-manager detection is worthless —
  // the app ships as a .app bundle, not installed via npm/pnpm/yarn/bun, and
  // updates are handled by electron-updater. The detection path does up to a
  // dozen spawnSync(pm, ['bin', '-g']) calls with 10s timeouts each; under
  // the in-process server every one blocks the Electron main event loop and
  // manifests as a multi-second UI freeze. Short-circuit here.
  if (process.env.OPENCHAMBER_RUNTIME === 'desktop') {
    return {
      packageManager: 'electron',
      reason: 'desktop-runtime',
      packagePath: null,
      packageManagerCommand: null,
      globalNodeModulesRoot: null,
    };
  }

  if (cachedDetectedPm) {
      return {
        packageManager: cachedDetectedPm,
        reason: 'cached',
        packagePath: getCurrentPackagePath(),
        packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
        globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
      };
  }

  const forcedPm = process.env.OPENCHAMBER_PACKAGE_MANAGER?.trim();
  if (forcedPm && ['npm', 'pnpm', 'yarn', 'bun'].includes(forcedPm)) {
    const forcedPmCommand = resolvePackageManagerCommand(forcedPm);
    if (isCommandAvailable(forcedPmCommand)) {
      cachedDetectedPm = forcedPm;
      return {
        packageManager: cachedDetectedPm,
        reason: 'forced-env',
        packagePath: getCurrentPackagePath(),
        packageManagerCommand: forcedPmCommand,
        globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
      };
    }
  }

  // First prefer the package manager that demonstrably owns the current install.
  const installPathPm = detectPackageManagerFromCurrentInstallPath();
  if (installPathPm && packageManagerOwnsCurrentInstall(installPathPm)) {
    cachedDetectedPm = installPathPm;
    return {
      packageManager: cachedDetectedPm,
      reason: 'install-path-owner',
      packagePath: getCurrentPackagePath(),
      packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
      globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
    };
  }

  const ownershipCandidates = ['pnpm', 'yarn', 'bun', 'npm'];
  for (const candidate of ownershipCandidates) {
    if (packageManagerOwnsCurrentInstall(candidate)) {
      cachedDetectedPm = candidate;
      return {
        packageManager: cachedDetectedPm,
        reason: 'global-root-owner',
        packagePath: getCurrentPackagePath(),
        packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
        globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
      };
    }
  }

  // Fall back to weaker hints only when ownership cannot be established.
  const userAgent = process.env.npm_config_user_agent || '';
  let hintedPm = null;
  if (userAgent.startsWith('pnpm')) hintedPm = 'pnpm';
  else if (userAgent.startsWith('yarn')) hintedPm = 'yarn';
  else if (userAgent.startsWith('bun')) hintedPm = 'bun';
  else if (userAgent.startsWith('npm')) hintedPm = 'npm';

  // Check execpath.
  const execPath = process.env.npm_execpath || '';
  if (!hintedPm) {
    if (execPath.includes('pnpm')) hintedPm = 'pnpm';
    else if (execPath.includes('yarn')) hintedPm = 'yarn';
    else if (execPath.includes('bun')) hintedPm = 'bun';
    else if (execPath.includes('npm')) hintedPm = 'npm';
  }

  // Detect from invoked binary path.
  const invokedPm = detectPackageManagerFromInvocationPath(process.argv?.[1]);
  if (!hintedPm) {
    hintedPm = invokedPm;
  }

  if (!hintedPm) {
    hintedPm = installPathPm;
  }

  // Validate the hint against package visibility, but only after ownership checks failed.
  if (hintedPm && isCommandAvailable(resolvePackageManagerCommand(hintedPm)) && isPackageInstalledWith(hintedPm)) {
    cachedDetectedPm = hintedPm;
    return {
      packageManager: cachedDetectedPm,
      reason: 'hinted-visible-install',
      packagePath: getCurrentPackagePath(),
      packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
      globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
    };
  }

  const runtimePm = detectPackageManagerFromRuntimePath(process.execPath);
  if (runtimePm && isCommandAvailable(resolvePackageManagerCommand(runtimePm)) && isPackageInstalledWith(runtimePm)) {
    cachedDetectedPm = runtimePm;
    return {
      packageManager: cachedDetectedPm,
      reason: 'runtime-visible-install',
      packagePath: getCurrentPackagePath(),
      packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
      globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
    };
  }

  // Last resort: pick a PM that can at least see the package.
  const pmChecks = [
    { name: 'pnpm', check: () => isCommandAvailable(resolvePackageManagerCommand('pnpm')) },
    { name: 'yarn', check: () => isCommandAvailable(resolvePackageManagerCommand('yarn')) },
    { name: 'bun', check: () => isCommandAvailable(resolvePackageManagerCommand('bun')) },
    { name: 'npm', check: () => isCommandAvailable(resolvePackageManagerCommand('npm')) },
  ];

  for (const { name, check } of pmChecks) {
    if (check()) {
      // Verify this PM actually has the package installed globally
      if (isPackageInstalledWith(name)) {
        cachedDetectedPm = name;
        return {
          packageManager: cachedDetectedPm,
          reason: 'last-resort-visible-install',
          packagePath: getCurrentPackagePath(),
          packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
          globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
        };
      }
    }
  }

  cachedDetectedPm = 'npm';
  return {
    packageManager: cachedDetectedPm,
    reason: 'default-fallback',
    packagePath: getCurrentPackagePath(),
    packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
    globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
  };
}

export function detectPackageManager() {
  return detectPackageManagerDetails().packageManager;
}

// Update polling runs on the same event loop as prompt admission and SSE.
// Keep its probes asynchronous; CLI detection and update execution retain their
// synchronous APIs. Selection precedence matches detectPackageManagerDetails.
const runDetectionCommand = (command, args, timeout) => new Promise((resolve) => {
  try {
    execFile(command, args, {
      encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      ...getSpawnSyncBaseOptions(),
    }, (error, stdout) => resolve(error ? null : stdout));
  } catch {
    resolve(null);
  }
});

const isCommandAvailableAsync = async (command) => (
  await runDetectionCommand(command, ['--version'], 5000)
) !== null;

const getCommandOutputAsync = async (command, args) => (
  (await runDetectionCommand(command, args, 10000))?.trim() || null
);

async function resolvePackageManagerCommandAsync(pm) {
  for (const candidate of getPackageManagerCommandCandidates(pm)) {
    if (await isCommandAvailableAsync(candidate)) return candidate;
  }
  return pm;
}

async function getGlobalNodeModulesRootsAsync(pm) {
  const command = await resolvePackageManagerCommandAsync(pm);
  if (!await isCommandAvailableAsync(command)) return [];
  const roots = [];
  if (pm === 'pnpm' || pm === 'npm') {
    const root = await getCommandOutputAsync(command, ['root', '-g']);
    if (root) roots.push(root);
    const prefix = await getCommandOutputAsync(command, ['prefix', '-g']);
    if (prefix) roots.push(process.platform === 'win32'
      ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules'));
  } else if (pm === 'yarn') {
    const directory = await getCommandOutputAsync(command, ['global', 'dir']);
    if (directory) roots.push(path.join(directory, 'node_modules'));
  } else if (pm === 'bun') {
    const directory = await getCommandOutputAsync(command, ['pm', 'bin', '-g']);
    if (directory) {
      roots.push(path.resolve(directory, '..', 'install', 'global', 'node_modules'));
      roots.push(path.resolve(directory, '..', '..', 'node_modules'));
    }
  }
  return getUniquePaths(roots);
}

async function getGlobalBinDirsAsync(pm) {
  const command = await resolvePackageManagerCommandAsync(pm);
  if (!await isCommandAvailableAsync(command)) return [];
  const directories = [];
  if (pm === 'pnpm') {
    const directory = await getCommandOutputAsync(command, ['bin', '-g']);
    if (directory) directories.push(directory);
    const prefix = await getCommandOutputAsync(command, ['prefix', '-g']);
    if (prefix) directories.push(process.platform === 'win32' ? prefix : path.join(prefix, 'bin'));
  } else if (pm === 'yarn' || pm === 'bun') {
    const args = pm === 'yarn' ? ['global', 'bin'] : ['pm', 'bin', '-g'];
    const directory = await getCommandOutputAsync(command, args);
    if (directory) directories.push(directory);
  } else {
    const prefix = await getCommandOutputAsync(command, ['prefix', '-g']);
    if (prefix) directories.push(process.platform === 'win32' ? prefix : path.join(prefix, 'bin'));
  }
  return getUniquePaths(directories);
}

async function packageManagerOwnsCurrentInstallAsync(pm) {
  const current = getComparablePaths(getCurrentPackagePath());
  const candidates = (await getGlobalNodeModulesRootsAsync(pm)).map(getPackagePathForGlobalRoot);
  for (const binDirectory of await getGlobalBinDirsAsync(pm)) {
    const binaryName = process.platform === 'win32' ? 'openchamber.cmd' : 'openchamber';
    try {
      const binary = await fs.promises.realpath(path.join(binDirectory, binaryName));
      candidates.push(path.resolve(binary, '..', '..'));
    } catch {
      // Missing or inaccessible global command is not ownership evidence.
    }
  }
  return candidates.some((candidate) => candidate && pathSetContains(current, getComparablePaths(candidate)));
}

async function isPackageInstalledWithAsync(pm) {
  const command = await resolvePackageManagerCommandAsync(pm);
  const output = await runDetectionCommand(command, getPackageListArgs(pm), 10000);
  return output !== null && (output.includes(PACKAGE_NAME) || output.includes('openchamber'));
}

async function detectPackageManagerUncachedAsync() {
  const forced = process.env.OPENCHAMBER_PACKAGE_MANAGER?.trim();
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(forced)
    && await isCommandAvailableAsync(await resolvePackageManagerCommandAsync(forced))) return forced;

  const installPathPm = detectPackageManagerFromCurrentInstallPath();
  if (installPathPm && await packageManagerOwnsCurrentInstallAsync(installPathPm)) return installPathPm;
  for (const candidate of ['pnpm', 'yarn', 'bun', 'npm']) {
    if (await packageManagerOwnsCurrentInstallAsync(candidate)) return candidate;
  }

  const userAgent = process.env.npm_config_user_agent || '';
  const execPath = process.env.npm_execpath || '';
  let hint = ['pnpm', 'yarn', 'bun', 'npm'].find((pm) => userAgent.startsWith(pm));
  if (!hint) hint = ['pnpm', 'yarn', 'bun', 'npm'].find((pm) => execPath.includes(pm));
  hint ||= detectPackageManagerFromInvocationPath(process.argv?.[1]) || installPathPm;
  if (hint && await isCommandAvailableAsync(await resolvePackageManagerCommandAsync(hint))
    && await isPackageInstalledWithAsync(hint)) return hint;

  const runtime = detectPackageManagerFromRuntimePath(process.execPath);
  if (runtime && await isCommandAvailableAsync(await resolvePackageManagerCommandAsync(runtime))
    && await isPackageInstalledWithAsync(runtime)) return runtime;
  for (const candidate of ['pnpm', 'yarn', 'bun', 'npm']) {
    if (await isCommandAvailableAsync(await resolvePackageManagerCommandAsync(candidate))
      && await isPackageInstalledWithAsync(candidate)) return candidate;
  }
  return 'npm';
}

export async function detectPackageManagerAsync() {
  if (process.env.OPENCHAMBER_RUNTIME === 'desktop') return 'electron';
  if (cachedDetectedPm) return cachedDetectedPm;
  pendingDetectedPm ??= detectPackageManagerUncachedAsync().then((pm) => {
    cachedDetectedPm ??= pm;
    return cachedDetectedPm;
  }).finally(() => { pendingDetectedPm = null; });
  return pendingDetectedPm;
}

function detectPackageManagerFromInstallPath(pkgPath) {
  if (!pkgPath) return null;
  const normalized = pkgPath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.pnpm/') || normalized.includes('/pnpm/')) return 'pnpm';
  if (normalized.includes('/.yarn/')) return 'yarn';
  if (normalized.includes('/.bun/') || normalized.includes('/bun/install/')) return 'bun';
  if (normalized.includes('/node_modules/')) return 'npm';
  return null;
}

function detectPackageManagerFromRuntimePath(runtimePath) {
  if (!runtimePath || typeof runtimePath !== 'string') return null;
  const normalized = runtimePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.bun/bin/bun') || normalized.endsWith('/bun') || normalized.endsWith('/bun.exe')) {
    return 'bun';
  }
  if (normalized.includes('/pnpm/')) return 'pnpm';
  if (normalized.includes('/yarn/')) return 'yarn';
  if (normalized.includes('/node') || normalized.endsWith('/node.exe')) return 'npm';
  return null;
}

function detectPackageManagerFromInvocationPath(invokedPath) {
  if (!invokedPath || typeof invokedPath !== 'string') return null;
  const normalized = invokedPath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.bun/bin/')) return 'bun';
  if (normalized.includes('/.pnpm/')) return 'pnpm';
  if (normalized.includes('/.yarn/')) return 'yarn';
  return null;
}

function getPackageManagerCommandCandidates(pm) {
  const candidates = [];
  if (pm === 'bun') {
    const bunExecutable = process.platform === 'win32' ? 'bun.exe' : 'bun';
    if (process.env.BUN_INSTALL) {
      candidates.push(path.join(process.env.BUN_INSTALL, 'bin', bunExecutable));
    }
    if (process.env.HOME) {
      candidates.push(path.join(process.env.HOME, '.bun', 'bin', bunExecutable));
    }
    if (process.env.USERPROFILE) {
      candidates.push(path.join(process.env.USERPROFILE, '.bun', 'bin', bunExecutable));
    }
  }
  candidates.push(pm);
  return [...new Set(candidates.filter(Boolean))];
}

function resolvePackageManagerCommand(pm) {
  const candidates = getPackageManagerCommandCandidates(pm);
  for (const candidate of candidates) {
    if (isCommandAvailable(candidate)) {
      return candidate;
    }
  }
  return pm;
}

function quoteCommand(command) {
  if (!command) return command;
  if (!/\s/.test(command)) return command;
  if (process.platform === 'win32') {
    return `"${command.replace(/"/g, '""')}"`;
  }
  return `'${command.replace(/'/g, "'\\''")}'`;
}

function isCommandAvailable(command) {
  try {
    const result = spawnSync(command, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      ...getSpawnSyncBaseOptions(),
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function getPackageListArgs(pm) {
  switch (pm) {
    case 'pnpm':
      return ['list', '-g', '--depth=0', PACKAGE_NAME];
    case 'yarn':
      return ['global', 'list', '--depth=0'];
    case 'bun':
      return ['pm', 'ls', '-g'];
    default:
      return ['list', '-g', '--depth=0', PACKAGE_NAME];
  }
}

function isPackageInstalledWith(pm) {
  try {
    const pmCommand = resolvePackageManagerCommand(pm);

    const result = spawnSync(pmCommand, getPackageListArgs(pm), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      ...getSpawnSyncBaseOptions(),
    });

    if (result.status !== 0) return false;
    return result.stdout.includes(PACKAGE_NAME) || result.stdout.includes('openchamber');
  } catch {
    return false;
  }
}

/**
 * Get the update command for the detected package manager
 */
export function getUpdateCommand(pm = detectPackageManager()) {
  const pmCommand = quoteCommand(resolvePackageManagerCommand(pm));
  switch (pm) {
    case 'pnpm':
      return `${pmCommand} add -g ${PACKAGE_NAME}@latest`;
    case 'yarn':
      return `${pmCommand} global add ${PACKAGE_NAME}@latest`;
    case 'bun':
      return `${pmCommand} add -g ${PACKAGE_NAME}@latest`;
    default:
      return `${pmCommand} install -g ${PACKAGE_NAME}@latest`;
  }
}

/**
 * Get current installed version from package.json
 */
export function getCurrentVersion() {
  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Fetch latest version from npm registry
 */
export async function getLatestVersion() {
  try {
    const response = await fetch(NPM_REGISTRY_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Registry responded with ${response.status}`);
    }

    const data = await response.json();
    return data['dist-tags']?.latest || null;
  } catch (error) {
    return null;
  }
}

/**
 * Compare semver-like version strings.
 */
function compareVersions(left, right) {
  const a = String(left || '').replace(/^v/, '').split('.').map((part) => Number.parseInt(part || '0', 10));
  const b = String(right || '').replace(/^v/, '').split('.').map((part) => Number.parseInt(part || '0', 10));
  const length = Math.max(a.length, b.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }

  return 0;
}

export async function checkForUpdates(options = {}) {
  const currentVersion = options.currentVersion || getCurrentVersion();
  const pm = await detectPackageManagerAsync();
  const appType = normalizeAppType(options.appType);

  if (currentVersion !== 'unknown') {
    const remote = await checkForUpdatesFromApi(currentVersion, options);
    if (remote) {
      if (remote.available && appType === 'web') {
        const npmLatest = await getLatestVersion();
        if (!npmLatest || compareVersions(npmLatest, remote.version) < 0) {
          remote.available = false;
        }
      }
      return {
        ...remote,
        packageManager: pm,
        updateCommand: 'openchamber update',
      };
    }
  }

  if (!COMPATIBILITY_UPDATE_CHECK_URL) {
    return {
      available: false,
      currentVersion,
      error: 'Unable to check DevRyan releases',
    };
  }

  const latestVersion = await getLatestVersion();

  if (!latestVersion || currentVersion === 'unknown') {
    return {
      available: false,
      currentVersion,
      error: 'Unable to determine versions',
    };
  }

  const available = compareVersions(latestVersion, currentVersion) > 0;
  return {
    available,
    version: latestVersion,
    currentVersion,
    body: undefined,
    packageManager: pm,
    // Show our CLI command, not raw package manager command
    updateCommand: 'openchamber update',
  };
}

/**
 * Execute the update (used by CLI)
 */
export function executeUpdate(pm = detectPackageManager(), options = {}) {
  const command = getUpdateCommand(pm);
  if (!options?.silent) {
    console.log(`Updating ${PACKAGE_NAME} using ${pm}...`);
    console.log(`Running: ${command}`);
  }

  const result = spawnSync(command, {
    stdio: 'inherit',
    shell: true,
    ...getSpawnSyncBaseOptions(),
  });

  return {
    success: result.status === 0,
    exitCode: result.status,
  };
}
