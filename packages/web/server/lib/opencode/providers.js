import {
  getConfigPaths,
  listExistingConfigFiles,
  readConfigLayers,
  readConfigFile,
  isPlainObject,
  removeConfigKeyPaths,
} from './shared.js';
import { collapseRemovalKeyPaths } from './jsonc-config.js';
import { getAntigravityPluginGoogleModelKeyPaths } from './antigravity-retirement.js';
import { getProviderIntegrationLookupIds } from './provider-integrations.js';

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
  getProviderSources,
  listProviderConfigFiles,
  removeAntigravityProviderConfig,
  removeProviderConfig,
};
