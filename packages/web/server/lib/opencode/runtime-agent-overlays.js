import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

import {
  findWorktreeRoot,
  OPENCODE_CONFIG_DIR,
  readConfig,
} from './shared.js';
import { listAgentModelOverrides } from './agents.js';
import { listMcpConfigs } from './mcp.js';
import {
  buildBlockedManagedRuntimeMcpOverlay,
  filterManagedRuntimePluginEntries,
} from './runtime-surface-policy.js';
import { sanitizeAgentSkillPolicy } from './skill-policy.js';
import { resolveSlimConfig } from './slim-config.js';
import {
  GITHUB_COPILOT_PROVIDER_ID,
  GITHUB_COPILOT_PROVIDER_NAME,
} from './provider-integrations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_DIR = path.resolve(__dirname, '../../default-config');
const DEFAULT_PACKAGED_AGENT_DIR = path.join(DEFAULT_CONFIG_DIR, 'agents');
const DEFAULT_PACKAGED_PLUGIN_DIR = path.join(DEFAULT_CONFIG_DIR, 'plugins');
const DEFAULT_RUNTIME_AGENT_OVERLAY_ROOT = path.join(OPENCODE_CONFIG_DIR, '.openchamber', 'runtime-agent-overlays');
const DEFAULT_RUNTIME_AGENT_OVERLAY_MANIFEST_PATH = path.join(OPENCODE_CONFIG_DIR, '.openchamber', 'runtime-agent-overlays.json');
const DEFAULT_REMOTE_MCP_TIMEOUT_MS = 5_000;
const ANTHROPIC_OAUTH_PLUGIN_NAME = 'opencode-with-claude';
const ANTHROPIC_OAUTH_CONFIG_PROVIDER_ID = 'anthropic';
const SLIM_CONFIG_FILE_NAMES = ['oh-my-opencode-slim.jsonc', 'oh-my-opencode-slim.json'];

// OpenCode merges higher-precedence agent markdown over project markdown. It
// rejects YAML null for variant, and omitting variant keeps the lower layer's
// value, so an empty string is the only schema-valid way to clear inheritance.
const CLEARED_VARIANT_SENTINEL = '';

const isPlainObject = (value) => (
  value
  && typeof value === 'object'
  && !Array.isArray(value)
);

const hashContent = (content) => crypto.createHash('sha256').update(content).digest('hex');

const getProjectOverlayKey = (workingDirectory) => (
  crypto.createHash('sha256').update(path.resolve(workingDirectory)).digest('hex')
);

const parseAgentMarkdownContent = (content) => {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content.trim() };
  }

  return {
    frontmatter: yaml.parse(match[1]) || {},
    body: match[2].trim(),
  };
};

const formatAgentMarkdownContent = (frontmatter, body) => {
  const yamlContent = yaml.stringify(frontmatter).trimEnd();
  return `---\n${yamlContent}\n---\n\n${body.trim()}\n`;
};

const readManifestFile = async (filePath) => {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const trimmed = content.trim();
    if (!trimmed) {
      return { version: 1, projects: {} };
    }
    const parsed = JSON.parse(trimmed);
    if (!isPlainObject(parsed)) {
      return { version: 1, projects: {} };
    }
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      projects: isPlainObject(parsed.projects) ? parsed.projects : {},
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { version: 1, projects: {} };
    }
    throw new Error(`Failed to read runtime agent overlay manifest: ${error.message}`);
  }
};

const writeFileAtomic = async (filePath, content) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.writeFile(tempPath, content, 'utf8');
  await fs.rename(tempPath, filePath);
};

const removeFileIfPresent = async (filePath) => {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

const sortObjectByKey = (value) => Object.fromEntries(
  Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
);

const copyStringRecord = (value) => {
  if (!isPlainObject(value)) {
    return null;
  }
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key && raw !== undefined && raw !== null) {
      result[key] = String(raw);
    }
  }
  return Object.keys(result).length > 0 ? result : null;
};

