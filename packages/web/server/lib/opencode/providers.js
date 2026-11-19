import {
  CONFIG_FILE,
  OPENCODE_CONFIG_DIR,
  getConfigPaths,
  listExistingConfigFiles,
  readConfigLayers,
  readConfigFile,
  isPlainObject,
  removeConfigKeyPaths,
} from './shared.js';
import { collapseRemovalKeyPaths } from './jsonc-config.js';
import { getAntigravityPluginGoogleModelKeyPaths } from './antigravity-retirement.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getProviderIntegrationLookupIds } from './provider-integrations.js';
import {
  DEVRYAN_MANAGED_PLUGIN_IDS,
  getDevRyanManagedPluginRegistrationForConfigPath,
} from './managed-plugins.js';

const CURSOR_ACP_PROVIDER_ID = 'cursor-acp';
const CURSOR_ACP_PLUGIN_NAME = getDevRyanManagedPluginRegistrationForConfigPath(
  DEVRYAN_MANAGED_PLUGIN_IDS.OPEN_CURSOR,
);
const CURSOR_ACP_DEFAULT_BASE_URL = 'http://127.0.0.1:32124/v1';
const CURSOR_ACP_PROXY_HEALTH_URL = 'http://127.0.0.1:32124/health';
const OFFICIAL_USER_CONFIG_FILE = path.join(OPENCODE_CONFIG_DIR, 'opencode.json');
const CURSOR_AGENT_COMPATIBILITY_PATH = path.join(os.homedir(), '.cursor-agent', 'cursor-agent');
const CURSOR_AGENT_SOURCE_PATHS = [
  path.join(os.homedir(), '.local', 'bin', 'cursor-agent'),
  CURSOR_AGENT_COMPATIBILITY_PATH,
  '/usr/local/bin/cursor-agent',
];
const CURSOR_ACP_SPAWN_PER_REQUEST_REASON = 'open-cursor starts cursor-agent for each model request. Without CURSOR_API_KEY, that helper may read Cursor app data for subscription auth, and macOS permissions are evaluated for the helper process rather than inherited from DevRyan.';
const CURSOR_ACP_API_KEY_REASON = 'CURSOR_API_KEY is configured, so cursor-agent can authenticate without reading Cursor app data.';
function normalizeProviderId(providerId) {
  return typeof providerId === 'string' ? providerId.trim().toLowerCase() : '';
}

function getProviderLookupIds(providerId) {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) {
    return [];
  }
  const providerIntegrationLookupIds = getProviderIntegrationLookupIds(normalized);
  if (providerIntegrationLookupIds.length > 1 || providerIntegrationLookupIds[0] !== normalized) {
    return providerIntegrationLookupIds;
  }
  return [normalized];
}

function hasAnyProviderConfig(config, providerIds) {
  const providers = isPlainObject(config?.provider) ? config.provider : {};
  const providersAlias = isPlainObject(config?.providers) ? config.providers : {};
  return providerIds.some((providerId) => (
    Object.prototype.hasOwnProperty.call(providers, providerId) ||
    Object.prototype.hasOwnProperty.call(providersAlias, providerId)
  ));
}

function hasAntigravityProviderConfig(config) {
  for (const containerKey of ['provider', 'providers']) {
    const container = isPlainObject(config?.[containerKey]) ? config[containerKey] : null;
    const google = isPlainObject(container?.google) ? container.google : null;
    const models = isPlainObject(google?.models) ? google.models : null;
    if (!models) continue;
    if (Object.keys(models).some((modelId) => isAntigravityModel(modelId, models[modelId]))) {
      return true;
    }
  }
  return false;
}

