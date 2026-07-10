import fs from 'fs';
import path from 'path';
import {
  AGENT_SCOPE,
  CONFIG_FILE,
  parseMdFile,
  readConfigFile,
  writeConfig,
} from './shared.js';
import { listPackagedAgents } from './packaged-agents.js';
import {
  applyOpenchamberSidecarToConfig,
  persistOpenchamberFromConfig,
} from './openchamber-sidecar.js';
import {
  SLIM_REPLACED_AGENT_NAMES,
  SLIM_SCOPE,
  deleteSlimAgentModelOverride,
  resolveSlimConfig,
  writeSlimAgentModelOverride,
} from './slim-config.js';

const PACKAGED_AGENT_SCOPE = 'packaged';
const AGENT_WRITE_DISABLED_MESSAGE = 'Agent configuration is read-only. Edit project .opencode/agents/*.md files directly.';
const OPENCHAMBER_CONFIG_KEY = 'openchamber';
const AGENT_OVERRIDES_CONFIG_KEY = 'agentOverrides';
const ALLOWED_AGENT_OVERRIDE_KEYS = new Set(['model', 'variant', 'councillors']);
const SLIM_DEFAULT_DISABLED_AGENTS = ['observer'];
const SLIM_PROTECTED_AGENTS = new Set(['orchestrator', 'councillor']);

// ============== AGENT SCOPE HELPERS ==============

/**
 * Ensure project-level agent directory exists.
 */
function ensureProjectAgentDir(workingDirectory) {
  const projectAgentDir = path.join(workingDirectory, '.opencode', 'agents');
  if (!fs.existsSync(projectAgentDir)) {
    fs.mkdirSync(projectAgentDir, { recursive: true });
  }
  return projectAgentDir;
}

/**
 * Get project-level agent path.
 */
function getProjectAgentPath(workingDirectory, agentName) {
  return path.join(workingDirectory, '.opencode', 'agents', `${agentName}.md`);
}

function getIndexedProjectAgentPath(workingDirectory, agentName) {
  const flatPath = getProjectAgentPath(workingDirectory, agentName);
  if (fs.existsSync(flatPath)) return flatPath;

  const agentDir = path.join(workingDirectory, '.opencode', 'agents');
  if (!fs.existsSync(agentDir)) return flatPath;

  const dirsToVisit = [agentDir];
  while (dirsToVisit.length > 0) {
    const dir = dirsToVisit.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirsToVisit.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name === `${agentName}.md`) {
        return entryPath;
      }
    }
  }

  return flatPath;
}

function parseModelReference(model) {
  if (typeof model !== 'string' || model.trim().length === 0) {
    return undefined;
  }

  const [providerID, ...modelParts] = model.split('/');
  const modelID = modelParts.join('/');
  if (!providerID || !modelID) {
    return undefined;
  }

  return { providerID, modelID };
}

function modelValueToRef(value) {
  if (typeof value === 'string') {
    return value.trim() || null;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const providerID = typeof value.providerID === 'string'
    ? value.providerID
    : (typeof value.providerId === 'string' ? value.providerId : '');
  const modelID = typeof value.modelID === 'string'
    ? value.modelID
    : (typeof value.modelId === 'string' ? value.modelId : '');

  return providerID && modelID ? `${providerID}/${modelID}` : null;
}

function normalizeModelRefs(model) {
  const values = Array.isArray(model) ? model : [model];
  return values
    .map(modelValueToRef)
    .filter(Boolean);
}

function applyParsedModelFields(target, rawModel) {
  const rawModelRefs = normalizeModelRefs(rawModel);
  const existingModelRefs = normalizeModelRefs(target.modelRefs);
  const modelRefs = existingModelRefs.length > 0 ? existingModelRefs : rawModelRefs;
  if (modelRefs.length === 0) return target;

  const parsedModel = parseModelReference(rawModelRefs[0] ?? modelRefs[0]);
  if (parsedModel) {
    target.model = parsedModel;
  }
  target.modelRefs = modelRefs;
  return target;
}

function applyOverrideModelFields(target, rawModel) {
  const modelRefs = normalizeModelRefs(rawModel);
  if (modelRefs.length === 0) return target;

  const parsedModel = parseModelReference(modelRefs[0]);
  if (parsedModel) {
    target.model = parsedModel;
  }
  target.modelRefs = modelRefs;
  return target;
}

function resolveUserConfigPath(options = {}) {
  return options.userConfigPath || CONFIG_FILE;
}

function getAgentOverridesContainer(config) {
  const openchamber = config?.[OPENCHAMBER_CONFIG_KEY];
  if (!openchamber || typeof openchamber !== 'object' || Array.isArray(openchamber)) {
    return {};
  }

  const overrides = openchamber[AGENT_OVERRIDES_CONFIG_KEY];
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return {};
  }

  return overrides;
}