const copyRemoteMcpOAuth = (value) => {
  if (value === false) {
    return false;
  }
  if (!isPlainObject(value)) {
    return null;
  }
  const result = {};
  for (const key of ['clientId', 'clientSecret', 'scope', 'redirectUri']) {
    const raw = value[key];
    if (typeof raw === 'string' && raw.trim()) {
      result[key] = raw.trim();
    }
  }
  return Object.keys(result).length > 0 ? result : null;
};

const normalizeRemoteMcpTimeoutMs = (value) => (
  Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : DEFAULT_REMOTE_MCP_TIMEOUT_MS
);

const isAnthropicOAuthProxyOptions = (options) => {
  if (!isPlainObject(options) || options.apiKey !== 'dummy' || typeof options.baseURL !== 'string') {
    return false;
  }

  try {
    const url = new URL(options.baseURL);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && Boolean(url.port);
  } catch {
    return false;
  }
};

const buildAnthropicOAuthProxyOverlay = (workingDirectory, options = {}) => {
  const readActiveConfig = typeof options.readConfig === 'function' ? options.readConfig : readConfig;
  const config = readActiveConfig(workingDirectory);
  const plugin = Array.isArray(config?.plugin)
    ? config.plugin.filter((entry) => typeof entry === 'string')
    : [];
  if (!plugin.includes(ANTHROPIC_OAUTH_PLUGIN_NAME)) {
    return null;
  }

  const providers = isPlainObject(config?.provider) ? config.provider : {};
  const anthropic = isPlainObject(providers[ANTHROPIC_OAUTH_CONFIG_PROVIDER_ID])
    ? providers[ANTHROPIC_OAUTH_CONFIG_PROVIDER_ID]
    : null;
  const anthropicOptions = isPlainObject(anthropic?.options) ? anthropic.options : {};
  if (!isAnthropicOAuthProxyOptions(anthropicOptions)) {
    return null;
  }

  return {
    plugin: [ANTHROPIC_OAUTH_PLUGIN_NAME],
    provider: {
      [ANTHROPIC_OAUTH_CONFIG_PROVIDER_ID]: {
        ...anthropic,
        options: {
          ...anthropicOptions,
        },
      },
    },
  };
};

const buildRemoteMcpTimeoutOverlay = (workingDirectory, options = {}) => {
  const timeoutMs = normalizeRemoteMcpTimeoutMs(options.remoteMcpTimeoutMs);
  const listConfigs = typeof options.listMcpConfigs === 'function'
    ? options.listMcpConfigs
    : listMcpConfigs;
  const configs = listConfigs(workingDirectory) || [];
  const mcp = {};

  for (const config of configs) {
    if (!isPlainObject(config)) {
      continue;
    }
    if (config.type !== 'remote' || config.enabled === false) {
      continue;
    }
    if (config.scope === 'project') {
      continue;
    }
    if (typeof config.timeout === 'number' && Number.isFinite(config.timeout) && config.timeout > 0) {
      continue;
    }
    if (typeof config.name !== 'string' || !config.name.trim()) {
      continue;
    }
    if (typeof config.url !== 'string' || !config.url.trim()) {
      continue;
    }

    const overlayEntry = {
      type: 'remote',
      url: config.url.trim(),
      enabled: true,
    };
    const headers = copyStringRecord(config.headers);
    const environment = copyStringRecord(config.environment);
    const oauth = copyRemoteMcpOAuth(config.oauth);
    if (headers) {
      overlayEntry.headers = headers;
    }
    if (environment) {
      overlayEntry.environment = environment;
    }
    if (oauth !== null) {
      overlayEntry.oauth = oauth;
    }
    overlayEntry.timeout = timeoutMs;
    mcp[config.name] = overlayEntry;
  }

  if (Object.keys(mcp).length === 0) {
    return null;
  }

  return {
    mcp: sortObjectByKey(mcp),
  };
};