function getProviderSources(providerId, workingDirectory, options = {}) {
  const layers = readConfigLayers(workingDirectory);
  if (options.userConfigPath) {
    layers.paths.userPath = options.userConfigPath;
    layers.userConfig = readConfigFile(options.userConfigPath);
  }
  const { userConfig, projectConfig, customConfig, paths } = layers;
  const normalizedProviderId = normalizeProviderId(providerId);
  const providerLookupIds = getProviderLookupIds(providerId);
  const userConfigPaths = Array.isArray(options.userConfigPaths)
    ? options.userConfigPaths.filter((userPath) => typeof userPath === 'string' && userPath.trim())
    : null;
  const userCandidates = userConfigPaths
    ? userConfigPaths.map((userPath) => ({
      path: userPath,
      config: userPath === paths.userPath ? userConfig : readConfigFile(userPath),
    }))
    : options.userConfigPath
    ? [{ path: options.userConfigPath, config: userConfig }]
    : getConfigPaths(workingDirectory).userPaths.map((userPath) => ({
      path: userPath,
      config: userPath === paths.userPath ? userConfig : readConfigFile(userPath),
    }));

  const hasProviderSourceConfig = (config) => (
    normalizedProviderId === 'antigravity'
      ? hasAntigravityProviderConfig(config)
      : hasAnyProviderConfig(config, providerLookupIds)
  );
  const customExists = hasProviderSourceConfig(customConfig);
  // OpenCode merges every project config file, so detection scans all of them
  // (matching removal) rather than only the first one that exists.
  const projectSourcePath = workingDirectory
    ? listExistingConfigFiles(workingDirectory, 'project').find((projectPath) => (
      projectPath === paths.projectPath
        ? hasProviderSourceConfig(projectConfig)
        : hasProviderSourceConfig(readConfigFile(projectPath))
    ))
    : null;
  const projectExists = Boolean(projectSourcePath);
  const userProviderSource = userCandidates.find((candidate) => hasProviderSourceConfig(candidate.config));
  const userExists = Boolean(userProviderSource);

  return {
    sources: {
      auth: { exists: false },
      user: { exists: userExists, path: userProviderSource?.path || paths.userPath },
      project: { exists: projectExists, path: projectSourcePath || paths.projectPath || null },
      custom: { exists: customExists, path: paths.customPath },
    }
  };
}

function resolveCursorAgentExecutable(options = {}) {
  if (typeof options.cursorAgentExecutable === 'string' && options.cursorAgentExecutable.trim()) {
    return path.resolve(options.cursorAgentExecutable);
  }
  const sourcePaths = Array.isArray(options.cursorAgentSourcePaths) && options.cursorAgentSourcePaths.length > 0
    ? options.cursorAgentSourcePaths
    : CURSOR_AGENT_SOURCE_PATHS;
  const found = sourcePaths
    .map((candidate) => (typeof candidate === 'string' && candidate.trim() ? path.resolve(candidate) : null))
    .find((candidate) => candidate && fs.existsSync(candidate));
  return found || null;
}

function resolveActiveProviderSource(providerSources, officialUserConfigPath = OFFICIAL_USER_CONFIG_FILE) {
  const sources = isPlainObject(providerSources?.sources) ? providerSources.sources : {};
  const candidates = [
    ['custom', sources.custom],
    ['project', sources.project],
    ['user', sources.user],
  ];
  const match = candidates.find(([, source]) => isPlainObject(source) && source.exists === true);
  if (!match) {
    return {
      scope: null,
      path: null,
      secondaryUserConfigSuppliedProvider: false,
    };
  }
  const [scope, source] = match;
  const sourcePath = typeof source.path === 'string' && source.path.trim() ? path.resolve(source.path) : null;
  const officialPath = typeof officialUserConfigPath === 'string' && officialUserConfigPath.trim()
    ? path.resolve(officialUserConfigPath)
    : OFFICIAL_USER_CONFIG_FILE;
  return {
    scope,
    path: sourcePath,
    secondaryUserConfigSuppliedProvider: scope === 'user' && Boolean(sourcePath) && sourcePath !== officialPath,
  };
}


function resolveDefaultCursorAcpUserConfigPath(userConfigPath = null) {
  if (typeof userConfigPath === 'string' && userConfigPath.trim()) {
    return path.resolve(userConfigPath);
  }
  if (fs.existsSync(OFFICIAL_USER_CONFIG_FILE)) {
    return OFFICIAL_USER_CONFIG_FILE;
  }
  return readConfigLayers(null).paths.userPath || CONFIG_FILE;
}

function ensureDefaultCursorAcpProviderConfig(options = {}) {
  const targetPath = resolveDefaultCursorAcpUserConfigPath(options.userConfigPath);
  const targetConfig = readConfigFile(targetPath);
  return { changed: false, path: targetPath, config: targetConfig };
}

function normalizeCursorWorkspacePath(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return path.resolve(trimmed);
}

