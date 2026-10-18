import path from 'node:path';

import {
  AGENT_SCOPE,
  OPENCODE_CONFIG_DIR,
  isPlainObject,
  mergeConfigs,
  readConfigFile,
  writeConfig,
} from './shared.js';

// Configuration of the built-in agent orchestration (derived from Oh My OpenCode
// Slim). It is always active; no plugin entry enables it.
const SLIM_SCOPE = 'slim';
const SLIM_CONFIG_BASENAME = 'oh-my-opencode-slim';
const DEFAULT_DISABLED_AGENTS = ['observer'];
const PROTECTED_AGENTS = new Set(['orchestrator', 'councillor']);
const SLIM_REPLACED_AGENT_NAMES = new Set([
  'builder',
  'council',
  'councillor',
  'designer',
  'explorer',
  'fixer',
  'librarian',
  'observer',
  'oracle',
  'orchestrator',
  'plan',
]);
const SUBAGENT_NAMES = new Set([
  'explorer',
  'librarian',
  'oracle',
  'designer',
  'fixer',
  'observer',
  'council',
  'councillor',
]);
const DEEP_MERGE_TOP_LEVEL_KEYS = [
  'agents',
  'tmux',
  'multiplexer',
  'interview',
  'backgroundJobs',
  'fallback',
  'council',
  'acpAgents',
  'companion',
];

const normalizeConfigDirectory = (options = {}) => {
  const configured = options.slimConfigDirectory
    || options.configDirectory
    || (options.userConfigPath ? path.dirname(options.userConfigPath) : undefined)
    || process.env.OPENCODE_CONFIG_DIR;
  return configured ? path.resolve(configured) : OPENCODE_CONFIG_DIR;
};

const findSlimConfigPath = (configDirectory) => {
  const jsoncPath = path.join(configDirectory, `${SLIM_CONFIG_BASENAME}.jsonc`);
  const jsonPath = path.join(configDirectory, `${SLIM_CONFIG_BASENAME}.json`);
  if (readConfigFile(jsoncPath) && Object.keys(readConfigFile(jsoncPath)).length > 0) {
    return jsoncPath;
  }
  if (readConfigFile(jsonPath) && Object.keys(readConfigFile(jsonPath)).length > 0) {
    return jsonPath;
  }
  return null;
};

const findProjectSlimConfigPath = (workingDirectory) => {
  if (!workingDirectory) return null;
  const base = path.join(workingDirectory, '.opencode', SLIM_CONFIG_BASENAME);
  const jsoncPath = `${base}.jsonc`;
  const jsonPath = `${base}.json`;
  if (Object.keys(readConfigFile(jsoncPath)).length > 0) return jsoncPath;
  if (Object.keys(readConfigFile(jsonPath)).length > 0) return jsonPath;
  return null;
};

const readSlimConfigFile = (filePath) => {
  if (!filePath) return {};
  const config = readConfigFile(filePath);
  return isPlainObject(config) ? config : {};
};

const mergePluginConfigs = (base, override) => {
  const merged = {
    ...(isPlainObject(base) ? base : {}),
    ...(isPlainObject(override) ? override : {}),
  };
  for (const key of DEEP_MERGE_TOP_LEVEL_KEYS) {
    merged[key] = mergeConfigs(
      isPlainObject(base?.[key]) ? base[key] : {},
      isPlainObject(override?.[key]) ? override[key] : {},
    );
    if (Object.keys(merged[key]).length === 0 && base?.[key] === undefined && override?.[key] === undefined) {
      delete merged[key];
    }
  }
  return merged;
};

const getPrimaryModelRef = (model) => {
  if (typeof model === 'string' && model.trim()) return model.trim();
  if (!Array.isArray(model)) return null;
  for (const entry of model) {
    if (typeof entry === 'string' && entry.trim()) return entry.trim();
    if (isPlainObject(entry) && typeof entry.id === 'string' && entry.id.trim()) {
      return entry.id.trim();
    }
  }
  return null;
};