const buildBlockedMcpOverlay = (workingDirectory, options = {}) => {
  const listConfigs = typeof options.listMcpConfigs === 'function'
    ? options.listMcpConfigs
    : listMcpConfigs;
  return buildBlockedManagedRuntimeMcpOverlay(listConfigs(workingDirectory) || []);
};

const buildPackagedPluginOverlay = (pluginSpecs = []) => {
  const plugin = [
    ...new Set(pluginSpecs.filter((entry) => typeof entry === 'string' && entry.trim())),
  ];
  return plugin.length > 0 ? { plugin } : null;
};

const buildActivePluginOverlay = (workingDirectory, options = {}) => {
  const readActiveConfig = typeof options.readConfig === 'function' ? options.readConfig : readConfig;
  const config = readActiveConfig(workingDirectory);
  const plugin = Array.isArray(config?.plugin)
    ? filterManagedRuntimePluginEntries(config.plugin.filter((entry) => (
      (typeof entry === 'string' && entry.trim())
      || (Array.isArray(entry) && typeof entry[0] === 'string' && entry[0].trim())
    )))
    : [];
  return plugin.length > 0 ? { plugin } : null;
};

const buildGitHubCopilotProviderOverlay = async (options = {}) => {
  const readAuthFile = typeof options.readAuthFile === 'function' ? options.readAuthFile : null;
  if (!readAuthFile) {
    return null;
  }

  const { discoverGitHubCopilotModels } = await import('./github-copilot-models.js');
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  const discovery = await discoverGitHubCopilotModels({ readAuthFile, fetchImpl });
  if (discovery.source === 'unavailable') {
    return null;
  }

  const models = discovery.models;
  if (!isPlainObject(models) || Object.keys(models).length === 0) {
    return null;
  }

  return {
    provider: {
      [GITHUB_COPILOT_PROVIDER_ID]: {
        name: GITHUB_COPILOT_PROVIDER_NAME,
        models,
      },
    },
  };
};

const buildRuntimeConfigOverlay = (workingDirectory, options = {}) => {
  const overlays = [
    options.githubCopilotProviderOverlay,
    buildRemoteMcpTimeoutOverlay(workingDirectory, options),
    buildBlockedMcpOverlay(workingDirectory, options),
    buildActivePluginOverlay(workingDirectory, options),
    buildAnthropicOAuthProxyOverlay(workingDirectory, options),
    buildPackagedPluginOverlay(options.packagedPluginSpecs),
  ].filter(Boolean);

  if (overlays.length === 0) {
    return null;
  }

  return overlays.reduce((merged, overlay) => {
    const next = { ...merged, ...overlay };
    if (isPlainObject(merged.provider) || isPlainObject(overlay.provider)) {
      next.provider = {
        ...(isPlainObject(merged.provider) ? merged.provider : {}),
        ...(isPlainObject(overlay.provider) ? overlay.provider : {}),
      };
    }
    if (Array.isArray(merged.plugin) || Array.isArray(overlay.plugin)) {
      next.plugin = [
        ...new Set([
          ...(Array.isArray(merged.plugin) ? merged.plugin : []),
          ...(Array.isArray(overlay.plugin) ? overlay.plugin : []),
        ]),
      ];
    }
    if (isPlainObject(merged.mcp) || isPlainObject(overlay.mcp)) {
      next.mcp = {
        ...(isPlainObject(merged.mcp) ? merged.mcp : {}),
        ...(isPlainObject(overlay.mcp) ? overlay.mcp : {}),
      };
    }
    return next;
  }, {});
};

