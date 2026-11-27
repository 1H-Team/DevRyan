import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveDevRyanDataRoot } from '@devryan/shared-runtime/node/data-root.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// DevRyan ships only as the DMG on its GitHub releases page. `@devryan/web` on
// npm is not DevRyan's, so nothing here consults the npm registry or runs a
// package manager: update checks report the latest GitHub release and point to it.
const GITHUB_REPOSITORY_OWNER = '1H-Team';
const GITHUB_REPOSITORY_NAME = 'DevRyan';
const GITHUB_LATEST_RELEASE_API_URL =
  `https://api.github.com/repos/${GITHUB_REPOSITORY_OWNER}/${GITHUB_REPOSITORY_NAME}/releases/latest`;
const COMPATIBILITY_UPDATE_CHECK_URL = process.env.DEVRYAN_UPDATE_API_URL;
const UPDATE_CHECK_URL = COMPATIBILITY_UPDATE_CHECK_URL || GITHUB_LATEST_RELEASE_API_URL;
export const RELEASE_PAGE_URL =
  `https://github.com/${GITHUB_REPOSITORY_OWNER}/${GITHUB_REPOSITORY_NAME}/releases/latest`;
export const RELEASE_INSTALL_HINT = `DevRyan ships as a DMG. Download it from ${RELEASE_PAGE_URL} and open it.`;
const DEFAULT_UPDATE_CHECK_INTERVAL_SEC = 6 * 60 * 60;

function getDevRyanConfigDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) {
      // Windows is not migrated: keep an existing pre-rename folder in use.
      const legacy = path.join(appData, 'openchamber');
      return fs.existsSync(legacy) ? legacy : path.join(appData, 'devryan');
    }
  }

  return resolveDevRyanDataRoot({ env: {} });
}

function sanitizeInstallScope(scope) {
  if (scope === 'desktop-electron' || scope === 'desktop-tauri' || scope === 'web') return scope;
  return 'web';
}

function getOrCreateInstallId(scope = 'web') {
  const configDir = getDevRyanConfigDir();
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

/**
 * Report the latest published DevRyan release. Never installs anything.
 */
export async function checkForUpdates(options = {}) {
  const currentVersion = options.currentVersion || getCurrentVersion();

  if (currentVersion !== 'unknown') {
    const remote = await checkForUpdatesFromApi(currentVersion, options);
    if (remote) {
      return { ...remote, releaseUrl: RELEASE_PAGE_URL };
    }
  }

  return {
    available: false,
    currentVersion,
    releaseUrl: RELEASE_PAGE_URL,
    error: 'Unable to check DevRyan releases',
  };
}