const getModelRefs = (model) => {
  const values = Array.isArray(model) ? model : [model];
  return values
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      if (isPlainObject(entry) && typeof entry.id === 'string') return entry.id.trim();
      return '';
    })
    .filter(Boolean);
};

const getFirstModelVariant = (model) => {
  if (!Array.isArray(model)) return undefined;
  const first = model.find((entry) => isPlainObject(entry) && typeof entry.variant === 'string' && entry.variant.trim());
  return first?.variant?.trim();
};

const parseModelReference = (modelRef) => {
  if (typeof modelRef !== 'string') return undefined;
  const [providerID, ...modelParts] = modelRef.split('/');
  const modelID = modelParts.join('/');
  if (!providerID || !modelID) return undefined;
  return { providerID, modelID };
};

const resolveAgentMode = (name) => {
  if (name === 'orchestrator') return 'primary';
  if (name === 'council') return 'all';
  if (SUBAGENT_NAMES.has(name)) return 'subagent';
  return 'subagent';
};

const normalizeSlimAgent = (name, rawConfig, rootOverride, { activePreset = null, presetConfig = null } = {}) => {
  const config = isPlainObject(rawConfig) ? rawConfig : {};
  const modelRef = getPrimaryModelRef(config.model);
  const modelRefs = getModelRefs(config.model);
  const parsedModel = parseModelReference(modelRef);
  const root = isPlainObject(rootOverride) ? rootOverride : {};
  const preset = isPlainObject(presetConfig) ? presetConfig : {};
  const presetHadVariant = typeof preset.variant === 'string';
  const modelWasRootOverridden = Object.prototype.hasOwnProperty.call(root, 'model');
  const rootHasVariant = Object.prototype.hasOwnProperty.call(root, 'variant');
  const variantWasRootOverridden = Object.prototype.hasOwnProperty.call(root, 'variant')
    || (modelWasRootOverridden && presetHadVariant && !Object.prototype.hasOwnProperty.call(root, 'variant'));
  const variant = modelWasRootOverridden && presetHadVariant && !rootHasVariant
    ? undefined
    : (typeof config.variant === 'string'
      ? config.variant
      : getFirstModelVariant(config.model));

  const agent = {
    name,
    ...config,
    ...(parsedModel ? { model: parsedModel } : {}),
    ...(modelRefs.length > 0 ? { modelRefs } : {}),
    ...(variant ? { variant } : {}),
    mode: typeof config.mode === 'string' ? config.mode : resolveAgentMode(name),
    hidden: config.hidden === true || name === 'councillor',
    scope: SLIM_SCOPE,
    source: SLIM_SCOPE,
    native: true,
    builtIn: true,
    slim: true,
    modelResolution: {
      presetName: activePreset,
      source: modelWasRootOverridden || rootHasVariant
        ? 'root-override'
        : (activePreset && Object.keys(preset).length > 0 ? 'preset' : 'root'),
      presetModelRef: getPrimaryModelRef(preset.model),
      presetVariant: typeof preset.variant === 'string'
        ? preset.variant.trim() || null
        : (getFirstModelVariant(preset.model) || null),
    },
    overrides: {
      model: modelWasRootOverridden,
      variant: variantWasRootOverridden,
      councillors: false,
    },
  };
  if (!variant) {
    delete agent.variant;
  }
  return agent;
};

const getActivePresetName = (config, options = {}) => {
  const env = options.env || process.env;
  const envPreset = typeof env.OH_MY_OPENCODE_SLIM_PRESET === 'string' && env.OH_MY_OPENCODE_SLIM_PRESET.trim()
    ? env.OH_MY_OPENCODE_SLIM_PRESET.trim()
    : '';
  if (envPreset) return envPreset;
  return typeof config?.preset === 'string' && config.preset.trim() ? config.preset.trim() : null;
};

const getDisabledAgents = (config) => {
  const raw = Array.isArray(config?.disabled_agents) ? config.disabled_agents : DEFAULT_DISABLED_AGENTS;
  return new Set(raw.filter((name) => typeof name === 'string' && !PROTECTED_AGENTS.has(name)));
};