const syncSlimConfigOverlay = async (targetConfigDirectory, workingDirectory, options = {}) => {
  const slim = resolveSlimConfig(workingDirectory, options);
  const staleTargets = SLIM_CONFIG_FILE_NAMES.map((fileName) => path.join(targetConfigDirectory, fileName));
  if (!slim.pluginEnabled || !slim.userConfigPath) {
    let changed = false;
    for (const target of staleTargets) {
      changed = (await removeFileIfPresent(target)) || changed;
    }
    return {
      changed,
      written: false,
      updated: false,
      removed: changed,
      targetPath: null,
    };
  }

  const targetPath = path.join(targetConfigDirectory, path.basename(slim.userConfigPath));
  const desiredContent = await fs.readFile(slim.userConfigPath, 'utf8');
  let currentContent = null;
  try {
    currentContent = await fs.readFile(targetPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  let changed = false;
  let written = false;
  let updated = false;
  if (currentContent !== desiredContent) {
    await writeFileAtomic(targetPath, desiredContent);
    changed = true;
    written = currentContent === null;
    updated = currentContent !== null;
  }

  for (const staleTarget of staleTargets) {
    if (staleTarget === targetPath) {
      continue;
    }
    changed = (await removeFileIfPresent(staleTarget)) || changed;
  }

  return {
    changed,
    written,
    updated,
    removed: false,
    targetPath,
  };
};

const listAgentFiles = async (agentRoot, scope) => {
  const agentsByName = new Map();
  const dirsToVisit = [agentRoot];

  while (dirsToVisit.length > 0) {
    const dir = dirsToVisit.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        continue;
      }
      throw error;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirsToVisit.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) {
        continue;
      }

      const name = entry.name.slice(0, -3);
      if (agentsByName.has(name)) {
        continue;
      }

      const content = await fs.readFile(entryPath, 'utf8');
      const { frontmatter, body } = parseAgentMarkdownContent(content);
      agentsByName.set(name, {
        name,
        scope,
        filePath: entryPath,
        frontmatter,
        body,
      });
    }
  }

  return Array.from(agentsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
};

const isPackagedPluginFile = (entry) => (
  entry.isFile()
  && !entry.name.endsWith('.d.ts')
  && !/(^|[.-])(test|spec)\./.test(entry.name)
  && ['.js', '.mjs', '.cjs', '.ts'].includes(path.extname(entry.name))
);

const listPackagedPluginFiles = async (pluginRoot) => {
  let entries;
  try {
    entries = await fs.readdir(pluginRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const plugins = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!isPackagedPluginFile(entry)) {
      continue;
    }
    const content = await fs.readFile(path.join(pluginRoot, entry.name), 'utf8');
    plugins.push({
      fileName: entry.name,
      spec: `./plugins/${entry.name}`,
      content,
      hash: hashContent(content),
    });
  }
  return plugins;
};

const listBaseAgentSources = async (workingDirectory, packagedAgentDirectory) => {
  const agentsByName = new Map();

  for (const agent of await listAgentFiles(packagedAgentDirectory, 'packaged')) {
    agentsByName.set(agent.name, agent);
  }

  if (workingDirectory) {
    const projectAgentDirectory = path.join(workingDirectory, '.opencode', 'agents');
    for (const agent of await listAgentFiles(projectAgentDirectory, 'project')) {
      agentsByName.set(agent.name, agent);
    }
  }

  return agentsByName;
};

const normalizeOverrides = (options) => (
  options.agentOverrides && isPlainObject(options.agentOverrides)
    ? options.agentOverrides
    : listAgentModelOverrides(options)
);

const hasSkillPermission = (frontmatter) => {
  const skillPermission = isPlainObject(frontmatter?.permission) ? frontmatter.permission.skill : undefined;
  return skillPermission === 'allow' || isPlainObject(skillPermission);
};

const shouldApplySkillPolicy = (agent, options = {}) => (
  Boolean(options.skillPolicy)
  && (
    agent?.scope === 'packaged'
    || (agent?.scope === 'project' && hasSkillPermission(agent.frontmatter))
  )
);