function areCursorWorkspacePathsEqual(left, right) {
  const normalizedLeft = normalizeCursorWorkspacePath(left);
  const normalizedRight = normalizeCursorWorkspacePath(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

async function fetchCursorAcpProxyHealth(options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      error: 'Fetch is unavailable.',
    };
  }

  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 1000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(CURSOR_ACP_PROXY_HEALTH_URL, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `Cursor proxy health returned ${response.status}.`,
      };
    }
    const payload = await response.json().catch(() => null);
    return {
      ok: payload?.ok === true,
      workspaceDirectory: typeof payload?.workspaceDirectory === 'string' ? payload.workspaceDirectory : null,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to read Cursor proxy health.',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function getCursorAcpRuntimeStatus(options = {}) {
  const platform = typeof options.platform === 'string' && options.platform
    ? options.platform
    : process.platform;
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;
  const apiKeyConfigured = typeof env.CURSOR_API_KEY === 'string' && env.CURSOR_API_KEY.trim().length > 0;
  const isMacos = platform === 'darwin';
  const expectedWorkspace = normalizeCursorWorkspacePath(options.expectedWorkspaceDirectory);
  const proxyHealth = options.proxyHealth && typeof options.proxyHealth === 'object'
    ? options.proxyHealth
    : null;
  const currentWorkspace = normalizeCursorWorkspacePath(proxyHealth?.workspaceDirectory);
  const workspaceMatches = Boolean(expectedWorkspace && currentWorkspace && areCursorWorkspacePathsEqual(expectedWorkspace, currentWorkspace));
  const workspaceMismatch = Boolean(expectedWorkspace && currentWorkspace && !workspaceMatches);
  const helperProcessPath = resolveCursorAgentExecutable(options);
  const activeProviderSource = resolveActiveProviderSource(options.providerSources, options.officialUserConfigPath);
  const runtimeOverlayPath = typeof options.runtimeOverlayConfigDirectory === 'string' && options.runtimeOverlayConfigDirectory.trim()
    ? path.resolve(options.runtimeOverlayConfigDirectory)
    : null;

  return {
    providerId: CURSOR_ACP_PROVIDER_ID,
    platform,
    apiKeyConfigured,
    authMode: apiKeyConfigured ? 'api-key' : 'cursor-app-data',
    activeConfig: {
      providerSource: activeProviderSource,
      runtimeOverlay: {
        path: runtimeOverlayPath,
      },
    },
    helperProcess: {
      name: 'cursor-agent',
      path: helperProcessPath,
    },
    bridge: {
      package: CURSOR_ACP_PLUGIN_NAME,
      baseURL: CURSOR_ACP_DEFAULT_BASE_URL,
      spawnsCursorAgentPerRequest: true,
    },
    appDataAccess: {
      readerProcess: 'cursor-agent',
      launchedBy: 'open-cursor via OpenCode',
      grantTarget: 'cursor-agent or the process named in the macOS prompt',
      devRyanFullDiskAccessMayNotApply: true,
    },
    performance: {
      coldStartLikely: true,
      reason: 'The Cursor bridge launches cursor-agent per model request, so first-token latency includes helper startup and Cursor auth handoff.',
    },
    cursorWorkspace: {
      expected: expectedWorkspace,
      current: currentWorkspace,
      matches: workspaceMatches,
      reachable: proxyHealth?.ok === true,
      error: typeof proxyHealth?.error === 'string' ? proxyHealth.error : null,
    },
    macosAppDataPrompt: {
      possible: isMacos,
      likelyRepeated: isMacos && (!apiKeyConfigured || workspaceMismatch),
      reason: isMacos && apiKeyConfigured
        ? CURSOR_ACP_API_KEY_REASON
        : CURSOR_ACP_SPAWN_PER_REQUEST_REASON,
    },
    recommendations: isMacos && !apiKeyConfigured
      ? [
          'Use a Cursor API key via CURSOR_API_KEY to avoid reading Cursor app data for CLI auth.',
          'If you stay on Cursor app-data auth, grant Full Disk Access to cursor-agent or the process macOS names in the prompt; DevRyan Full Disk Access alone may not cover the per-request helper.',
          'Use a signed packaged DevRyan.app instead of raw Electron during development so macOS can persist privacy grants.',
        ]
      : [],
  };
}