function readUserConfig(options = {}) {
  const userConfigPath = resolveUserConfigPath(options);
  const raw = readConfigFile(userConfigPath);
  return applyOpenchamberSidecarToConfig(raw, userConfigPath);
}

function writeUserConfig(config, options = {}) {
  // Split: the `openchamber` subtree lives in DevRyan's sidecar (colocated with
  // the resolved user config path so tests stay isolated); everything else
  // writes back to the opencode config file. OpenCode 1.15+ rejects unknown
  // top-level keys, so we must never persist `openchamber` into its config.
  const userConfigPath = resolveUserConfigPath(options);
  const sanitized = persistOpenchamberFromConfig(config, userConfigPath);
  writeConfig(sanitized, userConfigPath);
}

function normalizeVariant(value) {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCouncillors(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('Council councillors override must be an array');
  }

  const councillors = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Council councillors must be objects');
    }
    const model = modelValueToRef(entry.model);
    if (!model) {
      throw new Error('Council councillor model must use provider/model format');
    }
    const councillor = { model };
    if (Object.prototype.hasOwnProperty.call(entry, 'variant')) {
      councillor.variant = normalizeVariant(entry.variant);
    }
    councillors.push(councillor);
  }
  return councillors;
}

function normalizeAgentModelOverride(rawOverride) {
  if (!rawOverride || typeof rawOverride !== 'object' || Array.isArray(rawOverride)) {
    throw new Error('Agent override must be an object');
  }

  for (const key of Object.keys(rawOverride)) {
    if (!ALLOWED_AGENT_OVERRIDE_KEYS.has(key)) {
      throw new Error('Only model, variant, and councillors can be overridden');
    }
  }

  const override = {};
  if (Object.prototype.hasOwnProperty.call(rawOverride, 'model')) {
    const model = modelValueToRef(rawOverride.model);
    if (!model) {
      throw new Error('Agent override model must use provider/model format');
    }
    override.model = model;
  }

  if (Object.prototype.hasOwnProperty.call(rawOverride, 'variant')) {
    override.variant = normalizeVariant(rawOverride.variant);
  }

  if (Object.prototype.hasOwnProperty.call(rawOverride, 'councillors')) {
    override.councillors = normalizeCouncillors(rawOverride.councillors);
  }

  if (!Object.prototype.hasOwnProperty.call(override, 'model')
    && !Object.prototype.hasOwnProperty.call(override, 'variant')
    && !Object.prototype.hasOwnProperty.call(override, 'councillors')) {
    throw new Error('Agent override must include model, variant, or councillors');
  }

  return override;
}

function listAgentModelOverrides(options = {}) {
  const config = readUserConfig(options);
  const overrides = getAgentOverridesContainer(config);
  const normalized = {};

  for (const [agentName, rawOverride] of Object.entries(overrides)) {
    try {
      normalized[agentName] = normalizeAgentModelOverride(rawOverride);
    } catch {
      // Ignore malformed user overrides so one bad entry does not hide agents.
    }
  }

  return normalized;
}

function listStaleAgentModelOverrides(workingDirectory, options = {}) {
  const knownNames = new Set(getBaseConfigAgents(workingDirectory, options).map((agent) => agent.name));
  return Object.keys(listAgentModelOverrides(options))
    .filter((agentName) => !knownNames.has(agentName))
    .sort((a, b) => a.localeCompare(b));
}

