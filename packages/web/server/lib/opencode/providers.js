import {
  CONFIG_FILE,
  OPENCODE_CONFIG_DIR,
  getConfigPaths,
  readConfigLayers,
  readConfigFile,
  isPlainObject,
  getConfigForPath,
  writeConfig,
} from './shared.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getProviderIntegrationLookupIds } from './provider-integrations.js';
import {
  ANTHROPIC_OAUTH_PLUGIN_PACKAGE,
  ANTHROPIC_OAUTH_PLUGIN_SPEC,
  isAnthropicOAuthPluginSpec,
  reconcileAnthropicOAuthPluginSpecs,
} from './anthropic-oauth-plugin.js';

const ANTHROPIC_OAUTH_PROVIDER_IDS = new Set([
  'anthropic',
  'claude',
  'anthropic-oauth',
  'opencode-with-claude',
]);
const ANTHROPIC_OAUTH_CONFIG_PROVIDER_ID = 'anthropic';
const ANTHROPIC_OAUTH_PLUGIN_NAME = ANTHROPIC_OAUTH_PLUGIN_PACKAGE;
const ANTHROPIC_OAUTH_DEFAULT_BASE_URL = 'http://127.0.0.1:3456';
const CURSOR_ACP_PROVIDER_ID = 'cursor-acp';
const CURSOR_ACP_PLUGIN_NAME = '@rama_nigg/open-cursor@latest';
const CURSOR_ACP_NPM_PROVIDER = '@ai-sdk/openai-compatible';
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
const CURSOR_ACP_FALLBACK_MODELS = {
  'cursor-acp/auto': { name: 'Auto' },
  'cursor-acp/claude-opus-4-7': { name: 'Claude 4.7 Opus' },
  'cursor-acp/claude-4.6-opus': { name: 'Claude 4.6 Opus' },
  'cursor-acp/claude-4.6-sonnet': { name: 'Claude 4.6 Sonnet' },
  'cursor-acp/claude-4.5-opus': { name: 'Claude 4.5 Opus' },
  'cursor-acp/claude-4.5-sonnet': { name: 'Claude 4.5 Sonnet' },
  'cursor-acp/claude-4.5-haiku': { name: 'Claude 4.5 Haiku' },
  'cursor-acp/claude-4-sonnet': { name: 'Claude 4 Sonnet' },
  'cursor-acp/gpt-5.5': { name: 'GPT-5.5' },
  'cursor-acp/gpt-5.4': { name: 'GPT-5.4' },
  'cursor-acp/gpt-5.4-mini': { name: 'GPT-5.4 Mini' },
  'cursor-acp/gpt-5.4-nano': { name: 'GPT-5.4 Nano' },
  'cursor-acp/gpt-5.3-codex': { name: 'GPT-5.3 Codex' },
  'cursor-acp/gpt-5.2': { name: 'GPT-5.2' },
  'cursor-acp/gpt-5.2-codex': { name: 'GPT-5.2 Codex' },
  'cursor-acp/gpt-5.1-codex': { name: 'GPT-5.1 Codex' },
  'cursor-acp/gpt-5.1-codex-max': { name: 'GPT-5.1 Codex Max' },
  'cursor-acp/gpt-5.1-codex-mini': { name: 'GPT-5.1 Codex Mini' },
  'cursor-acp/gpt-5-mini': { name: 'GPT-5 Mini' },
  'cursor-acp/gemini-3.1-pro': { name: 'Gemini 3.1 Pro' },
  'cursor-acp/gemini-3-pro': { name: 'Gemini 3 Pro' },
  'cursor-acp/gemini-3-flash': { name: 'Gemini 3 Flash' },
  'cursor-acp/composer-2.5': { name: 'Composer 2.5' },
  'cursor-acp/composer-2.5-fast': { name: 'Composer 2.5 Fast' },
  'cursor-acp/composer-2': { name: 'Composer 2' },
  'cursor-acp/composer-2-fast': { name: 'Composer 2 Fast' },
  'cursor-acp/composer-1.5': { name: 'Composer 1.5' },
  'cursor-acp/grok-4-20': { name: 'Grok 4.20' },
  'cursor-acp/kimi-k2.5': { name: 'Kimi K2.5' },
};

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
  if (ANTHROPIC_OAUTH_PROVIDER_IDS.has(normalized)) {
    return [normalized, ANTHROPIC_OAUTH_CONFIG_PROVIDER_ID];
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

function hasAnthropicOAuthPlugin(config) {
  const plugins = Array.isArray(config?.plugin) ? config.plugin : [];
  return plugins.some(isAnthropicOAuthPluginSpec);
}

function hasAnthropicOAuthOptions(config) {
  const providers = isPlainObject(config?.provider) ? config.provider : {};
  const anthropic = isPlainObject(providers[ANTHROPIC_OAUTH_CONFIG_PROVIDER_ID])
    ? providers[ANTHROPIC_OAUTH_CONFIG_PROVIDER_ID]
    : null;
  const options = isPlainObject(anthropic?.options) ? anthropic.options : {};
  if (options.apiKey !== 'dummy' || typeof options.baseURL !== 'string') {
    return false;
  }

  try {
    const url = new URL(options.baseURL);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && Boolean(url.port);
  } catch {
    return false;
  }
}

function hasAnthropicOAuthConfig(config, providerId) {
  const normalized = normalizeProviderId(providerId);
  if (!ANTHROPIC_OAUTH_PROVIDER_IDS.has(normalized)) {
    return false;
  }
  return hasAnthropicOAuthPlugin(config) && hasAnthropicOAuthOptions(config);
}

function getProviderSources(providerId, workingDirectory, options = {}) {
  const layers = readConfigLayers(workingDirectory);
  if (options.userConfigPath) {
    layers.paths.userPath = options.userConfigPath;
    layers.userConfig = readConfigFile(options.userConfigPath);
  }
  const { userConfig, projectConfig, customConfig, paths } = layers;
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

  const customExists = hasAnyProviderConfig(customConfig, providerLookupIds);
  const projectExists = hasAnyProviderConfig(projectConfig, providerLookupIds);
  const userProviderSource = userCandidates.find((candidate) => hasAnyProviderConfig(candidate.config, providerLookupIds));
  const userExists = Boolean(userProviderSource);
  const customAnthropicOAuthExists = hasAnthropicOAuthConfig(customConfig, providerId);
  const projectAnthropicOAuthExists = hasAnthropicOAuthConfig(projectConfig, providerId);
  const userAnthropicOAuthSource = userCandidates.find((candidate) => hasAnthropicOAuthConfig(candidate.config, providerId));
  const userAnthropicOAuthExists = Boolean(userAnthropicOAuthSource);

  return {
    sources: {
      auth: { exists: false },
      user: { exists: userExists, path: userProviderSource?.path || paths.userPath },
      project: { exists: projectExists, path: paths.projectPath || null },
      custom: { exists: customExists, path: paths.customPath },
      // Visible review note: this is deliberately separate from the normal provider source so Anthropic API-key configs are not mislabeled as the unofficial OAuth proxy path.
      anthropicOAuth: {
        exists: userAnthropicOAuthExists || projectAnthropicOAuthExists || customAnthropicOAuthExists,
        path: customAnthropicOAuthExists
          ? paths.customPath
          : projectAnthropicOAuthExists
            ? paths.projectPath || null
            : userAnthropicOAuthExists
              ? userAnthropicOAuthSource?.path || paths.userPath
              : null,
      },
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

function ensureAnthropicOAuthProviderConfig({
  workingDirectory = null,
  baseURL = ANTHROPIC_OAUTH_DEFAULT_BASE_URL,
} = {}) {
  const layers = readConfigLayers(workingDirectory);
  const targetPath = workingDirectory ? layers.paths.projectPath : layers.paths.userPath;
  const targetConfig = workingDirectory ? layers.projectConfig : layers.userConfig;

  const plugin = Array.isArray(targetConfig.plugin) ? [...targetConfig.plugin] : [];
  const nextPlugin = reconcileAnthropicOAuthPluginSpecs(plugin);

  const provider = isPlainObject(targetConfig.provider) ? targetConfig.provider : {};
  const existingAnthropic = isPlainObject(provider[ANTHROPIC_OAUTH_CONFIG_PROVIDER_ID])
    ? provider[ANTHROPIC_OAUTH_CONFIG_PROVIDER_ID]
    : {};
  const existingOptions = isPlainObject(existingAnthropic.options) ? existingAnthropic.options : {};
  const hadOAuthPlugin = hasAnthropicOAuthPlugin(targetConfig);
  const hadOAuthOptions = hasAnthropicOAuthOptions(targetConfig);
  const nextOptions = {
    ...existingOptions,
    baseURL,
    apiKey: 'dummy',
  };
  const nextAnthropic = {
    ...existingAnthropic,
    options: nextOptions,
  };
  const nextProvider = {
    ...provider,
    [ANTHROPIC_OAUTH_CONFIG_PROVIDER_ID]: nextAnthropic,
  };

  const changed =
    !hadOAuthPlugin ||
    plugin.length !== nextPlugin.length ||
    plugin.some((entry, index) => entry !== nextPlugin[index]) ||
    !hadOAuthOptions ||
    !Array.isArray(targetConfig.plugin) ||
    !isPlainObject(targetConfig.provider) ||
    !isPlainObject(provider[ANTHROPIC_OAUTH_CONFIG_PROVIDER_ID]) ||
    !isPlainObject(existingAnthropic.options) ||
    existingOptions.baseURL !== baseURL ||
    existingOptions.apiKey !== 'dummy';

  if (!changed) {
    return { changed: false, path: targetPath, config: targetConfig };
  }

  const nextConfig = {
    ...targetConfig,
    plugin: nextPlugin,
    provider: nextProvider,
  };
  writeConfig(nextConfig, targetPath || CONFIG_FILE);
  return { changed: true, path: targetPath, config: nextConfig };
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

function hasCursorAcpPlugin(config) {
  const plugins = Array.isArray(config?.plugin) ? config.plugin : [];
  return plugins.includes(CURSOR_ACP_PLUGIN_NAME);
}

function normalizeCursorModelName(model) {
  const name = isPlainObject(model) && typeof model.name === 'string' ? model.name : '';
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function formatCursorAcpClaudeFamilyName(family) {
  const normalized = String(family || '').toLowerCase();
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function normalizeCursorAcpClaudeVersionName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    return name;
  }

  return name.trim()
    .replace(/\bclaude\s+(\d+)[\s.]+(\d+)\s+(opus|sonnet|haiku)\b/gi, (_match, major, minor, family) => (
      `Claude ${major}.${minor} ${formatCursorAcpClaudeFamilyName(family)}`
    ))
    .replace(/\b(claude\s+)?(opus|sonnet|haiku)\s+(\d+)[\s.]+(\d+)\b/gi, (_match, claudePrefix, family, major, minor) => (
      `${claudePrefix ? 'Claude ' : ''}${formatCursorAcpClaudeFamilyName(family)} ${major}.${minor}`
    ));
}

function normalizeCursorAcpModelDisplayNames(models) {
  return Object.fromEntries(
    Object.entries(models).map(([modelId, model]) => {
      if (!isPlainObject(model) || typeof model.name !== 'string') {
        return [modelId, model];
      }

      const normalizedName = normalizeCursorAcpClaudeVersionName(model.name);
      return normalizedName === model.name
        ? [modelId, model]
        : [modelId, { ...model, name: normalizedName }];
    })
  );
}

function getCursorModelCompletenessScore(model) {
  if (!isPlainObject(model)) {
    return 0;
  }
  return (
    (isPlainObject(model.variants) ? 100 : 0) +
    (isPlainObject(model.options) ? 10 : 0) +
    (isPlainObject(model.cost) ? 5 : 0) +
    (typeof model.name === 'string' ? 1 : 0)
  );
}

function dedupeCursorAcpModelsByName(models) {
  const entries = Object.entries(models);
  const preferredByName = new Map();
  const keepIds = new Set();

  for (const [modelId, model] of entries) {
    const modelName = normalizeCursorModelName(model);
    if (!modelName) {
      keepIds.add(modelId);
      continue;
    }

    const current = preferredByName.get(modelName);
    const score = getCursorModelCompletenessScore(model);
    if (!current || score > current.score) {
      preferredByName.set(modelName, { modelId, score });
    }
  }

  for (const { modelId } of preferredByName.values()) {
    keepIds.add(modelId);
  }

  return Object.fromEntries(entries.filter(([modelId]) => keepIds.has(modelId)));
}

const CURSOR_ACP_MODEL_ID_PREFIX = 'cursor-acp/';
const CURSOR_ACP_FAST_TOKEN = 'fast';
const CURSOR_ACP_THINKING_TOKEN = 'thinking';
const CURSOR_ACP_VARIANT_ALIASES = new Map([
  ['none', 'none'],
  ['minimal', 'minimal'],
  ['min', 'minimal'],
  ['low', 'low'],
  ['medium', 'medium'],
  ['high', 'high'],
  ['xhigh', 'extra-high'],
  ['max', 'max'],
]);
const CURSOR_ACP_DEFAULT_VARIANT_ORDER = [
  'medium',
  'thinking-medium',
  'extra-high',
  'thinking-extra-high',
  'high',
  'thinking-high',
  'none',
  'max',
  'thinking-max',
  'low',
  'thinking-low',
  'minimal',
  'thinking-minimal',
  'thinking',
];

function normalizeCursorAcpVariantToken(token) {
  if (typeof token !== 'string') {
    return null;
  }
  return CURSOR_ACP_VARIANT_ALIASES.get(token.toLowerCase()) || null;
}

function popCursorAcpEffortToken(tokens, { allowMax = false } = {}) {
  if (tokens.length >= 2 && tokens[tokens.length - 2] === 'extra' && tokens[tokens.length - 1] === 'high') {
    tokens.pop();
    tokens.pop();
    return 'extra-high';
  }

  const last = tokens[tokens.length - 1];
  const normalized = normalizeCursorAcpVariantToken(last);
  if (!normalized) {
    return null;
  }

  if (normalized === 'max' && !allowMax) {
    return null;
  }

  tokens.pop();
  return normalized;
}

function parseCursorAcpVariantParts(value, { isModelId = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.includes('/')) {
    return null;
  }

  const tokens = value.split('-').filter(Boolean);
  if (tokens.length < (isModelId ? 2 : 1)) {
    return null;
  }

  const fast = tokens[tokens.length - 1] === CURSOR_ACP_FAST_TOKEN;
  if (fast) {
    tokens.pop();
  }

  let thinking = false;
  if (tokens[tokens.length - 1] === CURSOR_ACP_THINKING_TOKEN) {
    thinking = true;
    tokens.pop();
  }

  const effort = popCursorAcpEffortToken(tokens, { allowMax: !isModelId || value.startsWith('claude-') });
  if (tokens[tokens.length - 1] === CURSOR_ACP_THINKING_TOKEN) {
    thinking = true;
    tokens.pop();
  }

  if (!effort && !thinking) {
    return null;
  }

  const baseId = tokens.join('-');
  if (isModelId && !baseId) {
    return null;
  }

  const variantParts = [];
  if (thinking && effort) {
    variantParts.push(CURSOR_ACP_THINKING_TOKEN, effort);
  } else if (effort) {
    variantParts.push(effort);
  } else if (thinking) {
    variantParts.push(CURSOR_ACP_THINKING_TOKEN);
  }

  return {
    baseId,
    fast,
    effort,
    thinking,
    variantKey: variantParts.join('-') || undefined,
  };
}

function isCursorAcpThinkingVariantConfig(value) {
  const cursorModel = getCursorAcpSourceCursorModel(value, null);
  return typeof cursorModel === 'string' && cursorModel.includes(`-${CURSOR_ACP_THINKING_TOKEN}`);
}

function getCursorAcpSourceCursorModel(model, fallbackModelId) {
  const options = isPlainObject(model?.options) ? model.options : {};
  if (typeof options.cursorModel === 'string' && options.cursorModel.trim()) {
    return options.cursorModel;
  }
  if (typeof model?.cursorModel === 'string' && model.cursorModel.trim()) {
    return model.cursorModel;
  }
  return fallbackModelId;
}

function buildCursorAcpVariantConfig(model, cursorModel) {
  const variant = {};
  if (isPlainObject(model?.options)) {
    Object.assign(variant, model.options);
  }
  if (isPlainObject(model)) {
    for (const [key, value] of Object.entries(model)) {
      if (['name', 'options', 'variants'].includes(key)) {
        continue;
      }
      variant[key] = value;
    }
  }
  variant.cursorModel = cursorModel;
  return variant;
}

function getCursorAcpEffortLabel(effort) {
  if (!effort) {
    return null;
  }
  if (effort === 'extra-high') {
    return 'Extra High';
  }
  return effort
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function stripCursorAcpVariantLabel(name, parsed) {
  if (typeof name !== 'string' || !name.trim()) {
    return null;
  }

  let next = name;
  const effortLabel = getCursorAcpEffortLabel(parsed.effort);
  if (effortLabel) {
    next = next.replace(new RegExp(`\\s*\\(${effortLabel}\\)`, 'gi'), '');
    next = next.replace(new RegExp(`\\b${effortLabel}\\b`, 'gi'), '');
  }
  if (parsed.thinking) {
    next = next.replace(/\s*\(Thinking\)/gi, '');
    next = next.replace(/\bThinking\b/gi, '');
  }
  if (!parsed.fast) {
    next = next.replace(/\bFast\b/gi, '');
  }
  next = next.replace(/\s+/g, ' ').trim();
  return normalizeCursorAcpClaudeVersionName(next || name);
}

function buildCursorAcpFastModelName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) {
    return null;
  }
  return /\bFast\b/i.test(trimmed) ? trimmed : `${trimmed} Fast`;
}

function getCursorAcpPreferredVariantKey(variants) {
  if (!isPlainObject(variants)) {
    return null;
  }

  const variantKeys = Object.keys(variants);
  for (const key of CURSOR_ACP_DEFAULT_VARIANT_ORDER) {
    if (variantKeys.includes(key)) {
      return key;
    }
  }
  return variantKeys[0] || null;
}

function pruneCursorAcpEmptyVariants(model) {
  if (!isPlainObject(model) || !isPlainObject(model.variants) || Object.keys(model.variants).length > 0) {
    return model;
  }
  const { variants: _variants, ...rest } = model;
  return rest;
}

function mergeCursorAcpModel(target, source) {
  if (!isPlainObject(target)) {
    return { ...source };
  }
  return {
    ...source,
    ...target,
    options: {
      ...(isPlainObject(source.options) ? source.options : {}),
      ...(isPlainObject(target.options) ? target.options : {}),
    },
    variants: {
      ...(isPlainObject(source.variants) ? source.variants : {}),
      ...(isPlainObject(target.variants) ? target.variants : {}),
    },
  };
}

function upsertCursorAcpCollapsedVariant({
  models,
  createdModelIds,
  targetModelId,
  sourceModelId,
  sourceModel,
  variantKey,
  parsed,
}) {
  if (!targetModelId || !isPlainObject(sourceModel)) {
    return;
  }

  const cursorModel = getCursorAcpSourceCursorModel(sourceModel, sourceModelId);
  const existingTarget = isPlainObject(models[targetModelId]) ? models[targetModelId] : null;
  const cleanName = stripCursorAcpVariantLabel(sourceModel.name, parsed) || targetModelId;
  const visibleName = parsed.fast ? buildCursorAcpFastModelName(cleanName) || cleanName : cleanName;
  const sourceOptions = isPlainObject(sourceModel.options) ? sourceModel.options : {};
  const targetSeed = {
    ...sourceModel,
    name: visibleName,
    options: {
      ...sourceOptions,
      cursorModel,
    },
  };
  delete targetSeed.variants;

  const nextTarget = mergeCursorAcpModel(existingTarget, targetSeed);
  if (!existingTarget) {
    createdModelIds.add(targetModelId);
  }

  if (variantKey) {
    const existingVariant = isPlainObject(nextTarget.variants) ? nextTarget.variants[variantKey] : undefined;
    const nextVariant = buildCursorAcpVariantConfig(sourceModel, cursorModel);
    nextTarget.variants = {
      ...(isPlainObject(nextTarget.variants) ? nextTarget.variants : {}),
      [variantKey]: isCursorAcpThinkingVariantConfig(existingVariant) && !isCursorAcpThinkingVariantConfig(nextVariant)
        ? existingVariant
        : nextVariant,
    };
  }

  models[targetModelId] = pruneCursorAcpEmptyVariants(nextTarget);
}

function moveCursorAcpFastVariants(models, createdModelIds) {
  for (const [modelId, model] of Object.entries({ ...models })) {
    if (!isPlainObject(model) || !isPlainObject(model.variants) || modelId.includes('/')) {
      continue;
    }

    let changed = false;
    const nextVariants = { ...model.variants };
    for (const [variantKey, variantValue] of Object.entries(model.variants)) {
      const parsed = parseCursorAcpVariantParts(variantKey);
      if (!parsed) {
        continue;
      }

      const normalizedVariantKey = parsed.variantKey;
      if (parsed.fast && !modelId.endsWith('-fast')) {
        const targetModelId = `${modelId}-fast`;
        const cursorModel = getCursorAcpSourceCursorModel(variantValue, `${modelId}-${variantKey}`);
        const fastSource = {
          ...model,
          ...(isPlainObject(variantValue) ? variantValue : {}),
          name: buildCursorAcpFastModelName(model.name) || `${modelId} Fast`,
          options: {
            ...(isPlainObject(model.options) ? model.options : {}),
            cursorModel,
          },
        };
        delete fastSource.variants;
        upsertCursorAcpCollapsedVariant({
          models,
          createdModelIds,
          targetModelId,
          sourceModelId: cursorModel,
          sourceModel: fastSource,
          variantKey: normalizedVariantKey,
          parsed: { ...parsed, fast: true },
        });
        delete nextVariants[variantKey];
        changed = true;
      } else if (normalizedVariantKey && normalizedVariantKey !== variantKey) {
        const existingVariant = nextVariants[normalizedVariantKey];
        if (!Object.prototype.hasOwnProperty.call(nextVariants, normalizedVariantKey) || isCursorAcpThinkingVariantConfig(variantValue) || !isCursorAcpThinkingVariantConfig(existingVariant)) {
          nextVariants[normalizedVariantKey] = variantValue;
        }
        delete nextVariants[variantKey];
        changed = true;
      }
    }

    if (changed) {
      models[modelId] = pruneCursorAcpEmptyVariants({
        ...model,
        variants: nextVariants,
      });
    }
  }
}

function getCursorAcpLegacyClaudeAliasTarget(modelId) {
  const match = typeof modelId === 'string'
    ? modelId.match(/^(opus|sonnet|haiku)-(\d+(?:\.\d+)?)$/)
    : null;
  if (!match) {
    return null;
  }

  const [, family, version] = match;
  const displayFamily = family.charAt(0).toUpperCase() + family.slice(1);
  return {
    id: `claude-${version}-${family}`,
    name: `Claude ${version} ${displayFamily}`,
  };
}

function mergeCursorAcpLegacyClaudeAliases(models, createdModelIds) {
  for (const [modelId, model] of Object.entries({ ...models })) {
    const target = getCursorAcpLegacyClaudeAliasTarget(modelId);
    if (!target || !isPlainObject(model)) {
      continue;
    }

    const hadTarget = Object.prototype.hasOwnProperty.call(models, target.id);
    const existingTarget = isPlainObject(models[target.id]) ? models[target.id] : {};
    const sourceOptions = isPlainObject(model.options) ? model.options : {};
    const targetOptions = isPlainObject(existingTarget.options) ? existingTarget.options : {};
    const sourceVariants = isPlainObject(model.variants) ? model.variants : {};
    const targetVariants = isPlainObject(existingTarget.variants) ? existingTarget.variants : {};
    const sourceName = typeof model.name === 'string' && /\bClaude\b/i.test(model.name)
      ? model.name
      : target.name;
    const targetName = typeof existingTarget.name === 'string' && /\bClaude\b/i.test(existingTarget.name)
      ? existingTarget.name
      : sourceName;

    models[target.id] = pruneCursorAcpEmptyVariants({
      ...model,
      ...existingTarget,
      name: targetName,
      options: {
        ...sourceOptions,
        ...targetOptions,
      },
      variants: {
        ...sourceVariants,
        ...targetVariants,
      },
    });
    if (!hadTarget) {
      createdModelIds.add(target.id);
    }
    delete models[modelId];
  }
}

function finalizeCursorAcpCollapsedModels(models, createdModelIds) {
  for (const [modelId, model] of Object.entries({ ...models })) {
    if (!isPlainObject(model)) {
      continue;
    }

    let modelRecord = model;
    let variants = isPlainObject(modelRecord.variants) ? modelRecord.variants : null;
    if (variants) {
      const nextVariants = { ...variants };
      let removedRowAliases = false;
      for (const variantKey of Object.keys(variants)) {
        if (Object.prototype.hasOwnProperty.call(models, `${modelId}-${variantKey}`)) {
          delete nextVariants[variantKey];
          removedRowAliases = true;
        }
      }
      if (removedRowAliases) {
        modelRecord = pruneCursorAcpEmptyVariants({
          ...modelRecord,
          variants: nextVariants,
        });
        models[modelId] = modelRecord;
        variants = isPlainObject(modelRecord.variants) ? modelRecord.variants : null;
      }
    }

    if (variants && Object.prototype.hasOwnProperty.call(variants, 'fast') && Object.prototype.hasOwnProperty.call(models, `${modelId}-fast`)) {
      const { fast: _fast, ...restVariants } = variants;
      models[modelId] = pruneCursorAcpEmptyVariants({
        ...modelRecord,
        variants: restVariants,
      });
      continue;
    }

    const preferredVariantKey = getCursorAcpPreferredVariantKey(variants);
    if (!preferredVariantKey) {
      models[modelId] = pruneCursorAcpEmptyVariants(modelRecord);
      continue;
    }

    const preferredVariant = variants[preferredVariantKey];
    const cursorModel = getCursorAcpSourceCursorModel(preferredVariant, null);
    const options = isPlainObject(modelRecord.options) ? modelRecord.options : {};
    if ((createdModelIds.has(modelId) || !options.cursorModel) && cursorModel) {
      models[modelId] = {
        ...modelRecord,
        options: {
          ...options,
          cursorModel,
        },
      };
    } else {
      models[modelId] = pruneCursorAcpEmptyVariants(modelRecord);
    }
  }
}

function removeCursorAcpFallbackAliases(models) {
  const modelIds = new Set(Object.keys(models).filter((modelId) => !modelId.startsWith(CURSOR_ACP_MODEL_ID_PREFIX)));
  return Object.fromEntries(
    Object.entries(models).filter(([modelId]) => {
      if (!modelId.startsWith(CURSOR_ACP_MODEL_ID_PREFIX)) {
        return true;
      }
      return !modelIds.has(modelId.slice(CURSOR_ACP_MODEL_ID_PREFIX.length));
    })
  );
}

function collapseCursorAcpVariantModels(models) {
  const nextModels = { ...models };
  const collapsedModelIds = new Set();
  const createdModelIds = new Set();

  for (const [modelId, model] of Object.entries(models)) {
    const parsed = parseCursorAcpVariantParts(modelId, { isModelId: true });
    if (!parsed || !parsed.variantKey) {
      continue;
    }

    const targetModelId = parsed.fast ? `${parsed.baseId}-fast` : parsed.baseId;
    upsertCursorAcpCollapsedVariant({
      models: nextModels,
      createdModelIds,
      targetModelId,
      sourceModelId: modelId,
      sourceModel: model,
      variantKey: parsed.variantKey,
      parsed,
    });
    collapsedModelIds.add(modelId);
  }

  for (const modelId of collapsedModelIds) {
    delete nextModels[modelId];
  }

  moveCursorAcpFastVariants(nextModels, createdModelIds);
  mergeCursorAcpLegacyClaudeAliases(nextModels, createdModelIds);
  finalizeCursorAcpCollapsedModels(nextModels, createdModelIds);
  return removeCursorAcpFallbackAliases(dedupeCursorAcpModelsByName(nextModels));
}

function buildCursorAcpModels(existingModels) {
  const existing = normalizeCursorAcpModelDisplayNames(isPlainObject(existingModels) ? existingModels : {});
  const fallbackIds = new Set(Object.keys(CURSOR_ACP_FALLBACK_MODELS));
  const nonFallbackNames = new Set(
    Object.entries(existing)
      .filter(([modelId]) => !fallbackIds.has(modelId))
      .map(([, model]) => normalizeCursorModelName(model))
      .filter(Boolean)
  );

  const cleanedExisting = Object.fromEntries(
    Object.entries(existing).filter(([modelId, model]) => {
      if (!fallbackIds.has(modelId)) {
        return true;
      }

      const fallbackName = normalizeCursorModelName(CURSOR_ACP_FALLBACK_MODELS[modelId] || model);
      return !fallbackName || !nonFallbackNames.has(fallbackName);
    })
  );
  const existingNames = new Set(
    Object.values(cleanedExisting)
      .map((model) => normalizeCursorModelName(model))
      .filter(Boolean)
  );
  const fallbackModels = Object.fromEntries(
    Object.entries(CURSOR_ACP_FALLBACK_MODELS).filter(([modelId, model]) => {
      const modelName = normalizeCursorModelName(model);
      return !Object.prototype.hasOwnProperty.call(cleanedExisting, modelId) && !existingNames.has(modelName);
    })
  );

  return collapseCursorAcpVariantModels({
    ...dedupeCursorAcpModelsByName(fallbackModels),
    ...dedupeCursorAcpModelsByName(cleanedExisting),
  });
}

function buildDefaultCursorAcpProvider(existingProvider) {
  const existing = isPlainObject(existingProvider) ? existingProvider : {};
  const options = isPlainObject(existing.options) ? existing.options : {};
  const models = isPlainObject(existing.models) ? existing.models : {};
  const shouldSetDefaultName =
    !Object.prototype.hasOwnProperty.call(existing, 'name') ||
    existing.name === 'Cursor ACP';
  const nextOptions = {
    ...options,
    ...(!Object.prototype.hasOwnProperty.call(options, 'baseURL') ? { baseURL: CURSOR_ACP_DEFAULT_BASE_URL } : {}),
  };
  return {
    ...existing,
    ...(shouldSetDefaultName ? { name: 'Cursor' } : {}),
    ...(!Object.prototype.hasOwnProperty.call(existing, 'npm') ? { npm: CURSOR_ACP_NPM_PROVIDER } : {}),
    options: nextOptions,
    models: buildCursorAcpModels(models),
  };
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

function removeProviderConfig(providerId, workingDirectory, scope = 'user') {
  if (!providerId || typeof providerId !== 'string') {
    throw new Error('Provider ID is required');
  }

  const layers = readConfigLayers(workingDirectory);
  let targetPath = layers.paths.userPath;

  if (scope === 'project') {
    if (!workingDirectory) {
      throw new Error('Working directory is required for project scope');
    }
    targetPath = layers.paths.projectPath || targetPath;
  } else if (scope === 'custom') {
    if (!layers.paths.customPath) {
      return false;
    }
    targetPath = layers.paths.customPath;
  }

  const targetConfig = getConfigForPath(layers, targetPath);
  const providerConfig = isPlainObject(targetConfig.provider) ? targetConfig.provider : {};
  const providersConfig = isPlainObject(targetConfig.providers) ? targetConfig.providers : {};
  const providerLookupIds = getProviderLookupIds(providerId);
  const removedProvider = providerLookupIds.some((lookupId) => Object.prototype.hasOwnProperty.call(providerConfig, lookupId));
  const removedProviders = providerLookupIds.some((lookupId) => Object.prototype.hasOwnProperty.call(providersConfig, lookupId));

  if (!removedProvider && !removedProviders) {
    return false;
  }

  if (removedProvider) {
    for (const lookupId of providerLookupIds) {
      delete providerConfig[lookupId];
    }
    if (Object.keys(providerConfig).length === 0) {
      delete targetConfig.provider;
    } else {
      targetConfig.provider = providerConfig;
    }
  }

  if (removedProviders) {
    for (const lookupId of providerLookupIds) {
      delete providersConfig[lookupId];
    }
    if (Object.keys(providersConfig).length === 0) {
      delete targetConfig.providers;
    } else {
      targetConfig.providers = providersConfig;
    }
  }

  writeConfig(targetConfig, targetPath || CONFIG_FILE);
  console.log(`Removed provider ${providerId} from config: ${targetPath}`);
  return true;
}

export {
  ANTHROPIC_OAUTH_DEFAULT_BASE_URL,
  ANTHROPIC_OAUTH_PLUGIN_NAME,
  ANTHROPIC_OAUTH_PLUGIN_SPEC,
  CURSOR_ACP_DEFAULT_BASE_URL,
  CURSOR_ACP_PLUGIN_NAME,
  CURSOR_ACP_PROXY_HEALTH_URL,
  CURSOR_ACP_PROVIDER_ID,
  areCursorWorkspacePathsEqual,
  ensureCursorAgentCompatibilityLink,
  ensureDefaultCursorAcpProviderConfig,
  ensureAnthropicOAuthProviderConfig,
  fetchCursorAcpProxyHealth,
  getCursorAcpRuntimeStatus,
  getProviderSources,
  removeProviderConfig,
};