function ensureCursorAgentCompatibilityLink(options = {}) {
  const compatibilityPath = typeof options.compatibilityPath === 'string' && options.compatibilityPath.trim()
    ? path.resolve(options.compatibilityPath)
    : CURSOR_AGENT_COMPATIBILITY_PATH;
  const sourcePaths = Array.isArray(options.sourcePaths) && options.sourcePaths.length > 0
    ? options.sourcePaths
    : CURSOR_AGENT_SOURCE_PATHS;

  if (fs.existsSync(compatibilityPath)) {
    return {
      changed: false,
      path: compatibilityPath,
      source: compatibilityPath,
      reason: 'already-present',
    };
  }

  const sourcePath = sourcePaths
    .map((candidate) => (typeof candidate === 'string' && candidate.trim() ? path.resolve(candidate) : null))
    .find((candidate) => candidate && candidate !== compatibilityPath && fs.existsSync(candidate));

  if (!sourcePath) {
    return {
      changed: false,
      path: compatibilityPath,
      source: null,
      reason: 'source-missing',
    };
  }

  fs.mkdirSync(path.dirname(compatibilityPath), { recursive: true });
  fs.symlinkSync(sourcePath, compatibilityPath);
  return {
    changed: true,
    path: compatibilityPath,
    source: sourcePath,
    reason: 'linked',
  };
}

function listRemovalConfigFiles(workingDirectory, scope) {
  if (scope === 'project' && !workingDirectory) {
    throw new Error('Working directory is required for project scope');
  }
  return listExistingConfigFiles(workingDirectory, scope);
}

// Visits every config file of the scope (OpenCode merges all of them), removes
// what `getKeyPaths` selects, and returns the files that changed.
function removeFromScopeConfigFiles(workingDirectory, scope, getKeyPaths) {
  const changedPaths = [];
  for (const filePath of listRemovalConfigFiles(workingDirectory, scope)) {
    if (removeConfigKeyPaths(filePath, getKeyPaths(readConfigFile(filePath)))) {
      changedPaths.push(filePath);
    }
  }
  return changedPaths;
}

function getProviderConfigKeyPaths(config, providerLookupIds) {
  return ['provider', 'providers'].flatMap((containerKey) => (
    collapseRemovalKeyPaths(config, [containerKey], providerLookupIds)
  ));
}

function removeProviderConfig(providerId, workingDirectory, scope = 'user') {
  if (!providerId || typeof providerId !== 'string') {
    throw new Error('Provider ID is required');
  }

  const providerLookupIds = getProviderLookupIds(providerId);
  const changedPaths = removeFromScopeConfigFiles(
    workingDirectory,
    scope,
    (config) => getProviderConfigKeyPaths(config, providerLookupIds),
  );
  for (const changedPath of changedPaths) {
    console.log(`Removed provider ${providerId} from config: ${changedPath}`);
  }
  return changedPaths.length > 0;
}

function isAntigravityModel(modelId, model) {
  const name = isPlainObject(model) && typeof model.name === 'string' ? model.name : '';
  return modelId.startsWith('antigravity-') || /\s+\(Antigravity\)$/i.test(name);
}

// Antigravity is retired, so disconnecting it removes every model its plugin
// wrote under `provider.google` (Antigravity and Gemini CLI), not only the
// Antigravity-branded ones.
function removeAntigravityProviderConfig(workingDirectory, scope = 'user') {
  const changedPaths = removeFromScopeConfigFiles(
    workingDirectory,
    scope,
    getAntigravityPluginGoogleModelKeyPaths,
  );
  for (const changedPath of changedPaths) {
    console.log(`Removed Antigravity models from config: ${changedPath}`);
  }
  return changedPaths.length > 0;
}

// Every config file that still defines the provider, across user, project and
// custom layers. Used to verify a removal instead of assuming it worked.
function listProviderConfigFiles(providerId, workingDirectory) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const providerLookupIds = getProviderLookupIds(providerId);
  const definesProvider = (config) => (
    normalizedProviderId === 'antigravity'
      ? hasAntigravityProviderConfig(config)
      : hasAnyProviderConfig(config, providerLookupIds)
  );
  const scopes = workingDirectory ? ['user', 'project', 'custom'] : ['user', 'custom'];
  return scopes
    .flatMap((scope) => listExistingConfigFiles(workingDirectory, scope))
    .filter((filePath) => definesProvider(readConfigFile(filePath)));
}

export {
  CURSOR_ACP_DEFAULT_BASE_URL,
  CURSOR_ACP_PLUGIN_NAME,
  CURSOR_ACP_PROXY_HEALTH_URL,
  CURSOR_ACP_PROVIDER_ID,
  areCursorWorkspacePathsEqual,
  ensureCursorAgentCompatibilityLink,
  ensureDefaultCursorAcpProviderConfig,
  fetchCursorAcpProxyHealth,
  getCursorAcpRuntimeStatus,
  getProviderSources,
  listProviderConfigFiles,
  removeAntigravityProviderConfig,
  removeProviderConfig,
};