function applyAgentModelOverride(agent, override) {
  if (!override) {
    return {
      ...agent,
      overrides: {
        model: false,
        variant: false,
        councillors: false,
      },
    };
  }

  const next = {
    ...agent,
    overrides: {
      model: Object.prototype.hasOwnProperty.call(override, 'model'),
      variant: Object.prototype.hasOwnProperty.call(override, 'variant'),
      councillors: Array.isArray(override.councillors),
    },
  };

  if (Object.prototype.hasOwnProperty.call(override, 'model')) {
    applyOverrideModelFields(next, override.model);
  }

  if (Object.prototype.hasOwnProperty.call(override, 'variant')) {
    if (typeof override.variant === 'string') {
      next.variant = override.variant;
    } else {
      delete next.variant;
    }
  }

  if (Array.isArray(override.councillors)) {
    next.councillors = override.councillors.map((entry) => ({ ...entry }));
    next.modelRefs = override.councillors.map((entry) => entry.model);
  }

  return next;
}

function applyAgentModelOverrideToRuntimeFrontmatter(frontmatter, override) {
  if (!override) {
    return { ...frontmatter };
  }

  const next = { ...frontmatter };

  if (Object.prototype.hasOwnProperty.call(override, 'model')) {
    next.model = override.model;
    next.modelRefs = [override.model];
  }

  if (Object.prototype.hasOwnProperty.call(override, 'variant')) {
    if (typeof override.variant === 'string') {
      next.variant = override.variant;
    } else {
      delete next.variant;
    }
  }

  if (Array.isArray(override.councillors)) {
    next.councillors = override.councillors.map((entry) => ({ ...entry }));
    next.modelRefs = override.councillors.map((entry) => entry.model);
  }

  return next;
}