const buildEffectiveAgents = (config, activePreset) => {
  const presets = isPlainObject(config?.presets) ? config.presets : {};
  const presetAgents = activePreset && isPlainObject(presets[activePreset]) ? presets[activePreset] : {};
  const rootAgents = isPlainObject(config?.agents) ? config.agents : {};
  return mergeConfigs(presetAgents, rootAgents);
};

const normalizeSlimAgents = (config, activePreset) => {
  const effectiveAgents = buildEffectiveAgents(config, activePreset);
  const presets = isPlainObject(config?.presets) ? config.presets : {};
  const presetAgents = activePreset && isPlainObject(presets[activePreset]) ? presets[activePreset] : {};
  const rootAgents = isPlainObject(config?.agents) ? config.agents : {};
  const disabled = getDisabledAgents(config);
  const agents = {};
  for (const [name, rawAgent] of Object.entries(effectiveAgents)) {
    if (disabled.has(name) || !isPlainObject(rawAgent)) continue;
    agents[name] = normalizeSlimAgent(name, rawAgent, rootAgents[name], {
      activePreset,
      presetConfig: presetAgents[name],
    });
  }
  return agents;
};

const resolveSlimConfig = (workingDirectory, options = {}) => {
  const configDirectory = normalizeConfigDirectory(options);
  const userConfigPath = findSlimConfigPath(configDirectory);
  const projectConfigPath = findProjectSlimConfigPath(workingDirectory);
  const userConfig = readSlimConfigFile(userConfigPath);
  const projectConfig = readSlimConfigFile(projectConfigPath);
  const mergedConfig = mergePluginConfigs(userConfig, projectConfig);
  const activePreset = getActivePresetName(mergedConfig, options);
  const agents = normalizeSlimAgents(mergedConfig, activePreset);
  const agentNames = Object.keys(agents).sort((a, b) => a.localeCompare(b));

  return {
    configDirectory,
    userConfigPath,
    projectConfigPath,
    userConfig,
    projectConfig,
    mergedConfig,
    activePreset,
    agents,
    agentNames,
  };
};

const getSlimWritePath = (options = {}) => {
  const configDirectory = normalizeConfigDirectory(options);
  return findSlimConfigPath(configDirectory) || path.join(configDirectory, `${SLIM_CONFIG_BASENAME}.jsonc`);
};

const writeSlimAgentModelOverride = (agentName, override, options = {}) => {
  const targetPath = getSlimWritePath(options);
  const config = readSlimConfigFile(targetPath);
  const agents = isPlainObject(config.agents) ? { ...config.agents } : {};
  const existing = isPlainObject(agents[agentName]) ? { ...agents[agentName] } : {};
  if (Object.prototype.hasOwnProperty.call(override, 'model')) {
    existing.model = override.model;
  }
  if (Object.prototype.hasOwnProperty.call(override, 'variant')) {
    if (typeof override.variant === 'string') {
      existing.variant = override.variant;
    } else {
      delete existing.variant;
    }
  }
  agents[agentName] = existing;
  writeConfig({ ...config, agents }, targetPath);
  return override;
};

const deleteSlimAgentModelOverride = (agentName, options = {}) => {
  const targetPath = getSlimWritePath(options);
  const config = readSlimConfigFile(targetPath);
  const agents = isPlainObject(config.agents) ? { ...config.agents } : {};
  const existing = isPlainObject(agents[agentName]) ? { ...agents[agentName] } : null;
  if (!existing) {
    return false;
  }
  const hadModel = Object.prototype.hasOwnProperty.call(existing, 'model');
  const hadVariant = Object.prototype.hasOwnProperty.call(existing, 'variant');
  delete existing.model;
  delete existing.variant;

  if (Object.keys(existing).length === 0) {
    delete agents[agentName];
  } else {
    agents[agentName] = existing;
  }

  writeConfig({ ...config, agents }, targetPath);
  return hadModel || hadVariant;
};

export {
  SLIM_REPLACED_AGENT_NAMES,
  SLIM_SCOPE,
  deleteSlimAgentModelOverride,
  resolveSlimConfig,
  writeSlimAgentModelOverride,
};