const applyRuntimeOverrideFrontmatter = (agent, override, options = {}) => {
  const baseFrontmatter = shouldApplySkillPolicy(agent, options)
    ? sanitizeAgentSkillPolicy(agent.frontmatter, options.skillPolicy)
    : agent.frontmatter;
  const next = { ...baseFrontmatter };

  if (Object.prototype.hasOwnProperty.call(override, 'model')) {
    next.model = override.model;
    next.modelRefs = [override.model];
  }

  if (Object.prototype.hasOwnProperty.call(override, 'variant')) {
    next.variant = typeof override.variant === 'string'
      ? override.variant
      : CLEARED_VARIANT_SENTINEL;
  }

  if (Array.isArray(override.councillors)) {
    next.councillors = override.councillors.map((entry) => ({ ...entry }));
    next.modelRefs = override.councillors.map((entry) => entry.model);
  }

  return next;
};

const shouldWriteSkillPolicyOverlay = (agent, options = {}) => shouldApplySkillPolicy(agent, options);

const buildRuntimeExternalDirectories = (workingDirectory) => {
  if (!workingDirectory) {
    return [];
  }

  const dirs = [];
  const addDir = (dir) => {
    if (typeof dir !== 'string' || !dir.trim()) {
      return;
    }
    const resolved = path.resolve(dir);
    if (!dirs.includes(resolved)) {
      dirs.push(resolved);
    }
  };

  addDir(workingDirectory);
  addDir(findWorktreeRoot(workingDirectory));
  return dirs;
};

const buildRuntimeSkillPolicy = (skillPolicy, workingDirectory) => {
  if (!skillPolicy) {
    return null;
  }
  const runtimeExternalDirectories = buildRuntimeExternalDirectories(workingDirectory);
  if (runtimeExternalDirectories.length === 0) {
    return skillPolicy;
  }
  return {
    ...skillPolicy,
    runtimeExternalDirectories,
  };
};

export const getRuntimeAgentOverlayConfigDirectory = (workingDirectory, options = {}) => {
  if (!workingDirectory) {
    return null;
  }
  const overlayRoot = options.overlayRoot ?? DEFAULT_RUNTIME_AGENT_OVERLAY_ROOT;
  return path.join(overlayRoot, getProjectOverlayKey(workingDirectory));
};