function getDevRyanBaseConfigAgents(workingDirectory) {
  const agentsByName = new Map();

  for (const agent of listPackagedConfigAgents()) {
    agentsByName.set(agent.name, agent);
  }

  for (const agent of listProjectAgents(workingDirectory)) {
    agentsByName.set(agent.name, agent);
  }

  return Array.from(agentsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function listManagedRuntimeAgentModelOverrides(workingDirectory, options = {}) {
  const overrides = { ...listAgentModelOverrides(options) };
  const slim = resolveSlimConfig(workingDirectory, options);
  if (!slim.wrapperPluginEnabled || slim.slimAgentCatalogEnabled) {
    return overrides;
  }

  const devRyanAgentNames = new Set(
    getDevRyanBaseConfigAgents(workingDirectory).map((agent) => agent.name),
  );
  for (const [agentName, slimAgent] of Object.entries(slim.agents)) {
    if (!devRyanAgentNames.has(agentName)) {
      continue;
    }

    const modelRef = normalizeModelRefs(slimAgent.modelRefs)[0]
      || modelValueToRef(slimAgent.model);
    const runtimeOverride = {
      ...(overrides[agentName] || {}),
      ...(modelRef ? { model: modelRef } : {}),
      variant: typeof slimAgent.variant === 'string' && slimAgent.variant.trim()
        ? slimAgent.variant.trim()
        : null,
    };
    overrides[agentName] = runtimeOverride;
  }

  return overrides;
}

function applySlimModelMetadata(agent, slimAgent) {
  if (!slimAgent) return agent;
  const next = {
    ...agent,
    overrides: {
      model: Boolean(slimAgent.overrides?.model),
      variant: Boolean(slimAgent.overrides?.variant),
      councillors: false,
    },
    slimRuntimeModel: true,
  };
  if (slimAgent.model) {
    next.model = slimAgent.model;
  }
  if (Array.isArray(slimAgent.modelRefs)) {
    next.modelRefs = [...slimAgent.modelRefs];
  }
  if (Object.prototype.hasOwnProperty.call(slimAgent, 'variant')) {
    next.variant = slimAgent.variant;
  } else {
    delete next.variant;
  }
  return next;
}

function getBaseConfigAgents(workingDirectory, options = {}) {
  const slim = resolveSlimConfig(workingDirectory, options);
  const slimAgents = getSlimConfigAgents(workingDirectory, options);
  if (slim.slimAgentCatalogEnabled && Object.keys(slimAgents).length > 0) {
    const agentsByName = new Map(Object.entries(slimAgents));
    for (const agent of listProjectAgents(workingDirectory)) {
      if (SLIM_REPLACED_AGENT_NAMES.has(agent.name)) {
        continue;
      }
      agentsByName.set(agent.name, agent);
    }
    return Array.from(agentsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  const agentsByName = new Map(getDevRyanBaseConfigAgents(workingDirectory).map((agent) => [agent.name, agent]));
  if (slim.pluginEnabled && !slim.slimAgentCatalogEnabled) {
    const runtimeSlimAgents = getSlimRuntimeModelAgents(workingDirectory, options);
    for (const [name, slimAgent] of Object.entries(runtimeSlimAgents)) {
      const existing = agentsByName.get(name);
      if (existing) {
        agentsByName.set(name, applySlimModelMetadata(existing, slimAgent));
      } else {
        agentsByName.set(name, slimAgent);
      }
    }
  }

  return Array.from(agentsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function getSlimDisabledAgentNames(config) {
  const raw = Array.isArray(config?.disabled_agents)
    ? config.disabled_agents
    : SLIM_DEFAULT_DISABLED_AGENTS;
  return new Set(raw.filter((name) => typeof name === 'string' && !SLIM_PROTECTED_AGENTS.has(name)));
}

function listSlimInstalledAgents(slim) {
  const agentRoot = path.join(slim.configDirectory, 'agents');
  const disabled = getSlimDisabledAgentNames(slim.mergedConfig);
  return listAgentsFromRoot(agentRoot, SLIM_SCOPE)
    .filter((agent) => (
      !disabled.has(agent.name)
      && (SLIM_REPLACED_AGENT_NAMES.has(agent.name) || Object.prototype.hasOwnProperty.call(slim.agents, agent.name))
    ))
    .map((agent) => ({
      ...agent,
      scope: SLIM_SCOPE,
      source: SLIM_SCOPE,
      native: true,
      builtIn: true,
      slim: true,
      overrides: {
        model: false,
        variant: false,
        councillors: false,
      },
    }));
}

function mergeSlimAgentLayers(installedAgent, configAgent) {
  if (!installedAgent) {
    return configAgent;
  }
  if (!configAgent) {
    return installedAgent;
  }

  const merged = {
    ...installedAgent,
    ...configAgent,
    prompt: configAgent.prompt ?? installedAgent.prompt,
  };
  if (installedAgent.__path) {
    Object.defineProperty(merged, '__path', { value: installedAgent.__path, enumerable: false });
  }
  return merged;
}

function getSlimAgentsFromResolvedConfig(slim) {
  if (!slim.pluginEnabled) return {};

  const agentsByName = new Map();
  for (const agent of listSlimInstalledAgents(slim)) {
    agentsByName.set(agent.name, agent);
  }
  for (const [name, configAgent] of Object.entries(slim.agents)) {
    agentsByName.set(name, mergeSlimAgentLayers(agentsByName.get(name), configAgent));
  }

  return Object.fromEntries(Array.from(agentsByName.entries()).sort(([a], [b]) => a.localeCompare(b)));
}

function getSlimConfigAgents(workingDirectory, options = {}) {
  const slim = resolveSlimConfig(workingDirectory, options);
  if (!slim.slimAgentCatalogEnabled) return {};

  return getSlimAgentsFromResolvedConfig(slim);
}

function getSlimRuntimeModelAgents(workingDirectory, options = {}) {
  const slim = resolveSlimConfig(workingDirectory, options);
  if (!slim.pluginEnabled || slim.slimAgentCatalogEnabled) return {};
  return getSlimAgentsFromResolvedConfig(slim);
}

function assertKnownAgentName(agentName, workingDirectory, options = {}) {
  const exists = getBaseConfigAgents(workingDirectory, options).some((agent) => agent.name === agentName);
  if (!exists) {
    throw new Error(`Agent "${agentName}" not found`);
  }
}

function writeAgentModelOverride(agentName, rawOverride, workingDirectory, options = {}) {
  const override = normalizeAgentModelOverride(rawOverride);
  const slimAgents = getSlimConfigAgents(workingDirectory, options);
  const slimRuntimeAgents = getSlimRuntimeModelAgents(workingDirectory, options);
  const slim = resolveSlimConfig(workingDirectory, options);
  const devRyanAgentExists = getDevRyanBaseConfigAgents(workingDirectory).some((agent) => agent.name === agentName);
  if (slimAgents[agentName] || slimRuntimeAgents[agentName] || (slim.pluginEnabled && devRyanAgentExists)) {
    return writeSlimAgentModelOverride(agentName, override, options);
  }

  assertKnownAgentName(agentName, workingDirectory, options);
  const config = readUserConfig(options);
  const openchamber = config[OPENCHAMBER_CONFIG_KEY] && typeof config[OPENCHAMBER_CONFIG_KEY] === 'object' && !Array.isArray(config[OPENCHAMBER_CONFIG_KEY])
    ? { ...config[OPENCHAMBER_CONFIG_KEY] }
    : {};
  const overrides = getAgentOverridesContainer(config);

  const nextConfig = {
    ...config,
    [OPENCHAMBER_CONFIG_KEY]: {
      ...openchamber,
      [AGENT_OVERRIDES_CONFIG_KEY]: {
        ...overrides,
        [agentName]: override,
      },
    },
  };

  writeUserConfig(nextConfig, options);
  return override;
}

function deleteAgentModelOverride(agentName, options = {}) {
  if (options.workingDirectory) {
    const slimAgents = getSlimConfigAgents(options.workingDirectory, options);
    const slimRuntimeAgents = getSlimRuntimeModelAgents(options.workingDirectory, options);
    const slim = resolveSlimConfig(options.workingDirectory, options);
    const devRyanAgentExists = getDevRyanBaseConfigAgents(options.workingDirectory).some((agent) => agent.name === agentName);
    if (slimAgents[agentName] || slimRuntimeAgents[agentName] || (slim.pluginEnabled && devRyanAgentExists)) {
      return deleteSlimAgentModelOverride(agentName, options);
    }
  }

  const config = readUserConfig(options);
  const openchamber = config[OPENCHAMBER_CONFIG_KEY] && typeof config[OPENCHAMBER_CONFIG_KEY] === 'object' && !Array.isArray(config[OPENCHAMBER_CONFIG_KEY])
    ? { ...config[OPENCHAMBER_CONFIG_KEY] }
    : {};
  const overrides = { ...getAgentOverridesContainer(config) };

  if (!Object.prototype.hasOwnProperty.call(overrides, agentName)) {
    return false;
  }

  delete overrides[agentName];
  const nextConfig = {
    ...config,
    [OPENCHAMBER_CONFIG_KEY]: {
      ...openchamber,
      [AGENT_OVERRIDES_CONFIG_KEY]: overrides,
    },
  };

  writeUserConfig(nextConfig, options);
  return true;
}

function parseAgentMdFile(filePath, scope, rootDir) {
  const { frontmatter, body } = parseMdFile(filePath);
  const agent = {
    name: path.basename(filePath, '.md'),
    ...frontmatter,
    ...(typeof body === 'string' && body.length > 0 ? { prompt: body } : {}),
    scope,
    source: scope,
    group: rootDir && path.dirname(filePath) !== rootDir
      ? path.relative(rootDir, path.dirname(filePath)).split(path.sep)[0]
      : undefined,
    native: scope === PACKAGED_AGENT_SCOPE,
    builtIn: scope === PACKAGED_AGENT_SCOPE,
  };

  Object.defineProperty(agent, '__path', { value: filePath, enumerable: false });
  applyParsedModelFields(agent, frontmatter.model);
  return agent;
}

function listAgentsFromRoot(agentRoot, scope) {
  const agentsByName = new Map();

  if (!fs.existsSync(agentRoot)) return [];

  const dirsToVisit = [agentRoot];
  while (dirsToVisit.length > 0) {
    const dir = dirsToVisit.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirsToVisit.push(entryPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

      const name = entry.name.slice(0, -3);
      if (agentsByName.has(name)) continue;
      agentsByName.set(name, parseAgentMdFile(entryPath, scope, agentRoot));
    }
  }

  return Array.from(agentsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function listPackagedConfigAgents() {
  return listPackagedAgents().map((agent) => {
    const configAgent = {
      name: agent.name,
      ...agent.frontmatter,
      ...(typeof agent.prompt === 'string' && agent.prompt.length > 0 ? { prompt: agent.prompt } : {}),
      scope: PACKAGED_AGENT_SCOPE,
      source: PACKAGED_AGENT_SCOPE,
      native: true,
      builtIn: true,
    };

    applyParsedModelFields(configAgent, agent.frontmatter.model);
    return configAgent;
  });
}

function listProjectAgents(workingDirectory) {
  if (!workingDirectory) return [];

  return listAgentsFromRoot(
    path.join(workingDirectory, '.opencode', 'agents'),
    AGENT_SCOPE.PROJECT,
  );
}

function listConfigAgents(workingDirectory, options = {}) {
  const overrides = listAgentModelOverrides(options);
  return getBaseConfigAgents(workingDirectory, options)
    .map((agent) => (agent.source === SLIM_SCOPE || agent.slimRuntimeModel
      ? agent
      : applyAgentModelOverride(agent, overrides[agent.name])))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getEffectivePackagedAgentRuntimeFrontmatter(agentName, frontmatter, options = {}) {
  const overrides = options.agentOverrides && typeof options.agentOverrides === 'object' && !Array.isArray(options.agentOverrides)
    ? options.agentOverrides
    : listAgentModelOverrides(options);
  return applyAgentModelOverrideToRuntimeFrontmatter(frontmatter, overrides[agentName]);
}

function getPackagedAgent(agentName) {
  return listPackagedAgents().find((agent) => agent.name === agentName) || null;
}

function getAgentScope(agentName, workingDirectory) {
  const slimAgents = getSlimConfigAgents(workingDirectory);
  if (slimAgents[agentName]) {
    return { scope: SLIM_SCOPE, path: slimAgents[agentName].__path || null };
  }

  if (workingDirectory) {
    const projectPath = getIndexedProjectAgentPath(workingDirectory, agentName);
    if (fs.existsSync(projectPath)) {
      return { scope: AGENT_SCOPE.PROJECT, path: projectPath };
    }
  }

  const packagedAgent = getPackagedAgent(agentName);
  if (packagedAgent) {
    return { scope: PACKAGED_AGENT_SCOPE, path: packagedAgent.path };
  }

  const slimRuntimeAgents = getSlimRuntimeModelAgents(workingDirectory);
  if (slimRuntimeAgents[agentName]) {
    return { scope: SLIM_SCOPE, path: slimRuntimeAgents[agentName].__path || null };
  }

  return { scope: null, path: null };
}

function getAgentSources(agentName, workingDirectory) {
  const slim = resolveSlimConfig(workingDirectory);
  const slimAgents = getSlimConfigAgents(workingDirectory);
  const slimAgent = slimAgents[agentName];
  if (slimAgent) {
    const mdPath = slimAgent.__path || null;
    const jsonPath = slim.projectConfigPath || slim.userConfigPath || null;
    return {
      md: {
        exists: Boolean(mdPath),
        path: mdPath,
        scope: mdPath ? SLIM_SCOPE : null,
        fields: mdPath ? Object.keys(parseMdFile(mdPath).frontmatter) : [],
      },
      json: {
        exists: Boolean(jsonPath),
        path: jsonPath,
        scope: SLIM_SCOPE,
        fields: ['model', 'variant'],
      },
      projectMd: {
        exists: false,
        path: null,
      },
      packagedMd: {
        exists: false,
        path: null,
      },
      userMd: {
        exists: false,
        path: null,
      },
    };
  }

  const projectPath = workingDirectory ? getIndexedProjectAgentPath(workingDirectory, agentName) : null;
  const projectExists = Boolean(projectPath && fs.existsSync(projectPath));
  const packagedAgent = getPackagedAgent(agentName);
  const packagedExists = Boolean(packagedAgent);
  const mdPath = projectExists ? projectPath : packagedAgent?.path || null;
  const mdScope = projectExists ? AGENT_SCOPE.PROJECT : (packagedExists ? PACKAGED_AGENT_SCOPE : null);

  const sources = {
    md: {
      exists: Boolean(mdPath),
      path: mdPath,
      scope: mdScope,
      fields: [],
    },
    json: {
      exists: false,
      path: null,
      scope: null,
      fields: [],
    },
    projectMd: {
      exists: projectExists,
      path: projectPath,
    },
    packagedMd: {
      exists: packagedExists,
      path: packagedAgent?.path || null,
    },
    userMd: {
      exists: false,
      path: null,
    },
  };

  if (sources.md.exists && mdPath) {
    const { frontmatter, body } = parseMdFile(mdPath);
    sources.md.fields = Object.keys(frontmatter);
    if (body) {
      sources.md.fields.push('prompt');
    }
  }

  if (sources.md.exists && slim.agents[agentName]) {
    sources.json = {
      exists: Boolean(slim.projectConfigPath || slim.userConfigPath),
      path: slim.projectConfigPath || slim.userConfigPath,
      scope: SLIM_SCOPE,
      fields: ['model', 'variant'],
    };
  }

  if (!sources.md.exists) {
    const slimRuntimeAgents = getSlimRuntimeModelAgents(workingDirectory);
    const slimRuntimeAgent = slimRuntimeAgents[agentName];
    if (slimRuntimeAgent) {
      const mdPath = slimRuntimeAgent.__path || null;
      const jsonPath = slim.projectConfigPath || slim.userConfigPath || null;
      return {
        md: {
          exists: Boolean(mdPath),
          path: mdPath,
          scope: mdPath ? SLIM_SCOPE : null,
          fields: mdPath ? Object.keys(parseMdFile(mdPath).frontmatter) : [],
        },
        json: {
          exists: Boolean(jsonPath),
          path: jsonPath,
          scope: SLIM_SCOPE,
          fields: ['model', 'variant'],
        },
        projectMd: { exists: false, path: null },
        packagedMd: { exists: false, path: null },
        userMd: { exists: false, path: null },
      };
    }
  }

  return sources;
}

function getAgentConfig(agentName, workingDirectory, options = {}) {
  const overrides = listAgentModelOverrides(options);
  const slimAgents = getSlimConfigAgents(workingDirectory, options);
  if (slimAgents[agentName]) {
    return {
      source: 'slim',
      scope: SLIM_SCOPE,
      config: slimAgents[agentName],
    };
  }
  const slimRuntimeAgents = getSlimRuntimeModelAgents(workingDirectory, options);

  const projectPath = workingDirectory ? getIndexedProjectAgentPath(workingDirectory, agentName) : null;
  if (projectPath && fs.existsSync(projectPath)) {
    const baseConfig = parseAgentMdFile(projectPath, AGENT_SCOPE.PROJECT, path.join(workingDirectory, '.opencode', 'agents'));
    const modelConfig = applySlimModelMetadata(baseConfig, slimRuntimeAgents[agentName]);
    const config = modelConfig.slimRuntimeModel ? modelConfig : applyAgentModelOverride(modelConfig, overrides[agentName]);
    return {
      source: 'md',
      scope: AGENT_SCOPE.PROJECT,
      config,
    };
  }

  const packagedAgent = getPackagedAgent(agentName);
  if (packagedAgent) {
    const baseConfig = {
        name: packagedAgent.name,
        ...packagedAgent.frontmatter,
        ...(typeof packagedAgent.prompt === 'string' && packagedAgent.prompt.length > 0 ? { prompt: packagedAgent.prompt } : {}),
        scope: PACKAGED_AGENT_SCOPE,
        source: PACKAGED_AGENT_SCOPE,
        native: true,
        builtIn: true,
      };
    applyParsedModelFields(baseConfig, packagedAgent.frontmatter.model);
    const modelConfig = applySlimModelMetadata(baseConfig, slimRuntimeAgents[agentName]);
    const config = modelConfig.slimRuntimeModel ? modelConfig : applyAgentModelOverride(modelConfig, overrides[agentName]);
    return {
      source: 'md',
      scope: PACKAGED_AGENT_SCOPE,
      config,
    };
  }

  if (slimRuntimeAgents[agentName]) {
    return {
      source: 'slim',
      scope: SLIM_SCOPE,
      config: slimRuntimeAgents[agentName],
    };
  }

  return {
    source: 'none',
    scope: null,
    config: {},
  };
}

function throwAgentWriteDisabled() {
  throw new Error(AGENT_WRITE_DISABLED_MESSAGE);
}

export {
  PACKAGED_AGENT_SCOPE,
  AGENT_WRITE_DISABLED_MESSAGE,
  ensureProjectAgentDir,
  getProjectAgentPath,
  getAgentScope,
  getAgentSources,
  getAgentConfig,
  getEffectivePackagedAgentRuntimeFrontmatter,
  listAgentModelOverrides,
  listManagedRuntimeAgentModelOverrides,
  listStaleAgentModelOverrides,
  writeAgentModelOverride,
  deleteAgentModelOverride,
  listProjectAgents,
  listConfigAgents,
  throwAgentWriteDisabled as createAgent,
  throwAgentWriteDisabled as updateAgent,
  throwAgentWriteDisabled as deleteAgent,
};