export const syncRuntimeAgentOverlays = async (options = {}) => {
  const workingDirectory = typeof options.workingDirectory === 'string' && options.workingDirectory.trim()
    ? path.resolve(options.workingDirectory)
    : null;
  const overlayRoot = options.overlayRoot ?? DEFAULT_RUNTIME_AGENT_OVERLAY_ROOT;
  const packagedAgentDirectory = options.packagedAgentDirectory ?? DEFAULT_PACKAGED_AGENT_DIR;
  const packagedPluginDirectory = options.packagedPluginDirectory ?? DEFAULT_PACKAGED_PLUGIN_DIR;
  const manifestPath = options.manifestPath ?? DEFAULT_RUNTIME_AGENT_OVERLAY_MANIFEST_PATH;
  const projectKey = workingDirectory ? getProjectOverlayKey(workingDirectory) : '__global__';
  const targetConfigDirectory = options.targetConfigDirectory
    ?? (workingDirectory ? path.join(overlayRoot, projectKey) : path.join(overlayRoot, projectKey));
  const targetAgentDirectory = path.join(targetConfigDirectory, 'agents');
  const targetPluginDirectory = path.join(targetConfigDirectory, 'plugins');
  const overrides = normalizeOverrides(options);
  const runtimeSkillPolicy = buildRuntimeSkillPolicy(options.skillPolicy, workingDirectory);
  const runtimeOptions = {
    ...options,
    skillPolicy: runtimeSkillPolicy,
  };

  const result = {
    changed: false,
    written: [],
    updated: [],
    removed: [],
    pluginsWritten: [],
    pluginsUpdated: [],
    pluginsRemoved: [],
    configWritten: false,
    configUpdated: false,
    configRemoved: false,
    slimConfigWritten: false,
    slimConfigUpdated: false,
    slimConfigRemoved: false,
    slimConfigPath: null,
    targetConfigDirectory,
    targetAgentDirectory,
    targetPluginDirectory,
    manifestPath,
  };

  await fs.mkdir(targetAgentDirectory, { recursive: true });
  const targetConfigFile = path.join(targetConfigDirectory, 'opencode.json');
  const packagedPlugins = await listPackagedPluginFiles(packagedPluginDirectory);

  try {
    const authModule = await import('./auth.js');
    const readAuthFile = typeof options.readAuthFile === 'function'
      ? options.readAuthFile
      : authModule.readAuthFile;
    const writeAuthFile = typeof options.writeAuthFile === 'function'
      ? options.writeAuthFile
      : authModule.writeAuthFile;
    const { syncGitHubCopilotAuthAliases } = await import('./provider-integrations.js');
    if (syncGitHubCopilotAuthAliases({ readAuthFile, writeAuthFile })) {
      result.changed = true;
    }
  } catch (error) {
    console.warn('[OpenCode] Failed to sync GitHub Copilot auth aliases:', error);
  }

  const githubCopilotProviderOverlay = await buildGitHubCopilotProviderOverlay(runtimeOptions);
  const desiredRuntimeConfig = buildRuntimeConfigOverlay(workingDirectory, {
    ...options,
    packagedPluginSpecs: packagedPlugins.map((plugin) => plugin.spec),
    githubCopilotProviderOverlay,
  });

  if (desiredRuntimeConfig) {
    const desiredContent = `${JSON.stringify(desiredRuntimeConfig, null, 2)}\n`;
    let currentContent = null;
    try {
      currentContent = await fs.readFile(targetConfigFile, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }

    if (currentContent !== desiredContent) {
      await writeFileAtomic(targetConfigFile, desiredContent);
      result.changed = true;
      if (currentContent === null) {
        result.configWritten = true;
      } else {
        result.configUpdated = true;
      }
    }
  } else if (await removeFileIfPresent(targetConfigFile)) {
    result.changed = true;
    result.configRemoved = true;
  }

  const slimOverlay = await syncSlimConfigOverlay(targetConfigDirectory, workingDirectory, options);
  if (slimOverlay.changed) {
    result.changed = true;
  }
  result.slimConfigWritten = slimOverlay.written;
  result.slimConfigUpdated = slimOverlay.updated;
  result.slimConfigRemoved = slimOverlay.removed;
  result.slimConfigPath = slimOverlay.targetPath;

  const baseAgentsByName = await listBaseAgentSources(workingDirectory, packagedAgentDirectory);
  const manifest = await readManifestFile(manifestPath);
  const projects = isPlainObject(manifest.projects) ? manifest.projects : {};
  const projectManifest = isPlainObject(projects[projectKey]) ? projects[projectKey] : {};
  const manifestAgents = isPlainObject(projectManifest.agents) ? projectManifest.agents : {};
  const manifestPlugins = isPlainObject(projectManifest.plugins) ? projectManifest.plugins : {};
  const nextManifestAgents = { ...manifestAgents };
  const nextManifestPlugins = { ...manifestPlugins };
  let manifestChanged = false;

  const desiredAgentInputs = new Map();
  for (const [name, override] of Object.entries(overrides)) {
    if (!isPlainObject(override)) {
      continue;
    }
    const baseAgent = baseAgentsByName.get(name);
    if (!baseAgent) {
      continue;
    }

    desiredAgentInputs.set(name, { baseAgent, override });
  }

  for (const [name, baseAgent] of baseAgentsByName.entries()) {
    if (!shouldWriteSkillPolicyOverlay(baseAgent, runtimeOptions) || desiredAgentInputs.has(name)) {
      continue;
    }
    desiredAgentInputs.set(name, { baseAgent, override: {} });
  }

  const desiredAgents = new Map();
  for (const [name, { baseAgent, override }] of desiredAgentInputs.entries()) {
    const frontmatter = applyRuntimeOverrideFrontmatter(baseAgent, override, runtimeOptions);
    const content = formatAgentMarkdownContent(frontmatter, baseAgent.body);
    desiredAgents.set(name, {
      name,
      content,
      hash: hashContent(content),
    });
  }

  for (const agent of desiredAgents.values()) {
    const targetPath = path.join(targetAgentDirectory, `${agent.name}.md`);
    let currentContent = null;
    try {
      currentContent = await fs.readFile(targetPath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }

    if (currentContent === agent.content) {
      if (nextManifestAgents[agent.name]?.hash !== agent.hash) {
        nextManifestAgents[agent.name] = { hash: agent.hash };
        manifestChanged = true;
        result.changed = true;
      }
      continue;
    }

    await writeFileAtomic(targetPath, agent.content);
    const existed = currentContent !== null;
    nextManifestAgents[agent.name] = { hash: agent.hash };
    if (existed) {
      result.updated.push(agent.name);
    } else {
      result.written.push(agent.name);
    }
    result.changed = true;
    manifestChanged = true;
  }

  for (const name of Object.keys(manifestAgents)) {
    if (desiredAgents.has(name)) {
      continue;
    }

    if (await removeFileIfPresent(path.join(targetAgentDirectory, `${name}.md`))) {
      result.removed.push(name);
      result.changed = true;
    }
    delete nextManifestAgents[name];
    manifestChanged = true;
  }

  const desiredPlugins = new Map(packagedPlugins.map((plugin) => [plugin.fileName, plugin]));
  if (desiredPlugins.size > 0) {
    await fs.mkdir(targetPluginDirectory, { recursive: true });
  }

  for (const plugin of desiredPlugins.values()) {
    const targetPath = path.join(targetPluginDirectory, plugin.fileName);
    let currentContent = null;
    try {
      currentContent = await fs.readFile(targetPath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }

    if (currentContent === plugin.content) {
      if (nextManifestPlugins[plugin.fileName]?.hash !== plugin.hash) {
        nextManifestPlugins[plugin.fileName] = { hash: plugin.hash };
        manifestChanged = true;
        result.changed = true;
      }
      continue;
    }

    await writeFileAtomic(targetPath, plugin.content);
    nextManifestPlugins[plugin.fileName] = { hash: plugin.hash };
    if (currentContent === null) {
      result.pluginsWritten.push(plugin.fileName);
    } else {
      result.pluginsUpdated.push(plugin.fileName);
    }
    result.changed = true;
    manifestChanged = true;
  }

  for (const fileName of Object.keys(manifestPlugins)) {
    if (desiredPlugins.has(fileName)) {
      continue;
    }

    if (await removeFileIfPresent(path.join(targetPluginDirectory, fileName))) {
      result.pluginsRemoved.push(fileName);
      result.changed = true;
    }
    delete nextManifestPlugins[fileName];
    manifestChanged = true;
  }

  if (manifestChanged || !isPlainObject(projects[projectKey])) {
    await writeFileAtomic(manifestPath, `${JSON.stringify({
      version: 1,
      projects: sortObjectByKey({
        ...projects,
        [projectKey]: {
          workingDirectory,
          targetConfigDirectory,
          agents: sortObjectByKey(nextManifestAgents),
          plugins: sortObjectByKey(nextManifestPlugins),
        },
      }),
    }, null, 2)}\n`);
  }

  result.written.sort((a, b) => a.localeCompare(b));
  result.updated.sort((a, b) => a.localeCompare(b));
  result.removed.sort((a, b) => a.localeCompare(b));
  result.pluginsWritten.sort((a, b) => a.localeCompare(b));
  result.pluginsUpdated.sort((a, b) => a.localeCompare(b));
  result.pluginsRemoved.sort((a, b) => a.localeCompare(b));

  return result;
};

export {
  CLEARED_VARIANT_SENTINEL,
  DEFAULT_REMOTE_MCP_TIMEOUT_MS,
  DEFAULT_RUNTIME_AGENT_OVERLAY_MANIFEST_PATH,
  DEFAULT_RUNTIME_AGENT_OVERLAY_ROOT,
};
