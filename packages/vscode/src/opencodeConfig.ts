import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import yaml from 'yaml';
import { parse as parseJsonc } from 'jsonc-parser';
import { readAuthFile } from './opencodeAuth';
import {
  isAnthropicOAuthPluginSpec,
  reconcileAnthropicOAuthPluginSpecs,
} from './anthropicOAuthPlugin';
import { resolveProjectPlansDirectory } from '../../web/server/lib/projects/project-id.js';
import {
  buildDevRyanDefaultPluginInventory,
  type DevRyanDefaultPlugin,
  type DevRyanDefaultPluginId,
} from '../../web/server/lib/opencode/default-plugins.js';
import {
  buildVisibleSkillPolicy,
  sanitizeAgentSkillPolicy,
  type VisibleSkillPolicy,
} from '../../web/server/lib/opencode/skill-policy.js';

const OPENCODE_CONFIG_DIR = path.join(os.homedir(), '.config', 'opencode');
const AGENT_DIR = path.join(OPENCODE_CONFIG_DIR, 'agents');
const COMMAND_DIR = path.join(OPENCODE_CONFIG_DIR, 'commands');
const CONFIG_FILE = path.join(OPENCODE_CONFIG_DIR, 'config.json');
const OFFICIAL_USER_CONFIG_FILE = path.join(OPENCODE_CONFIG_DIR, 'opencode.json');
const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');
const MCP_AUTH_FILE = path.join(OPENCODE_DATA_DIR, 'mcp-auth.json');
const OPENCHAMBER_SIDECAR_PATH = path.join(OPENCODE_CONFIG_DIR, '.openchamber', 'config.json');
const MCP_RECOVERY_MANIFEST_PATH = path.join(OPENCODE_CONFIG_DIR, '.openchamber', 'mcp-recovery-vscode.json');
const RUNTIME_AGENT_OVERLAY_ROOT = path.join(OPENCODE_CONFIG_DIR, '.openchamber', 'runtime-agent-overlays');
const RUNTIME_AGENT_OVERLAY_MANIFEST_PATH = path.join(OPENCODE_CONFIG_DIR, '.openchamber', 'runtime-agent-overlays-vscode.json');
const DEFAULT_OPENAI_HEADER_TIMEOUT_MS = 60_000;
const DEFAULT_OPENAI_CHUNK_TIMEOUT_MS = 120_000;
const DEFAULT_OPENAI_REQUEST_TIMEOUT_MS = 600_000;
const CUSTOM_CONFIG_FILE = process.env.OPENCODE_CONFIG
  ? path.resolve(process.env.OPENCODE_CONFIG)
  : null;
const USER_CONFIG_PATHS = [
  CONFIG_FILE,
  OFFICIAL_USER_CONFIG_FILE,
  path.join(OPENCODE_CONFIG_DIR, 'opencode.jsonc'),
];
const PROMPT_FILE_PATTERN = /^\{file:(.+)\}$/i;
const PLUGIN_FILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-_.]*\.(js|ts|mjs|cjs)$/;
const RUNTIME_PLUGIN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts']);
const ANTHROPIC_OAUTH_PROVIDER_IDS = new Set([
  'anthropic',
  'claude',
  'anthropic-oauth',
  'opencode-with-claude',
]);
const ANTHROPIC_OAUTH_CONFIG_PROVIDER_ID = 'anthropic';
const ANTHROPIC_OAUTH_DEFAULT_BASE_URL = 'http://127.0.0.1:3456';
const AGENT_WRITE_DISABLED_MESSAGE = 'Agent configuration is read-only. Edit project .opencode/agents/*.md files directly.';
const OPENCHAMBER_CONFIG_KEY = 'openchamber';
const AGENT_OVERRIDES_CONFIG_KEY = 'agentOverrides';
const ALLOWED_AGENT_OVERRIDE_KEYS = new Set(['model', 'variant', 'councillors']);
const CLEARED_VARIANT_SENTINEL = '';
const SLIM_PLUGIN_PACKAGE_NAME = 'oh-my-opencode-slim';
const DEVRYAN_SLIM_WRAPPER_PLUGIN_FILE = 'devryan-oh-my-opencode-slim.mjs';
const DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC = `./plugins/${DEVRYAN_SLIM_WRAPPER_PLUGIN_FILE}`;
const SLIM_CONFIG_BASENAME = 'oh-my-opencode-slim';
const SLIM_CONFIG_FILE_NAMES = [`${SLIM_CONFIG_BASENAME}.jsonc`, `${SLIM_CONFIG_BASENAME}.json`];
const SLIM_DEFAULT_DISABLED_AGENTS = ['observer'];
const SLIM_PROTECTED_AGENTS = new Set(['orchestrator', 'councillor']);
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
const SLIM_SUBAGENT_NAMES = new Set([
  'explorer',
  'librarian',
  'oracle',
  'designer',
  'fixer',
  'observer',
  'council',
  'councillor',
]);
const SLIM_DEEP_MERGE_KEYS = [
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
const ALLOWED_MANAGED_RUNTIME_PLUGIN_SPEC_PREFIXES = [
  '@rama_nigg/open-cursor',
  'context-mode@',
  'opencode-antigravity-auth',
];
const ALLOWED_MANAGED_RUNTIME_PLUGIN_SPECS = new Set([
  'context-mode',
  'cursor-acp',
  'oh-my-opencode-slim',
  DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC,
]);
const BLOCKED_MANAGED_RUNTIME_MCP_NAMES = [
  'context7',
  'ghgrep',
  'gh-grep',
  'gh_grep',
  'grep-app',
  'grep_app',
];

// Scope types (shared by agents and commands)
export const AGENT_SCOPE = {
  USER: 'user',
  PROJECT: 'project',
  PACKAGED: 'packaged',
  SLIM: 'slim',
} as const;

export const COMMAND_SCOPE = {
  USER: 'user',
  PROJECT: 'project'
} as const;

export type AgentScope = typeof AGENT_SCOPE[keyof typeof AGENT_SCOPE];
export type CommandScope = typeof COMMAND_SCOPE[keyof typeof COMMAND_SCOPE];
export type PluginScope = 'user' | 'project';
export type PluginParsedKind = 'npm' | 'path';

export type PluginEntry = {
  id: string;
  spec: string;
  options?: Record<string, unknown>;
  scope: PluginScope;
  kind: 'config';
  parsedKind: PluginParsedKind;
  sourcePath: string;
  defaultPluginId?: DevRyanDefaultPluginId;
};

export type PluginFile = {
  id: string;
  fileName: string;
  scope: PluginScope;
  kind: 'file';
  absolutePath: string;
  defaultPluginId?: DevRyanDefaultPluginId;
};

export type PluginConfigError = {
  scope: PluginScope;
  sourcePath: string;
  index: number | null;
  message: string;
};

export type PluginsListResponse = {
  defaults: DevRyanDefaultPlugin[];
  entries: PluginEntry[];
  files: PluginFile[];
  errors: PluginConfigError[];
};

export type ConfigSources = {
  md: { exists: boolean; path: string | null; fields: string[]; scope?: AgentScope | CommandScope | null };
  json: { exists: boolean; path: string; fields: string[]; scope?: AgentScope | CommandScope | null };
  projectMd?: { exists: boolean; path: string | null };
  packagedMd?: { exists: boolean; path: string | null };
  userMd?: { exists: boolean; path: string | null };
};

type AgentModelOverride = {
  model?: string;
  variant?: string | null;
  councillors?: Array<{ model: string; variant?: string | null }>;
};

type ConfigAgent = Record<string, unknown> & {
  name: string;
  scope: AgentScope;
  source: AgentScope;
  model?: { providerID: string; modelID: string };
  modelRefs?: string[];
  councillors?: Array<{ model: string; variant?: string | null }>;
  variant?: string | null;
};

const ensureDirs = () => {
  if (!fs.existsSync(OPENCODE_CONFIG_DIR)) fs.mkdirSync(OPENCODE_CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(AGENT_DIR)) fs.mkdirSync(AGENT_DIR, { recursive: true });
  if (!fs.existsSync(COMMAND_DIR)) fs.mkdirSync(COMMAND_DIR, { recursive: true });
};

// ============== AGENT SCOPE HELPERS ==============

const getProjectAgentPath = (workingDirectory: string, agentName: string): string => {
  return path.join(workingDirectory, '.opencode', 'agents', `${agentName}.md`);
};

export const getAgentScope = (
  agentName: string,
  workingDirectory?: string
): { scope: AgentScope | null; path: string | null } => {
  const slimAgents = getSlimConfigAgents(workingDirectory);
  const slimAgent = slimAgents[agentName];
  if (slimAgent) {
    return {
      scope: AGENT_SCOPE.SLIM,
      path: typeof slimAgent.__path === 'string' ? slimAgent.__path : null,
    };
  }

  if (workingDirectory) {
    const projectPath = getProjectAgentPath(workingDirectory, agentName);
    if (fs.existsSync(projectPath)) {
      return { scope: AGENT_SCOPE.PROJECT, path: projectPath };
    }
  }

  const slimRuntimeAgent = getSlimRuntimeModelAgents(workingDirectory)[agentName];
  if (slimRuntimeAgent) {
    return {
      scope: AGENT_SCOPE.SLIM,
      path: typeof slimRuntimeAgent.__path === 'string' ? slimRuntimeAgent.__path : null,
    };
  }

  return { scope: null, path: null };
};

// ============== COMMAND SCOPE HELPERS ==============

const ensureProjectCommandDir = (workingDirectory: string): string => {
  const projectCommandDir = path.join(workingDirectory, '.opencode', 'commands');
  if (!fs.existsSync(projectCommandDir)) {
    fs.mkdirSync(projectCommandDir, { recursive: true });
  }
  const legacyProjectCommandDir = path.join(workingDirectory, '.opencode', 'command');
  if (!fs.existsSync(legacyProjectCommandDir)) {
    fs.mkdirSync(legacyProjectCommandDir, { recursive: true });
  }
  return projectCommandDir;
};

const getProjectCommandPath = (workingDirectory: string, commandName: string): string => {
  const pluralPath = path.join(workingDirectory, '.opencode', 'commands', `${commandName}.md`);
  const legacyPath = path.join(workingDirectory, '.opencode', 'command', `${commandName}.md`);
  if (fs.existsSync(legacyPath) && !fs.existsSync(pluralPath)) return legacyPath;
  return pluralPath;
};

const getUserCommandPath = (commandName: string): string => {
  const pluralPath = path.join(COMMAND_DIR, `${commandName}.md`);
  const legacyPath = path.join(OPENCODE_CONFIG_DIR, 'command', `${commandName}.md`);
  if (fs.existsSync(legacyPath) && !fs.existsSync(pluralPath)) return legacyPath;
  return pluralPath;
};

export const getCommandScope = (commandName: string, workingDirectory?: string): { scope: CommandScope | null; path: string | null } => {
  if (workingDirectory) {
    const projectPath = getProjectCommandPath(workingDirectory, commandName);
    if (fs.existsSync(projectPath)) {
      return { scope: COMMAND_SCOPE.PROJECT, path: projectPath };
    }
  }
  
  const userPath = getUserCommandPath(commandName);
  if (fs.existsSync(userPath)) {
    return { scope: COMMAND_SCOPE.USER, path: userPath };
  }
  
  return { scope: null, path: null };
};

const getCommandWritePath = (commandName: string, workingDirectory?: string, requestedScope?: CommandScope): { scope: CommandScope; path: string } => {
  const existing = getCommandScope(commandName, workingDirectory);
  if (existing.path) {
    return { scope: existing.scope!, path: existing.path };
  }
  
  const scope = requestedScope || COMMAND_SCOPE.USER;
  if (scope === COMMAND_SCOPE.PROJECT && workingDirectory) {
    return { 
      scope: COMMAND_SCOPE.PROJECT, 
      path: getProjectCommandPath(workingDirectory, commandName) 
    };
  }
  
  return { 
    scope: COMMAND_SCOPE.USER, 
    path: getUserCommandPath(commandName) 
  };
};

const isPromptFileReference = (value: unknown): value is string => {
  return typeof value === 'string' && PROMPT_FILE_PATTERN.test(value.trim());
};

const resolvePromptFilePath = (reference: string): string | null => {
  const match = reference.trim().match(PROMPT_FILE_PATTERN);
  if (!match?.[1]) return null;
  let target = match[1].trim();
  if (!target) return null;

  if (target.startsWith('./')) {
    target = path.join(OPENCODE_CONFIG_DIR, target.slice(2));
  } else if (!path.isAbsolute(target)) {
    target = path.join(OPENCODE_CONFIG_DIR, target);
  }

  return target;
};

const writePromptFile = (filePath: string, content: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
};

/**
 * Get all possible project config paths in priority order
 * Priority: existing root/project config first, new writes default to root opencode.json
 */
const getProjectConfigCandidates = (workingDirectory?: string): string[] => {
  if (!workingDirectory) return [];
  return [
    path.join(workingDirectory, 'opencode.json'),
    path.join(workingDirectory, 'opencode.jsonc'),
    path.join(workingDirectory, '.opencode', 'opencode.json'),
    path.join(workingDirectory, '.opencode', 'opencode.jsonc'),
  ];
};

/**
 * Find existing project config file or return default path for new config
 */
const getProjectConfigPath = (workingDirectory?: string): string | null => {
  if (!workingDirectory) return null;

  const candidates = getProjectConfigCandidates(workingDirectory);

  // Return first existing config file
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return workingDirectory ? path.join(workingDirectory, 'opencode.json') : null;
};

const getConfigPaths = (workingDirectory?: string) => ({
  userPaths: USER_CONFIG_PATHS,
  projectPath: getProjectConfigPath(workingDirectory),
  customPath: CUSTOM_CONFIG_FILE
});

const readConfigFile = (filePath?: string | null): Record<string, unknown> => {
  if (!filePath || !fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf8');
  const normalized = content.trim();
  if (!normalized) return {};
  return parseJsonc(normalized, [], { allowTrailingComma: true }) as Record<string, unknown>;
};

const readOpenchamberSidecar = (): Record<string, unknown> | null => {
  try {
    const content = fs.readFileSync(OPENCHAMBER_SIDECAR_PATH, 'utf8').trim();
    if (!content) return null;
    const parsed = JSON.parse(content) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const applyOpenchamberSidecarToConfig = (config: Record<string, unknown>): Record<string, unknown> => {
  const sidecar = readOpenchamberSidecar();
  if (!sidecar) return config;
  const openchamber = isPlainObject(config[OPENCHAMBER_CONFIG_KEY])
    ? config[OPENCHAMBER_CONFIG_KEY] as Record<string, unknown>
    : {};
  return {
    ...config,
    [OPENCHAMBER_CONFIG_KEY]: {
      ...openchamber,
      ...sidecar,
    },
  };
};

const persistOpenchamberFromConfig = (config: Record<string, unknown>): Record<string, unknown> => {
  const openchamber = config[OPENCHAMBER_CONFIG_KEY];
  if (isPlainObject(openchamber)) {
    fs.mkdirSync(path.dirname(OPENCHAMBER_SIDECAR_PATH), { recursive: true });
    fs.writeFileSync(OPENCHAMBER_SIDECAR_PATH, JSON.stringify(openchamber, null, 2), 'utf8');
  }

  const sanitized = { ...config };
  delete sanitized[OPENCHAMBER_CONFIG_KEY];
  return sanitized;
};

const readUserConfig = (): Record<string, unknown> =>
  applyOpenchamberSidecarToConfig(readConfigFile(CONFIG_FILE));

const writeUserConfig = (config: Record<string, unknown>) => {
  writeConfig(persistOpenchamberFromConfig(config), CONFIG_FILE);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readJsonFileIfPresent = (filePath: string): Record<string, unknown> => {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) return {};
  const parsed = JSON.parse(content) as unknown;
  return isPlainObject(parsed) ? parsed : {};
};

const writeJsonFileAtomic = (filePath: string, data: Record<string, unknown>): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
};

const removeMcpAuthCacheEntry = (name: string): { ok: boolean; removed: boolean; error?: string } => {
  if (!name || !fs.existsSync(MCP_AUTH_FILE)) {
    return { ok: true, removed: false };
  }
  try {
    const auth = readJsonFileIfPresent(MCP_AUTH_FILE);
    if (!Object.prototype.hasOwnProperty.call(auth, name)) {
      return { ok: true, removed: false };
    }
    const next = { ...auth };
    delete next[name];
    writeJsonFileAtomic(MCP_AUTH_FILE, next);
    return { ok: true, removed: true };
  } catch (error) {
    return {
      ok: false,
      removed: false,
      error: error instanceof Error ? error.message : 'Failed to reset MCP OAuth cache',
    };
  }
};

const mergeConfigs = (base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key in result) {
      const baseValue = result[key];
      if (isPlainObject(baseValue) && isPlainObject(value)) {
        result[key] = mergeConfigs(baseValue, value);
      } else {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
};

const readConfigLayers = (workingDirectory?: string) => {
  const { userPaths, projectPath, customPath } = getConfigPaths(workingDirectory);
  const userPath = fs.existsSync(OFFICIAL_USER_CONFIG_FILE)
    ? OFFICIAL_USER_CONFIG_FILE
    : (fs.existsSync(CONFIG_FILE) ? CONFIG_FILE : OFFICIAL_USER_CONFIG_FILE);
  const userConfig = applyOpenchamberSidecarToConfig(
    userPaths.reduce((merged, filePath) => mergeConfigs(merged, readConfigFile(filePath)), {} as Record<string, unknown>)
  );
  const projectConfig = getProjectConfigCandidates(workingDirectory)
    .slice()
    .reverse()
    .reduce((merged, filePath) => mergeConfigs(merged, readConfigFile(filePath)), {} as Record<string, unknown>);
  const customConfig = readConfigFile(customPath);
  const mergedConfig = mergeConfigs(mergeConfigs(userConfig, projectConfig), customConfig);

  return {
    userConfig,
    projectConfig,
    customConfig,
    mergedConfig,
    paths: { userPath, projectPath, customPath }
  };
};

const readConfig = (workingDirectory?: string): Record<string, unknown> =>
  readConfigLayers(workingDirectory).mergedConfig;

const findSlimConfigPathInDirectory = (configDirectory: string): string | null => {
  const jsoncPath = path.join(configDirectory, `${SLIM_CONFIG_BASENAME}.jsonc`);
  const jsonPath = path.join(configDirectory, `${SLIM_CONFIG_BASENAME}.json`);
  if (fs.existsSync(jsoncPath)) return jsoncPath;
  if (fs.existsSync(jsonPath)) return jsonPath;
  return null;
};

const findProjectSlimConfigPath = (workingDirectory?: string): string | null => {
  if (!workingDirectory) return null;
  return findSlimConfigPathInDirectory(path.join(workingDirectory, '.opencode'));
};

const readSlimConfigFile = (filePath?: string | null): Record<string, unknown> => {
  const config = readConfigFile(filePath);
  return isPlainObject(config) ? config : {};
};

const mergeSlimConfigObjects = (
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> => {
  const merged: Record<string, unknown> = {
    ...(isPlainObject(base) ? base : {}),
    ...(isPlainObject(override) ? override : {}),
  };
  for (const key of SLIM_DEEP_MERGE_KEYS) {
    const baseValue = isPlainObject(base[key]) ? base[key] as Record<string, unknown> : {};
    const overrideValue = isPlainObject(override[key]) ? override[key] as Record<string, unknown> : {};
    const value = mergeConfigs(baseValue, overrideValue);
    if (Object.keys(value).length > 0 || base[key] !== undefined || override[key] !== undefined) {
      merged[key] = value;
    } else {
      delete merged[key];
    }
  }
  return merged;
};

const pluginSpecFromEntry = (entry: unknown): string => {
  if (typeof entry === 'string') return entry.trim();
  if (Array.isArray(entry) && typeof entry[0] === 'string') return entry[0].trim();
  return '';
};

const isSlimPluginSpec = (spec: string): boolean => (
  spec === SLIM_PLUGIN_PACKAGE_NAME
  || spec.startsWith(`${SLIM_PLUGIN_PACKAGE_NAME}@`)
  || (spec.startsWith('file://') && spec.includes(SLIM_PLUGIN_PACKAGE_NAME))
  || spec.includes(`/node_modules/${SLIM_PLUGIN_PACKAGE_NAME}`)
);

const isDevRyanSlimWrapperPluginSpec = (spec: string): boolean => (
  spec === DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC
  || spec.endsWith(`/plugins/${DEVRYAN_SLIM_WRAPPER_PLUGIN_FILE}`)
  || spec.endsWith(`\\plugins\\${DEVRYAN_SLIM_WRAPPER_PLUGIN_FILE}`)
);

const getSlimPluginState = (workingDirectory?: string): {
  rawPluginEnabled: boolean;
  wrapperPluginEnabled: boolean;
  pluginEnabled: boolean;
} => {
  const config = readConfig(workingDirectory);
  const plugin = Array.isArray(config.plugin) ? config.plugin : [];
  const rawPluginEnabled = plugin.some((entry) => isSlimPluginSpec(pluginSpecFromEntry(entry)));
  const wrapperPluginEnabled = plugin.some((entry) => isDevRyanSlimWrapperPluginSpec(pluginSpecFromEntry(entry)));
  return {
    rawPluginEnabled,
    wrapperPluginEnabled,
    pluginEnabled: rawPluginEnabled || wrapperPluginEnabled,
  };
};

const getSlimActivePreset = (config: Record<string, unknown>): string | null => {
  const envPreset = typeof process.env.OH_MY_OPENCODE_SLIM_PRESET === 'string'
    ? process.env.OH_MY_OPENCODE_SLIM_PRESET.trim()
    : '';
  if (envPreset) return envPreset;
  return typeof config.preset === 'string' && config.preset.trim() ? config.preset.trim() : null;
};

const getSlimDisabledAgents = (config: Record<string, unknown>): Set<string> => {
  const raw = Array.isArray(config.disabled_agents) ? config.disabled_agents : SLIM_DEFAULT_DISABLED_AGENTS;
  return new Set(raw.filter((name): name is string => typeof name === 'string' && !SLIM_PROTECTED_AGENTS.has(name)));
};

const getModelRefsFromSlimModel = (model: unknown): string[] => {
  const values = Array.isArray(model) ? model : [model];
  return values
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      if (isPlainObject(entry) && typeof entry.id === 'string') return entry.id.trim();
      return '';
    })
    .filter(Boolean);
};

const getFirstSlimModelVariant = (model: unknown): string | undefined => {
  if (!Array.isArray(model)) return undefined;
  const entry = model.find((candidate) => isPlainObject(candidate) && typeof candidate.variant === 'string' && candidate.variant.trim());
  return isPlainObject(entry) && typeof entry.variant === 'string' ? entry.variant.trim() : undefined;
};

const getSlimAgentMode = (name: string): string => {
  if (name === 'orchestrator') return 'primary';
  if (name === 'council') return 'all';
  if (SLIM_SUBAGENT_NAMES.has(name)) return 'subagent';
  return 'subagent';
};

const normalizeSlimAgent = (
  name: string,
  rawConfig: Record<string, unknown>,
  rootOverride?: unknown,
): ConfigAgent => {
  const root = isPlainObject(rootOverride) ? rootOverride : {};
  const modelRefs = getModelRefsFromSlimModel(rawConfig.model);
  const primaryModel = modelRefs[0];
  const parsedModel = primaryModel ? parseModelRef(primaryModel) : null;
  const presetHadVariant = typeof rawConfig.variant === 'string';
  const modelWasRootOverridden = Object.prototype.hasOwnProperty.call(root, 'model');
  const rootHasVariant = Object.prototype.hasOwnProperty.call(root, 'variant');
  const variantWasRootOverridden = rootHasVariant || (modelWasRootOverridden && presetHadVariant && !rootHasVariant);
  const variant = modelWasRootOverridden && presetHadVariant && !rootHasVariant
    ? undefined
    : (typeof rawConfig.variant === 'string' ? rawConfig.variant : getFirstSlimModelVariant(rawConfig.model));
  const agent = {
    name,
    ...rawConfig,
    ...(parsedModel ? { model: parsedModel } : {}),
    ...(modelRefs.length > 0 ? { modelRefs } : {}),
    ...(variant ? { variant } : {}),
    mode: typeof rawConfig.mode === 'string' ? rawConfig.mode : getSlimAgentMode(name),
    hidden: rawConfig.hidden === true || name === 'councillor',
    scope: AGENT_SCOPE.SLIM,
    source: AGENT_SCOPE.SLIM,
    native: true,
    builtIn: true,
    slim: true,
    overrides: {
      model: modelWasRootOverridden,
      variant: variantWasRootOverridden,
      councillors: false,
    },
  } as ConfigAgent;
  if (!variant) {
    delete agent.variant;
  }
  return agent;
};

const resolveSlimConfig = (workingDirectory?: string): {
  enabled: boolean;
  pluginEnabled: boolean;
  slimRuntimeEnabled: boolean;
  slimAgentCatalogEnabled: boolean;
  rawPluginEnabled: boolean;
  wrapperPluginEnabled: boolean;
  configDirectory: string;
  userConfigPath: string | null;
  projectConfigPath: string | null;
  mergedConfig: Record<string, unknown>;
  activePreset: string | null;
  agents: Record<string, ConfigAgent>;
} => {
  const configDirectory = process.env.OPENCODE_CONFIG_DIR ? path.resolve(process.env.OPENCODE_CONFIG_DIR) : OPENCODE_CONFIG_DIR;
  const userConfigPath = findSlimConfigPathInDirectory(configDirectory);
  const projectConfigPath = findProjectSlimConfigPath(workingDirectory);
  const userConfig = readSlimConfigFile(userConfigPath);
  const projectConfig = readSlimConfigFile(projectConfigPath);
  const mergedConfig = mergeSlimConfigObjects(userConfig, projectConfig);
  const activePreset = getSlimActivePreset(mergedConfig);
  const presets = isPlainObject(mergedConfig.presets) ? mergedConfig.presets as Record<string, unknown> : {};
  const presetAgents = activePreset && isPlainObject(presets[activePreset])
    ? presets[activePreset] as Record<string, unknown>
    : {};
  const rootAgents = isPlainObject(mergedConfig.agents) ? mergedConfig.agents as Record<string, unknown> : {};
  const effectiveAgents = mergeConfigs(presetAgents, rootAgents);
  const disabled = getSlimDisabledAgents(mergedConfig);
  const agents: Record<string, ConfigAgent> = {};
  for (const [name, rawAgent] of Object.entries(effectiveAgents)) {
    if (disabled.has(name) || !isPlainObject(rawAgent)) continue;
    agents[name] = normalizeSlimAgent(name, rawAgent as Record<string, unknown>, rootAgents[name]);
  }
  const pluginState = getSlimPluginState(workingDirectory);
  const slimAgentCatalogEnabled = pluginState.rawPluginEnabled && Object.keys(agents).length > 0;
  return {
    enabled: slimAgentCatalogEnabled,
    pluginEnabled: pluginState.pluginEnabled,
    slimRuntimeEnabled: pluginState.pluginEnabled,
    slimAgentCatalogEnabled,
    rawPluginEnabled: pluginState.rawPluginEnabled,
    wrapperPluginEnabled: pluginState.wrapperPluginEnabled,
    configDirectory,
    userConfigPath,
    projectConfigPath,
    mergedConfig,
    activePreset,
    agents,
  };
};

export const resolveSlimRuntimePreset = (workingDirectory?: string): string | undefined => {
  const slim = resolveSlimConfig(workingDirectory);
  if (!slim.pluginEnabled || !slim.activePreset) {
    return undefined;
  }
  return slim.activePreset;
};

export const resolveSlimRuntimeConfigDirectory = (workingDirectory?: string): string | undefined => {
  const slim = resolveSlimConfig(workingDirectory);
  return slim.pluginEnabled ? slim.configDirectory : undefined;
};

const getSlimConfigWritePath = (): string => (
  findSlimConfigPathInDirectory(process.env.OPENCODE_CONFIG_DIR ? path.resolve(process.env.OPENCODE_CONFIG_DIR) : OPENCODE_CONFIG_DIR)
  || path.join(process.env.OPENCODE_CONFIG_DIR ? path.resolve(process.env.OPENCODE_CONFIG_DIR) : OPENCODE_CONFIG_DIR, `${SLIM_CONFIG_BASENAME}.jsonc`)
);

const writeSlimAgentModelOverride = (agentName: string, override: AgentModelOverride): AgentModelOverride => {
  const targetPath = getSlimConfigWritePath();
  const config = readSlimConfigFile(targetPath);
  const agents = isPlainObject(config.agents) ? { ...(config.agents as Record<string, unknown>) } : {};
  const existing = isPlainObject(agents[agentName]) ? { ...(agents[agentName] as Record<string, unknown>) } : {};
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

const deleteSlimAgentModelOverride = (agentName: string): boolean => {
  const targetPath = getSlimConfigWritePath();
  const config = readSlimConfigFile(targetPath);
  const agents = isPlainObject(config.agents) ? { ...(config.agents as Record<string, unknown>) } : {};
  const existing = isPlainObject(agents[agentName]) ? { ...(agents[agentName] as Record<string, unknown>) } : null;
  if (!existing) return false;
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

const encodePluginId = (prefix: string, value: string): string => Buffer.from(`${prefix}:${value}`).toString('base64url');

const isPluginPathSpec = (spec: string): boolean => (
  spec.startsWith('/')
  || spec.startsWith('./')
  || spec.startsWith('../')
  || spec.startsWith('~')
  || path.win32.isAbsolute(spec)
);

const parsePluginRaw = (raw: unknown): { spec: string; options?: Record<string, unknown> } => {
  const normalizeSpec = (spec: unknown): string => {
    if (typeof spec !== 'string' || !spec.trim()) {
      throw new Error('Plugin spec must be a non-empty string');
    }
    if (spec.includes('\0')) {
      throw new Error('Plugin spec cannot contain null bytes');
    }
    return spec.trim();
  };

  if (typeof raw === 'string') {
    return { spec: normalizeSpec(raw) };
  }

  if (Array.isArray(raw) && raw.length === 2 && isPlainObject(raw[1])) {
    return { spec: normalizeSpec(raw[0]), options: { ...raw[1] } };
  }

  throw new Error('Plugin entry must be a string or [string, object]');
};

const listReadonlyPluginEntriesFromSource = (
  source: { scope: PluginScope; path: string; config: Record<string, unknown> },
  errors: PluginConfigError[],
): PluginEntry[] => {
  if (!Array.isArray(source.config.plugin)) {
    return [];
  }

  const entries: PluginEntry[] = [];
  source.config.plugin.forEach((raw, index) => {
    try {
      const parsed = parsePluginRaw(raw);
      entries.push({
        id: encodePluginId('config', `${source.scope}:${source.path}:${index}:${parsed.spec}`),
        spec: parsed.spec,
        ...(parsed.options ? { options: parsed.options } : {}),
        scope: source.scope,
        kind: 'config',
        parsedKind: isPluginPathSpec(parsed.spec) ? 'path' : 'npm',
        sourcePath: source.path,
      });
    } catch (error) {
      errors.push({
        scope: source.scope,
        sourcePath: source.path,
        index,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return entries;
};

const listReadonlyPluginFilesForScope = (scope: PluginScope, pluginDir: string): PluginFile[] => {
  try {
    if (!fs.existsSync(pluginDir)) {
      return [];
    }
    return fs.readdirSync(pluginDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && PLUGIN_FILE_NAME_PATTERN.test(entry.name))
      .map((entry) => ({
        id: encodePluginId('file', `${scope}:${pluginDir}:${entry.name}`),
        fileName: entry.name,
        scope,
        kind: 'file',
        absolutePath: path.join(pluginDir, entry.name),
      }));
  } catch {
    return [];
  }
};

export const listReadonlyPlugins = (workingDirectory?: string): PluginsListResponse => {
  const layers = readConfigLayers(workingDirectory);
  const errors: PluginConfigError[] = [];
  const userConfigPath = layers.paths.customPath || layers.paths.userPath;
  const userConfig = layers.paths.customPath ? layers.customConfig : layers.userConfig;
  const userPluginRoot = layers.paths.customPath ? path.dirname(layers.paths.customPath) : OPENCODE_CONFIG_DIR;

  const sources: Array<{ scope: PluginScope; path: string; config: Record<string, unknown> }> = [
    { scope: 'user', path: userConfigPath, config: userConfig },
  ];
  if (workingDirectory && layers.paths.projectPath && fs.existsSync(layers.paths.projectPath)) {
    sources.push({ scope: 'project', path: layers.paths.projectPath, config: layers.projectConfig });
  }

  const entries = sources.flatMap((source) => listReadonlyPluginEntriesFromSource(source, errors));
  const files = [
      ...listReadonlyPluginFilesForScope('user', path.join(userPluginRoot, 'plugin')),
      ...listReadonlyPluginFilesForScope('user', path.join(userPluginRoot, 'plugins')),
      ...(workingDirectory
        ? [
            ...listReadonlyPluginFilesForScope('project', path.join(workingDirectory, '.opencode', 'plugin')),
            ...listReadonlyPluginFilesForScope('project', path.join(workingDirectory, '.opencode', 'plugins')),
          ]
        : []),
    ];

  return { ...buildDevRyanDefaultPluginInventory({ entries, files }), errors };
};

const getAncestors = (startDir?: string, stopDir?: string): string[] => {
  if (!startDir) return [];
  const result: string[] = [];
  let current = path.resolve(startDir);
  const resolvedStop = stopDir ? path.resolve(stopDir) : null;

  while (true) {
    result.push(current);
    if (resolvedStop && current === resolvedStop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return result;
};

const findWorktreeRoot = (startDir?: string): string | null => {
  if (!startDir) return null;
  let current = path.resolve(startDir);

  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

const walkSkillMdFiles = (rootDir?: string | null): string[] => {
  if (!rootDir || !fs.existsSync(rootDir)) return [];

  const results: string[] = [];
  const walkDir = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === 'SKILL.md') {
        results.push(fullPath);
      }
    }
  };

  walkDir(rootDir);
  return results;
};

const resolveSkillSearchDirectories = (workingDirectory?: string): string[] => {
  const directories: string[] = [];
  const pushDir = (dir?: string | null) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (!directories.includes(resolved)) {
      directories.push(resolved);
    }
  };

  pushDir(OPENCODE_CONFIG_DIR);

  if (workingDirectory) {
    const worktreeRoot = findWorktreeRoot(workingDirectory) || path.resolve(workingDirectory);
    const projectDirs = getAncestors(workingDirectory, worktreeRoot)
      .map((dir) => path.join(dir, '.opencode'));
    projectDirs.forEach(pushDir);
  }

  pushDir(path.join(os.homedir(), '.opencode'));
  pushDir(process.env.OPENCODE_CONFIG_DIR ? path.resolve(process.env.OPENCODE_CONFIG_DIR) : null);

  return directories;
};

const getConfigForPath = (layers: ReturnType<typeof readConfigLayers>, targetPath?: string | null) => {
  if (!targetPath) return layers.userConfig;
  if (layers.paths.customPath && targetPath === layers.paths.customPath) return layers.customConfig;
  if (layers.paths.projectPath && targetPath === layers.paths.projectPath) return layers.projectConfig;
  return layers.userConfig;
};

const writeConfig = (config: Record<string, unknown>, filePath: string = CONFIG_FILE) => {
  if (fs.existsSync(filePath)) {
    const backupFile = `${filePath}.openchamber.backup`;
    try {
      fs.copyFileSync(filePath, backupFile);
    } catch {
      // ignore backup failures
    }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
};


const modelValueToRef = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as { providerID?: unknown; modelID?: unknown; providerId?: unknown; modelId?: unknown };
  const providerID = typeof candidate.providerID === 'string'
    ? candidate.providerID.trim()
    : (typeof candidate.providerId === 'string' ? candidate.providerId.trim() : '');
  const modelID = typeof candidate.modelID === 'string'
    ? candidate.modelID.trim()
    : (typeof candidate.modelId === 'string' ? candidate.modelId.trim() : '');

  return providerID && modelID ? `${providerID}/${modelID}` : null;
};

const parseModelRef = (modelRef: string): { providerID: string; modelID: string } | null => {
  const [providerID, ...modelParts] = modelRef.split('/');
  const modelID = modelParts.join('/');
  if (!providerID || !modelID) {
    return null;
  }
  return { providerID, modelID };
};

const normalizeModelRefs = (model: unknown): string[] => {
  const values = Array.isArray(model) ? model : [model];
  return values
    .map(modelValueToRef)
    .filter((value): value is string => Boolean(value));
};

const applyParsedModelFields = (agent: ConfigAgent, rawModel: unknown) => {
  const rawModelRefs = normalizeModelRefs(rawModel);
  const existingModelRefs = normalizeModelRefs(agent.modelRefs);
  const modelRefs = existingModelRefs.length > 0 ? existingModelRefs : rawModelRefs;
  if (modelRefs.length === 0) {
    return;
  }

  const parsed = parseModelRef(rawModelRefs[0] ?? modelRefs[0]);
  if (parsed) {
    agent.model = parsed;
  }
  agent.modelRefs = modelRefs;
};

const normalizeVariant = (value: unknown): string | null => {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error('Agent override variant must be a string or null');
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeCouncillors = (value: unknown): Array<{ model: string; variant?: string | null }> => {
  if (!Array.isArray(value)) {
    throw new Error('Agent override councillors must be an array');
  }

  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Each councillor override must be an object');
    }
    const candidate = entry as Record<string, unknown>;
    const model = modelValueToRef(candidate.model);
    if (!model) {
      throw new Error('Each councillor override must include a provider/model model');
    }

    const councillor: { model: string; variant?: string | null } = { model };
    if (Object.prototype.hasOwnProperty.call(candidate, 'variant')) {
      councillor.variant = normalizeVariant(candidate.variant);
    }
    return councillor;
  });
};

const normalizeAgentModelOverride = (rawOverride: unknown): AgentModelOverride => {
  if (!rawOverride || typeof rawOverride !== 'object' || Array.isArray(rawOverride)) {
    throw new Error('Agent override must be an object');
  }

  for (const key of Object.keys(rawOverride)) {
    if (!ALLOWED_AGENT_OVERRIDE_KEYS.has(key)) {
      throw new Error('Only model, variant, and councillors can be overridden');
    }
  }

  const source = rawOverride as Record<string, unknown>;
  const override: AgentModelOverride = {};
  if (Object.prototype.hasOwnProperty.call(source, 'model')) {
    const model = modelValueToRef(source.model);
    if (!model) {
      throw new Error('Agent override model must use provider/model format');
    }
    override.model = model;
  }

  if (Object.prototype.hasOwnProperty.call(source, 'variant')) {
    override.variant = normalizeVariant(source.variant);
  }

  if (Object.prototype.hasOwnProperty.call(source, 'councillors')) {
    override.councillors = normalizeCouncillors(source.councillors);
  }

  if (!Object.prototype.hasOwnProperty.call(override, 'model')
    && !Object.prototype.hasOwnProperty.call(override, 'variant')
    && !Object.prototype.hasOwnProperty.call(override, 'councillors')) {
    throw new Error('Agent override must include model, variant, or councillors');
  }

  return override;
};

const getAgentOverridesContainer = (config: Record<string, unknown>): Record<string, unknown> => {
  const namespace = config[OPENCHAMBER_CONFIG_KEY];
  if (!namespace || typeof namespace !== 'object' || Array.isArray(namespace)) {
    return {};
  }

  const overrides = (namespace as Record<string, unknown>)[AGENT_OVERRIDES_CONFIG_KEY];
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return {};
  }

  return overrides as Record<string, unknown>;
};

export const listAgentModelOverrides = (): Record<string, AgentModelOverride> => {
  const config = readUserConfig();
  const overrides = getAgentOverridesContainer(config);
  const normalized: Record<string, AgentModelOverride> = {};

  for (const [agentName, rawOverride] of Object.entries(overrides)) {
    try {
      normalized[agentName] = normalizeAgentModelOverride(rawOverride);
    } catch {
      // Ignore malformed user overrides so one bad entry does not hide agents.
    }
  }

  return normalized;
};

const applyAgentModelOverride = (agent: ConfigAgent, override?: AgentModelOverride): ConfigAgent => {
  if (!override) {
    return {
      ...agent,
      overrides: { model: false, variant: false, councillors: false },
    } as ConfigAgent;
  }

  const next = {
    ...agent,
    overrides: {
      model: Object.prototype.hasOwnProperty.call(override, 'model'),
      variant: Object.prototype.hasOwnProperty.call(override, 'variant'),
      councillors: Array.isArray(override.councillors),
    },
  } as ConfigAgent;

  if (Object.prototype.hasOwnProperty.call(override, 'model')) {
    applyParsedModelFields(next, override.model);
  }

  if (Object.prototype.hasOwnProperty.call(override, 'variant')) {
    next.variant = typeof override.variant === 'string' ? override.variant : null;
  }

  if (Array.isArray(override.councillors)) {
    next.councillors = override.councillors.map((entry) => ({ ...entry }));
    next.modelRefs = override.councillors.map((entry) => entry.model);
  }

  return next;
};

export type McpLocalConfig = {
  type: 'local';
  command?: string[];
  environment?: Record<string, string>;
  enabled?: boolean;
};

export type McpRemoteConfig = {
  type: 'remote';
  url?: string;
  environment?: Record<string, string>;
  headers?: Record<string, string>;
  oauth?: {
    clientId?: string;
    clientSecret?: string;
    scope?: string;
    redirectUri?: string;
  } | false;
  timeout?: number;
  enabled?: boolean;
};

export type McpConfigPayload = McpLocalConfig | McpRemoteConfig;

export type McpConfigEntry = {
  name: string;
  scope?: AgentScope | null;
  type: 'local' | 'remote';
  command?: string[];
  url?: string;
  environment?: Record<string, string>;
  headers?: Record<string, string>;
  oauth?: {
    clientId?: string;
    clientSecret?: string;
    scope?: string;
    redirectUri?: string;
  } | false;
  timeout?: number;
  enabled: boolean;
};

const resolveMcpScopeFromPath = (layers: ReturnType<typeof readConfigLayers>, sourcePath?: string | null): AgentScope | null => {
  if (!sourcePath) return null;
  return sourcePath === layers.paths.projectPath ? AGENT_SCOPE.PROJECT : AGENT_SCOPE.USER;
};

const ensureProjectMcpConfigPath = (workingDirectory: string): string => {
  const projectConfigDir = path.join(workingDirectory, '.opencode');
  if (!fs.existsSync(projectConfigDir)) {
    fs.mkdirSync(projectConfigDir, { recursive: true });
  }
  return path.join(projectConfigDir, 'opencode.json');
};

const validateMcpName = (name: string): void => {
  if (!name || typeof name !== 'string') {
    throw new Error('MCP server name is required');
  }
  if (!/^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/.test(name)) {
    throw new Error('MCP server name must be lowercase alphanumeric with hyphens/underscores');
  }
};

const buildMcpEntry = (data: Record<string, unknown>): Omit<McpConfigEntry, 'name'> => {
  const entry: Omit<McpConfigEntry, 'name'> = {
    type: data.type === 'remote' ? 'remote' : 'local',
    enabled: data.enabled !== false,
  };

  if (entry.type === 'local') {
    if (Array.isArray(data.command) && data.command.length > 0) {
      entry.command = data.command.map((value) => String(value));
    }
  } else {
    if (typeof data.url === 'string' && data.url.trim()) {
      entry.url = data.url.trim();
    }

    if (isPlainObject(data.headers)) {
      const cleanedHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(data.headers)) {
        if (key && value != null) {
          cleanedHeaders[key] = String(value);
        }
      }
      if (Object.keys(cleanedHeaders).length > 0) {
        entry.headers = cleanedHeaders;
      }
    }

    if (data.oauth === false) {
      entry.oauth = false;
    } else if (isPlainObject(data.oauth)) {
      const oauth: Record<string, string> = {};
      const rawOauth = data.oauth as Record<string, unknown>;
      for (const key of ['clientId', 'clientSecret', 'scope', 'redirectUri']) {
        const value = rawOauth[key];
        if (typeof value === 'string' && value.trim()) {
          oauth[key] = value.trim();
        }
      }
      if (Object.keys(oauth).length > 0) {
        entry.oauth = oauth;
      }
    }

    if (typeof data.timeout === 'number' && Number.isFinite(data.timeout) && data.timeout > 0) {
      entry.timeout = data.timeout;
    }
  }

  if (isPlainObject(data.environment)) {
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(data.environment)) {
      if (key && value != null) {
        cleaned[key] = String(value);
      }
    }
    if (Object.keys(cleaned).length > 0) {
      entry.environment = cleaned;
    }
  }

  return entry;
};

const mcpIdentityFields = (entry: Record<string, unknown>): Record<string, unknown> => {
  const normalized = buildMcpEntry(entry);
  return {
    type: normalized.type,
    url: normalized.type === 'remote' ? normalized.url ?? null : null,
    oauth: normalized.type === 'remote' ? normalized.oauth ?? null : null,
  };
};

const didMcpAuthIdentityChange = (before: Record<string, unknown>, after: Record<string, unknown>): boolean =>
  JSON.stringify(mcpIdentityFields(before)) !== JSON.stringify(mcpIdentityFields(after));

export const listMcpConfigs = (workingDirectory?: string): McpConfigEntry[] => {
  const layers = readConfigLayers(workingDirectory);
  const merged = (layers.mergedConfig as Record<string, unknown>) || {};
  const mcp = isPlainObject(merged.mcp) ? merged.mcp : {};
  return Object.entries(mcp)
    .filter(([, value]) => isPlainObject(value))
    .map(([name, value]) => {
      const source = getJsonEntrySource(layers, 'mcp', name);
      return {
        name,
        ...buildMcpEntry(value as Record<string, unknown>),
        scope: resolveMcpScopeFromPath(layers, source.path),
      };
    });
};

export const getMcpConfig = (name: string, workingDirectory?: string): McpConfigEntry | null => {
  const layers = readConfigLayers(workingDirectory);
  const merged = (layers.mergedConfig as Record<string, unknown>) || {};
  const mcp = isPlainObject(merged.mcp) ? merged.mcp : {};
  const entry = mcp[name];
  if (!isPlainObject(entry)) {
    return null;
  }
  const source = getJsonEntrySource(layers, 'mcp', name);
  return {
    name,
    ...buildMcpEntry(entry as Record<string, unknown>),
    scope: resolveMcpScopeFromPath(layers, source.path),
  };
};

export const createMcpConfig = (
  name: string,
  mcpConfig: Record<string, unknown>,
  workingDirectory?: string,
  scope?: AgentScope,
) => {
  validateMcpName(name);

  const layers = readConfigLayers(workingDirectory);
  const source = getJsonEntrySource(layers, 'mcp', name);
  if (source.exists) {
    throw new Error(`MCP server "${name}" already exists`);
  }

  let targetPath = CONFIG_FILE;
  let config: Record<string, unknown> = {};

  if (scope === AGENT_SCOPE.PROJECT) {
    if (!workingDirectory) {
      throw new Error('Project scope requires working directory');
    }
    targetPath = ensureProjectMcpConfigPath(workingDirectory);
    config = readConfigFile(targetPath);
  } else {
    const jsonTarget = getJsonWriteTarget(layers, AGENT_SCOPE.USER);
    targetPath = jsonTarget.path || CONFIG_FILE;
    config = (jsonTarget.config || {}) as Record<string, unknown>;
  }

  const mcp = isPlainObject(config.mcp) ? { ...config.mcp } : {};

  const { name: _ignoredName, ...entryData } = mcpConfig;
  void _ignoredName;
  mcp[name] = buildMcpEntry(entryData);
  config.mcp = mcp;
  writeConfig(config, targetPath);
  return { authReset: removeMcpAuthCacheEntry(name) };
};

export const updateMcpConfig = (name: string, updates: Record<string, unknown>, workingDirectory?: string) => {
  const layers = readConfigLayers(workingDirectory);
  const source = getJsonEntrySource(layers, 'mcp', name);
  const targetPath = source.path || CONFIG_FILE;
  const config = (source.config || readConfigFile(targetPath)) as Record<string, unknown>;
  const mcp = isPlainObject(config.mcp) ? { ...config.mcp } : {};
  const existing = isPlainObject(mcp[name]) ? mcp[name] : {};

  const { name: _ignoredName, ...updateData } = updates;
  void _ignoredName;
  const nextEntry = buildMcpEntry({ ...(existing as Record<string, unknown>), ...updateData });
  const shouldResetAuth = didMcpAuthIdentityChange(existing as Record<string, unknown>, nextEntry as Record<string, unknown>);
  mcp[name] = nextEntry;
  config.mcp = mcp;
  writeConfig(config, targetPath);
  return {
    authReset: shouldResetAuth
      ? removeMcpAuthCacheEntry(name)
      : { ok: true, removed: false },
  };
};

export const deleteMcpConfig = (name: string, workingDirectory?: string) => {
  const layers = readConfigLayers(workingDirectory);
  const source = getJsonEntrySource(layers, 'mcp', name);
  if (!source.exists) {
    throw new Error(`MCP server "${name}" not found`);
  }

  const targetPaths = [
    ...USER_CONFIG_PATHS,
    ...getProjectConfigCandidates(workingDirectory),
    ...(CUSTOM_CONFIG_FILE ? [CUSTOM_CONFIG_FILE] : []),
  ];
  for (const targetPath of Array.from(new Set(targetPaths)).filter(Boolean)) {
    const config = readConfigFile(targetPath);
    const mcp = isPlainObject(config.mcp) ? { ...config.mcp } : {};
    if (mcp[name] === undefined) {
      continue;
    }

    delete mcp[name];
    if (Object.keys(mcp).length === 0) {
      delete config.mcp;
    } else {
      config.mcp = mcp;
    }
    writeConfig(config, targetPath);
  }
  markMcpRecoveryDeleted(name);
  return { authReset: removeMcpAuthCacheEntry(name) };
};

const splitMcpCommand = (value: string): string[] =>
  value.trim().split(/\s+/).filter(Boolean);

const normalizeLegacyMcpServer = (raw: unknown): Record<string, unknown> | null => {
  if (!isPlainObject(raw)) return null;
  const command: string[] = [];
  if (Array.isArray(raw.command)) {
    command.push(...raw.command.map((value) => String(value)).filter(Boolean));
  } else if (typeof raw.command === 'string' && raw.command.trim()) {
    command.push(...splitMcpCommand(raw.command));
  }
  if (Array.isArray(raw.args)) {
    command.push(...raw.args.map((value) => String(value)).filter(Boolean));
  }
  const entry: Record<string, unknown> = {
    ...raw,
    type: raw.type === 'remote' || (typeof raw.url === 'string' && raw.url.trim()) ? 'remote' : 'local',
  };
  if (command.length > 0) entry.command = command;
  if (!entry.environment && isPlainObject(raw.env)) entry.environment = raw.env;
  delete entry.args;
  delete entry.env;
  return entry;
};

const isRecoverableMcpEntry = (entry: Omit<McpConfigEntry, 'name'>): boolean => {
  if (entry.type === 'remote') return typeof entry.url === 'string' && entry.url.trim().length > 0;
  return Array.isArray(entry.command) && entry.command.length > 0;
};

const mcpRecoveryFingerprint = (sourcePath: string, name: string, raw: unknown): string =>
  `${sourcePath}::${name}::${crypto.createHash('sha256').update(JSON.stringify(raw)).digest('hex')}`;

const readMcpRecoveryManifest = (): { version: 1; considered: Record<string, unknown>; deleted: Record<string, unknown> } => {
  const parsed = readConfigFile(MCP_RECOVERY_MANIFEST_PATH);
  return {
    version: 1,
    considered: isPlainObject(parsed.considered) ? parsed.considered : {},
    deleted: isPlainObject(parsed.deleted) ? parsed.deleted : {},
  };
};

const writeMcpRecoveryManifest = (manifest: { version: 1; considered: Record<string, unknown>; deleted?: Record<string, unknown> }): void => {
  fs.mkdirSync(path.dirname(MCP_RECOVERY_MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MCP_RECOVERY_MANIFEST_PATH, JSON.stringify({
    version: 1,
    considered: isPlainObject(manifest.considered) ? manifest.considered : {},
    deleted: isPlainObject(manifest.deleted) ? manifest.deleted : {},
  }, null, 2), 'utf8');
};

const markMcpRecoveryDeleted = (name: string): void => {
  if (!name) return;
  const manifest = readMcpRecoveryManifest();
  manifest.deleted[name] = { deletedAt: Date.now() };
  writeMcpRecoveryManifest(manifest);
};

const backupPathsFor = (configPath: string): string[] => [
  `${configPath}.openchamber.backup`,
  `${configPath}.bak`,
];

const collectMcpNamesFromFile = (filePath: string): Set<string> => {
  const config = readConfigFile(filePath);
  const mcp = isPlainObject(config.mcp) ? config.mcp : {};
  return new Set(Object.keys(mcp));
};

const collectMcpRecoveryEntries = (filePath: string): Array<{ name: string; raw: Record<string, unknown>; entry: Omit<McpConfigEntry, 'name'> }> => {
  const config = readConfigFile(filePath);
  const entries: Array<{ name: string; raw: Record<string, unknown>; entry: Omit<McpConfigEntry, 'name'> }> = [];
  if (isPlainObject(config.mcp)) {
    for (const [name, raw] of Object.entries(config.mcp)) {
      if (isPlainObject(raw)) entries.push({ name, raw, entry: buildMcpEntry(raw) });
    }
  }
  if (isPlainObject(config.mcpServers)) {
    for (const [name, raw] of Object.entries(config.mcpServers)) {
      const normalized = normalizeLegacyMcpServer(raw);
      if (normalized) entries.push({ name, raw: normalized, entry: buildMcpEntry(normalized) });
    }
  }
  return entries;
};

const writeRecoveredMcpConfig = (config: Record<string, unknown>, filePath: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
};

export const recoverMcpConfigs = (workingDirectory?: string): {
  migrated: Array<{ name: string; scope: AgentScope; targetPath: string }>;
  skipped: Array<{ name: string; reason: string }>;
} => {
  const manifest = readMcpRecoveryManifest();
  const migrated: Array<{ name: string; scope: AgentScope; targetPath: string }> = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  let manifestChanged = false;
  const activeNames = new Set<string>();
  for (const userPath of USER_CONFIG_PATHS) {
    for (const name of collectMcpNamesFromFile(userPath)) activeNames.add(name);
  }
  for (const projectPath of getProjectConfigCandidates(workingDirectory).filter((filePath) => !filePath.includes(`${path.sep}.opencode${path.sep}`))) {
    for (const name of collectMcpNamesFromFile(projectPath)) activeNames.add(name);
  }
  if (CUSTOM_CONFIG_FILE) {
    for (const name of collectMcpNamesFromFile(CUSTOM_CONFIG_FILE)) activeNames.add(name);
  }

  const sources: Array<{ filePath: string; scope: AgentScope; targetPath: string }> = [];
  for (const userPath of USER_CONFIG_PATHS) {
    for (const backupPath of backupPathsFor(userPath)) {
      if (fs.existsSync(backupPath)) sources.push({ filePath: backupPath, scope: AGENT_SCOPE.USER, targetPath: OFFICIAL_USER_CONFIG_FILE });
    }
  }
  if (workingDirectory) {
    const targetPath = getProjectConfigPath(workingDirectory) || path.join(workingDirectory, 'opencode.json');
    for (const projectPath of getProjectConfigCandidates(workingDirectory).filter((filePath) => !filePath.includes(`${path.sep}.opencode${path.sep}`))) {
      for (const backupPath of backupPathsFor(projectPath)) {
        if (fs.existsSync(backupPath)) sources.push({ filePath: backupPath, scope: AGENT_SCOPE.PROJECT, targetPath });
      }
    }
    for (const legacyPath of getProjectConfigCandidates(workingDirectory).filter((filePath) => filePath.includes(`${path.sep}.opencode${path.sep}`))) {
      if (fs.existsSync(legacyPath)) sources.push({ filePath: legacyPath, scope: AGENT_SCOPE.PROJECT, targetPath });
      for (const backupPath of backupPathsFor(legacyPath)) {
        if (fs.existsSync(backupPath)) sources.push({ filePath: backupPath, scope: AGENT_SCOPE.PROJECT, targetPath });
      }
    }
  }

  for (const source of sources) {
    for (const candidate of collectMcpRecoveryEntries(source.filePath)) {
      const fingerprint = mcpRecoveryFingerprint(source.filePath, candidate.name, candidate.raw);
      if (manifest.considered[fingerprint]) {
        skipped.push({ name: candidate.name, reason: 'already considered' });
        continue;
      }
      try {
        validateMcpName(candidate.name);
      } catch {
        skipped.push({ name: candidate.name, reason: 'invalid name' });
        continue;
      }
      if (manifest.deleted[candidate.name]) {
        skipped.push({ name: candidate.name, reason: 'deleted' });
        if (!manifest.considered[fingerprint]) {
          manifest.considered[fingerprint] = {
            name: candidate.name,
            sourcePath: source.filePath,
            targetPath: source.targetPath,
            skippedAt: Date.now(),
            reason: 'deleted',
          };
          manifestChanged = true;
        }
        continue;
      }
      if (activeNames.has(candidate.name)) {
        skipped.push({ name: candidate.name, reason: 'already configured' });
        continue;
      }
      if (!isRecoverableMcpEntry(candidate.entry)) {
        skipped.push({ name: candidate.name, reason: 'invalid config' });
        continue;
      }
      const targetConfig = readConfigFile(source.targetPath);
      const targetMcp = isPlainObject(targetConfig.mcp) ? targetConfig.mcp : {};
      targetConfig.mcp = { ...targetMcp, [candidate.name]: candidate.entry };
      writeRecoveredMcpConfig(targetConfig, source.targetPath);
      manifest.considered[fingerprint] = {
        name: candidate.name,
        sourcePath: source.filePath,
        targetPath: source.targetPath,
        recoveredAt: Date.now(),
      };
      manifestChanged = true;
      activeNames.add(candidate.name);
      migrated.push({ name: candidate.name, scope: source.scope, targetPath: source.targetPath });
    }
  }
  if (manifestChanged) writeMcpRecoveryManifest(manifest);
  return { migrated, skipped };
};

const getJsonEntrySource = (
  layers: ReturnType<typeof readConfigLayers>,
  sectionKey: 'agent' | 'command' | 'mcp',
  entryName: string
) => {
  const { userConfig, projectConfig, customConfig, paths } = layers;
  const customSection = (customConfig as Record<string, unknown>)?.[sectionKey] as Record<string, unknown> | undefined;
  if (customSection?.[entryName] !== undefined) {
    return { section: customSection[entryName], config: customConfig, path: paths.customPath, exists: true };
  }

  const projectSection = (projectConfig as Record<string, unknown>)?.[sectionKey] as Record<string, unknown> | undefined;
  if (projectSection?.[entryName] !== undefined) {
    return { section: projectSection[entryName], config: projectConfig, path: paths.projectPath, exists: true };
  }

  const userSection = (userConfig as Record<string, unknown>)?.[sectionKey] as Record<string, unknown> | undefined;
  if (userSection?.[entryName] !== undefined) {
    return { section: userSection[entryName], config: userConfig, path: paths.userPath, exists: true };
  }

  return { section: null, config: null, path: null, exists: false };
};

const getJsonWriteTarget = (
  layers: ReturnType<typeof readConfigLayers>,
  preferredScope: AgentScope | CommandScope
) => {
  const { userConfig, projectConfig, customConfig, paths } = layers;
  if (paths.customPath) {
    return { config: customConfig, path: paths.customPath };
  }
  if (preferredScope === AGENT_SCOPE.PROJECT && paths.projectPath) {
    return { config: projectConfig, path: paths.projectPath };
  }
  return { config: userConfig, path: paths.userPath };
};

const parseMdFile = (filePath: string): { frontmatter: Record<string, unknown>; body: string } => {
  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content.trim() };
  let frontmatter: Record<string, unknown> = {};
  try {
    frontmatter = (yaml.parse(match[1]) || {}) as Record<string, unknown>;
  } catch (error) {
    console.warn(`[OpenChamber][VSCode] Failed to parse frontmatter for ${filePath}, treating as empty:`, error);
    frontmatter = {};
  }
  return { frontmatter, body: (match[2] || '').trim() };
};

const writeMdFile = (filePath: string, frontmatter: Record<string, unknown>, body: string) => {
  // Filter out null/undefined values - OpenCode expects keys to be omitted rather than set to null
  const cleanedFrontmatter = Object.fromEntries(
    Object.entries(frontmatter ?? {}).filter(([, value]) => value != null)
  );
  const yamlStr = yaml.stringify(cleanedFrontmatter);
  const content = `---\n${yamlStr}---\n\n${body ?? ''}`.trimEnd();
  fs.writeFileSync(filePath, content, 'utf8');
};

const parseAgentMdFile = (filePath: string, scope: AgentScope, rootDir?: string): ConfigAgent => {
  const { frontmatter, body } = parseMdFile(filePath);
  const agent = {
    name: path.basename(filePath, '.md'),
    ...frontmatter,
    ...(body ? { prompt: body } : {}),
    scope,
    source: scope,
    group: rootDir && path.dirname(filePath) !== rootDir
      ? path.relative(rootDir, path.dirname(filePath)).split(path.sep)[0]
      : undefined,
    native: scope === AGENT_SCOPE.PACKAGED,
    builtIn: scope === AGENT_SCOPE.PACKAGED,
  } as ConfigAgent;

  Object.defineProperty(agent, '__path', { value: filePath, enumerable: false });
  applyParsedModelFields(agent, frontmatter.model);
  return agent;
};

const listAgentsFromRoot = (agentRoot: string, scope: AgentScope): ConfigAgent[] => {
  if (!fs.existsSync(agentRoot)) {
    return [];
  }

  const agentsByName = new Map<string, ConfigAgent>();
  const dirsToVisit = [agentRoot];
  while (dirsToVisit.length > 0) {
    const dir = dirsToVisit.pop();
    if (!dir) {
      continue;
    }

    let entries: fs.Dirent[];
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
      if (!entry.isFile() || !entry.name.endsWith('.md')) {
        continue;
      }

      const name = entry.name.slice(0, -3);
      if (!agentsByName.has(name)) {
        agentsByName.set(name, parseAgentMdFile(entryPath, scope, agentRoot));
      }
    }
  }

  return Array.from(agentsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
};

const getPackagedAgentRoots = (): string[] => {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'web', 'server', 'default-config', 'agents'),
    path.resolve(__dirname, '..', 'web', 'server', 'default-config', 'agents'),
    path.resolve(__dirname, 'default-config', 'agents'),
  ];
  return candidates.filter((candidate, index) => fs.existsSync(candidate) && candidates.indexOf(candidate) === index);
};

type PackagedRuntimePlugin = {
  fileName: string;
  spec: string;
  content: string;
};

const getPackagedPluginRoots = (): string[] => {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'web', 'server', 'default-config', 'plugins'),
    path.resolve(__dirname, '..', 'web', 'server', 'default-config', 'plugins'),
    path.resolve(__dirname, 'default-config', 'plugins'),
  ];
  return candidates.filter((candidate, index) => fs.existsSync(candidate) && candidates.indexOf(candidate) === index);
};

const isRuntimePluginFileName = (fileName: string): boolean => (
  !fileName.endsWith('.d.ts')
  && !/(^|[.-])(test|spec)\./.test(fileName)
  && RUNTIME_PLUGIN_EXTENSIONS.has(path.extname(fileName))
);

const listPackagedRuntimePlugins = (): PackagedRuntimePlugin[] => {
  const pluginsByName = new Map<string, PackagedRuntimePlugin>();
  for (const pluginRoot of getPackagedPluginRoots()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(pluginRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isFile() || !isRuntimePluginFileName(entry.name) || pluginsByName.has(entry.name)) {
        continue;
      }
      const content = fs.readFileSync(path.join(pluginRoot, entry.name), 'utf8');
      pluginsByName.set(entry.name, {
        fileName: entry.name,
        spec: `./plugins/${entry.name}`,
        content,
      });
    }
  }
  return Array.from(pluginsByName.values()).sort((a, b) => a.fileName.localeCompare(b.fileName));
};

const listPackagedConfigAgents = (): ConfigAgent[] => {
  const agentsByName = new Map<string, ConfigAgent>();
  for (const agentRoot of getPackagedAgentRoots()) {
    for (const agent of listAgentsFromRoot(agentRoot, AGENT_SCOPE.PACKAGED)) {
      if (!agentsByName.has(agent.name)) {
        agentsByName.set(agent.name, agent);
      }
    }
  }
  return Array.from(agentsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
};

const listProjectConfigAgents = (workingDirectory?: string): ConfigAgent[] => {
  if (!workingDirectory) {
    return [];
  }
  return listAgentsFromRoot(path.join(workingDirectory, '.opencode', 'agents'), AGENT_SCOPE.PROJECT);
};

const listDevRyanBaseConfigAgents = (workingDirectory?: string): ConfigAgent[] => {
  const agentsByName = new Map<string, ConfigAgent>();
  for (const agent of listPackagedConfigAgents()) {
    agentsByName.set(agent.name, agent);
  }
  for (const agent of listProjectConfigAgents(workingDirectory)) {
    agentsByName.set(agent.name, agent);
  }
  return Array.from(agentsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
};

const listManagedRuntimeAgentModelOverrides = (workingDirectory?: string): Record<string, AgentModelOverride> => {
  const overrides = { ...listAgentModelOverrides() };
  const slim = resolveSlimConfig(workingDirectory);
  if (!slim.wrapperPluginEnabled || slim.slimAgentCatalogEnabled) {
    return overrides;
  }

  const devRyanAgentNames = new Set(
    listDevRyanBaseConfigAgents(workingDirectory).map((agent) => agent.name),
  );
  for (const [agentName, slimAgent] of Object.entries(slim.agents)) {
    if (!devRyanAgentNames.has(agentName)) {
      continue;
    }

    const modelRef = normalizeModelRefs(slimAgent.modelRefs)[0]
      || modelValueToRef(slimAgent.model);
    overrides[agentName] = {
      ...(overrides[agentName] || {}),
      ...(modelRef ? { model: modelRef } : {}),
      variant: typeof slimAgent.variant === 'string' && slimAgent.variant.trim()
        ? slimAgent.variant.trim()
        : null,
    };
  }

  return overrides;
};

const applySlimModelMetadata = (agent: ConfigAgent, slimAgent?: ConfigAgent): ConfigAgent => {
  if (!slimAgent) return agent;
  const next = {
    ...agent,
    overrides: {
      model: Boolean((slimAgent.overrides as Record<string, unknown> | undefined)?.model),
      variant: Boolean((slimAgent.overrides as Record<string, unknown> | undefined)?.variant),
      councillors: false,
    },
    slimRuntimeModel: true,
  } as ConfigAgent;
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
};

const listSlimInstalledAgents = (slim: ReturnType<typeof resolveSlimConfig>): ConfigAgent[] => {
  const disabled = getSlimDisabledAgents(slim.mergedConfig);
  return listAgentsFromRoot(path.join(slim.configDirectory, 'agents'), AGENT_SCOPE.SLIM)
    .filter((agent) => (
      !disabled.has(agent.name)
      && (SLIM_REPLACED_AGENT_NAMES.has(agent.name) || Object.prototype.hasOwnProperty.call(slim.agents, agent.name))
    ))
    .map((agent) => ({
      ...agent,
      scope: AGENT_SCOPE.SLIM,
      source: AGENT_SCOPE.SLIM,
      native: true,
      builtIn: true,
      slim: true,
      overrides: {
        model: false,
        variant: false,
        councillors: false,
      },
    }));
};

const mergeSlimAgentLayers = (installedAgent: ConfigAgent | undefined, configAgent: ConfigAgent | undefined): ConfigAgent | undefined => {
  if (!installedAgent) return configAgent;
  if (!configAgent) return installedAgent;
  const merged = {
    ...installedAgent,
    ...configAgent,
    prompt: configAgent.prompt ?? installedAgent.prompt,
  } as ConfigAgent;
  if (typeof installedAgent.__path === 'string') {
    Object.defineProperty(merged, '__path', { value: installedAgent.__path, enumerable: false });
  }
  return merged;
};

const getSlimConfigAgents = (workingDirectory?: string): Record<string, ConfigAgent> => {
  const slim = resolveSlimConfig(workingDirectory);
  if (!slim.slimAgentCatalogEnabled) {
    return {};
  }

  return getSlimAgentsFromResolvedConfig(slim);
};

const getSlimAgentsFromResolvedConfig = (slim: ReturnType<typeof resolveSlimConfig>): Record<string, ConfigAgent> => {
  if (!slim.pluginEnabled) {
    return {};
  }

  const agentsByName = new Map<string, ConfigAgent>();
  for (const agent of listSlimInstalledAgents(slim)) {
    agentsByName.set(agent.name, agent);
  }
  for (const [name, configAgent] of Object.entries(slim.agents)) {
    const merged = mergeSlimAgentLayers(agentsByName.get(name), configAgent);
    if (merged) {
      agentsByName.set(name, merged);
    }
  }

  return Object.fromEntries(Array.from(agentsByName.entries()).sort(([a], [b]) => a.localeCompare(b)));
};

const getSlimRuntimeModelAgents = (workingDirectory?: string): Record<string, ConfigAgent> => {
  const slim = resolveSlimConfig(workingDirectory);
  if (!slim.pluginEnabled || slim.slimAgentCatalogEnabled) return {};
  return getSlimAgentsFromResolvedConfig(slim);
};

const getBaseConfigAgents = (workingDirectory?: string): ConfigAgent[] => {
  const slim = resolveSlimConfig(workingDirectory);
  const slimAgents = getSlimConfigAgents(workingDirectory);
  if (slim.slimAgentCatalogEnabled && Object.keys(slimAgents).length > 0) {
    const agentsByName = new Map<string, ConfigAgent>(Object.entries(slimAgents));
    for (const agent of listProjectConfigAgents(workingDirectory)) {
      if (SLIM_REPLACED_AGENT_NAMES.has(agent.name)) {
        continue;
      }
      agentsByName.set(agent.name, agent);
    }
    return Array.from(agentsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  const agentsByName = new Map<string, ConfigAgent>(listDevRyanBaseConfigAgents(workingDirectory).map((agent) => [agent.name, agent]));
  if (slim.pluginEnabled && !slim.slimAgentCatalogEnabled) {
    const slimRuntimeAgents = getSlimRuntimeModelAgents(workingDirectory);
    for (const [name, slimAgent] of Object.entries(slimRuntimeAgents)) {
      const existing = agentsByName.get(name);
      agentsByName.set(name, existing ? applySlimModelMetadata(existing, slimAgent) : slimAgent);
    }
  }
  return Array.from(agentsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
};

const assertKnownAgentName = (agentName: string, workingDirectory?: string) => {
  const exists = getBaseConfigAgents(workingDirectory).some((agent) => agent.name === agentName);
  if (!exists) {
    throw new Error(`Agent "${agentName}" not found`);
  }
};

export const listConfigAgents = (workingDirectory?: string): ConfigAgent[] => {
  const overrides = listAgentModelOverrides();
  return getBaseConfigAgents(workingDirectory)
    .map((agent) => (agent.source === AGENT_SCOPE.SLIM || agent.slimRuntimeModel
      ? agent
      : applyAgentModelOverride(agent, overrides[agent.name])))
    .sort((a, b) => a.name.localeCompare(b.name));
};

export const getAgentConfig = (agentName: string, workingDirectory?: string): { source: string; scope: AgentScope | null; config: ConfigAgent | Record<string, never> } => {
  const overrides = listAgentModelOverrides();
  const slimAgents = getSlimConfigAgents(workingDirectory);
  if (slimAgents[agentName]) {
    return {
      source: 'slim',
      scope: AGENT_SCOPE.SLIM,
      config: slimAgents[agentName],
    };
  }
  const slimRuntimeAgents = getSlimRuntimeModelAgents(workingDirectory);

  const projectPath = workingDirectory ? getProjectAgentPath(workingDirectory, agentName) : null;
  if (projectPath && fs.existsSync(projectPath)) {
    const baseConfig = parseAgentMdFile(projectPath, AGENT_SCOPE.PROJECT, path.join(workingDirectory!, '.opencode', 'agents'));
    const modelConfig = applySlimModelMetadata(baseConfig, slimRuntimeAgents[agentName]);
    return {
      source: 'md',
      scope: AGENT_SCOPE.PROJECT,
      config: modelConfig.slimRuntimeModel ? modelConfig : applyAgentModelOverride(modelConfig, overrides[agentName]),
    };
  }

  const packagedAgent = listPackagedConfigAgents().find((agent) => agent.name === agentName);
  if (packagedAgent) {
    const modelConfig = applySlimModelMetadata(packagedAgent, slimRuntimeAgents[agentName]);
    return {
      source: 'md',
      scope: AGENT_SCOPE.PACKAGED,
      config: modelConfig.slimRuntimeModel ? modelConfig : applyAgentModelOverride(modelConfig, overrides[agentName]),
    };
  }

  if (slimRuntimeAgents[agentName]) {
    return {
      source: 'slim',
      scope: AGENT_SCOPE.SLIM,
      config: slimRuntimeAgents[agentName],
    };
  }

  return { source: 'none', scope: null, config: {} };
};

const hashRuntimeOverlayKey = (workingDirectory: string): string =>
  crypto.createHash('sha256').update(path.resolve(workingDirectory)).digest('hex');

const formatAgentMarkdown = (frontmatter: Record<string, unknown>, body: string): string => {
  const yamlContent = yaml.stringify(frontmatter).trimEnd();
  return `---\n${yamlContent}\n---\n\n${body.trim()}\n`;
};

const normalizeRuntimeExternalDirectoryVariants = (directory?: string | null): string[] => {
  if (typeof directory !== 'string' || !directory.trim()) {
    return [];
  }
  const resolved = path.resolve(directory.trim());
  const candidates = [resolved];
  try {
    const real = fs.realpathSync(resolved);
    if (real && real !== resolved) {
      candidates.push(real);
    }
  } catch {
    // Missing directories still need their normalized path pattern.
  }
  return candidates;
};

const buildRuntimeExternalDirectories = (workingDirectory?: string): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  const addDirectory = (directory?: string | null) => {
    for (const normalized of normalizeRuntimeExternalDirectoryVariants(directory)) {
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      result.push(normalized);
    }
  };

  addDirectory(workingDirectory);
  addDirectory(findWorktreeRoot(workingDirectory));
  addDirectory(resolveProjectPlansDirectory(workingDirectory));
  return result.sort((a, b) => a.localeCompare(b));
};

const toDirectoryAllowPattern = (directory: string): string => `${directory.replace(/\/+$/, '')}/*`;

const applyRuntimeExternalDirectoryPolicy = (
  frontmatter: Record<string, unknown>,
  runtimeExternalDirectories: string[],
): Record<string, unknown> => {
  if (runtimeExternalDirectories.length === 0) {
    return frontmatter;
  }
  const permission = isPlainObject(frontmatter.permission)
    ? frontmatter.permission
    : null;
  if (!permission) {
    return frontmatter;
  }

  const externalDirectory = isPlainObject(permission.external_directory)
    ? { ...permission.external_directory }
    : {};
  let changed = !isPlainObject(permission.external_directory);
  for (const directory of runtimeExternalDirectories) {
    const pattern = toDirectoryAllowPattern(directory);
    if (externalDirectory[pattern] === 'allow') {
      continue;
    }
    externalDirectory[pattern] = 'allow';
    changed = true;
  }

  if (!changed) {
    return frontmatter;
  }

  return {
    ...frontmatter,
    permission: {
      ...permission,
      external_directory: Object.fromEntries(
        Object.entries(externalDirectory).sort(([a], [b]) => a.localeCompare(b)),
      ),
    },
  };
};

const readRuntimeOverlayManifest = (): Record<string, unknown> => {
  try {
    const content = fs.readFileSync(RUNTIME_AGENT_OVERLAY_MANIFEST_PATH, 'utf8').trim();
    if (!content) return { version: 1, projects: {} };
    const parsed = JSON.parse(content) as unknown;
    if (!isPlainObject(parsed)) return { version: 1, projects: {} };
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      projects: isPlainObject(parsed.projects) ? parsed.projects : {},
    };
  } catch {
    return { version: 1, projects: {} };
  }
};

const writeRuntimeOverlayManifest = (manifest: Record<string, unknown>) => {
  fs.mkdirSync(path.dirname(RUNTIME_AGENT_OVERLAY_MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(RUNTIME_AGENT_OVERLAY_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
};

const applyRuntimeAgentOverride = (
  agent: ConfigAgent,
  override: AgentModelOverride | undefined,
  runtimeExternalDirectories: string[] = [],
  skillPolicy: VisibleSkillPolicy | null = null,
): string | null => {
  const sourcePath = typeof agent.__path === 'string' ? agent.__path : null;
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return null;
  }

  const { frontmatter, body } = parseMdFile(sourcePath);
  const frontmatterWithRuntimeDirectories = applyRuntimeExternalDirectoryPolicy(
    { ...frontmatter },
    runtimeExternalDirectories,
  );
  const shouldApplySkillPolicy = Boolean(skillPolicy) && (
    agent.scope === AGENT_SCOPE.PACKAGED
    || (
      agent.scope === AGENT_SCOPE.PROJECT
      && isPlainObject(frontmatterWithRuntimeDirectories.permission)
      && (
        frontmatterWithRuntimeDirectories.permission.skill === 'allow'
        || isPlainObject(frontmatterWithRuntimeDirectories.permission.skill)
      )
    )
  );
  const next = shouldApplySkillPolicy
    ? sanitizeAgentSkillPolicy(frontmatterWithRuntimeDirectories, skillPolicy)
    : frontmatterWithRuntimeDirectories;

  if (override && Object.prototype.hasOwnProperty.call(override, 'model')) {
    next.model = override.model;
    next.modelRefs = [override.model];
  }

  if (override && Object.prototype.hasOwnProperty.call(override, 'variant')) {
    next.variant = typeof override.variant === 'string'
      ? override.variant
      : CLEARED_VARIANT_SENTINEL;
  }

  if (override && Array.isArray(override.councillors)) {
    next.councillors = override.councillors.map((entry) => ({ ...entry }));
    next.modelRefs = override.councillors.map((entry) => entry.model);
  }

  return formatAgentMarkdown(next, body);
};

export const getRuntimeAgentOverlayConfigDirectory = (workingDirectory?: string): string | null => {
  if (!workingDirectory) return null;
  return path.join(RUNTIME_AGENT_OVERLAY_ROOT, hashRuntimeOverlayKey(workingDirectory));
};

const normalizePluginSpec = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const getPluginEntrySpec = (entry: unknown): string => {
  if (typeof entry === 'string') {
    return normalizePluginSpec(entry);
  }
  if (Array.isArray(entry)) {
    return normalizePluginSpec(entry[0]);
  }
  return '';
};

const isAllowedManagedRuntimePluginSpec = (spec: string): boolean => {
  const normalized = normalizePluginSpec(spec);
  if (!normalized) {
    return false;
  }
  if (ALLOWED_MANAGED_RUNTIME_PLUGIN_SPECS.has(normalized)) {
    return true;
  }
  if (isAnthropicOAuthPluginSpec(normalized)) {
    return true;
  }
  return ALLOWED_MANAGED_RUNTIME_PLUGIN_SPEC_PREFIXES.some((prefix) => normalized.startsWith(prefix));
};

const filterManagedRuntimePluginEntries = (entries: unknown[]): unknown[] => (
  entries.filter((entry) => isAllowedManagedRuntimePluginSpec(getPluginEntrySpec(entry)))
);

const pushUniquePluginEntry = (target: unknown[], seenSpecs: Set<string>, entry: unknown): void => {
  const spec = getPluginEntrySpec(entry);
  if (!spec || seenSpecs.has(spec)) {
    return;
  }
  seenSpecs.add(spec);
  target.push(entry);
};

const buildBlockedManagedRuntimeMcpOverlay = (workingDirectory?: string): Record<string, unknown> | null => {
  const explicitlyConfiguredNames = new Set(
    listMcpConfigs(workingDirectory)
      .map((config) => (typeof config.name === 'string' ? config.name.trim() : ''))
      .filter(Boolean),
  );
  const mcp: Record<string, { enabled: false }> = {};
  for (const name of BLOCKED_MANAGED_RUNTIME_MCP_NAMES) {
    if (explicitlyConfiguredNames.has(name)) {
      continue;
    }
    mcp[name] = { enabled: false };
  }
  return Object.keys(mcp).length > 0 ? { mcp } : null;
};

const buildOpenAITimeoutOverlay = (activeConfig: Record<string, unknown>): Record<string, unknown> | null => {
  const providers = isPlainObject(activeConfig.provider)
    ? activeConfig.provider as Record<string, unknown>
    : {};
  const openAIProvider = isPlainObject(providers.openai)
    ? providers.openai as Record<string, unknown>
    : null;
  let hasOpenAIAuth = false;

  try {
    const auth = readAuthFile();
    hasOpenAIAuth = Object.prototype.hasOwnProperty.call(auth, 'openai');
  } catch (error) {
    console.warn('[OpenCode] Failed to read provider auth for the OpenAI timeout overlay:', error);
  }

  const hasOpenAIApiKey = typeof process.env.OPENAI_API_KEY === 'string'
    && Boolean(process.env.OPENAI_API_KEY.trim());
  if (!hasOpenAIAuth && !hasOpenAIApiKey && !openAIProvider) {
    return null;
  }

  const providerOptions = isPlainObject(openAIProvider?.options)
    ? openAIProvider.options as Record<string, unknown>
    : {};
  const headerTimeout = Object.prototype.hasOwnProperty.call(providerOptions, 'headerTimeout')
    ? providerOptions.headerTimeout
    : DEFAULT_OPENAI_HEADER_TIMEOUT_MS;
  const chunkTimeout = Object.prototype.hasOwnProperty.call(providerOptions, 'chunkTimeout')
    ? providerOptions.chunkTimeout
    : DEFAULT_OPENAI_CHUNK_TIMEOUT_MS;
  const timeout = Object.prototype.hasOwnProperty.call(providerOptions, 'timeout')
    ? providerOptions.timeout
    : DEFAULT_OPENAI_REQUEST_TIMEOUT_MS;

  return {
    provider: {
      openai: {
        options: { headerTimeout, chunkTimeout, timeout },
      },
    },
  };
};

const buildRuntimeConfigOverlay = (workingDirectory?: string, packagedPluginSpecs: string[] = []): Record<string, unknown> | null => {
  const activeConfig = readConfig(workingDirectory);
  const activePlugins = Array.isArray(activeConfig.plugin)
    ? filterManagedRuntimePluginEntries(activeConfig.plugin.filter((entry) => (
      (typeof entry === 'string' && entry.trim())
      || (Array.isArray(entry) && typeof entry[0] === 'string' && entry[0].trim())
    )))
    : [];
  const plugin: unknown[] = [];
  const seenPluginSpecs = new Set<string>();
  for (const entry of activePlugins) {
    pushUniquePluginEntry(plugin, seenPluginSpecs, entry);
  }
  for (const entry of packagedPluginSpecs.filter((entry) => typeof entry === 'string' && entry.trim())) {
    pushUniquePluginEntry(plugin, seenPluginSpecs, entry);
  }

  const overlay: Record<string, unknown> = {};
  const blockedMcpOverlay = buildBlockedManagedRuntimeMcpOverlay(workingDirectory);
  if (blockedMcpOverlay) {
    Object.assign(overlay, blockedMcpOverlay);
  }
  if (plugin.length > 0) {
    overlay.plugin = plugin;
  }
  const openAITimeoutOverlay = buildOpenAITimeoutOverlay(activeConfig);
  if (openAITimeoutOverlay) {
    Object.assign(overlay, openAITimeoutOverlay);
  }
  return Object.keys(overlay).length > 0 ? overlay : null;
};

const removeFileIfPresent = (filePath: string): boolean => {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
};

const syncSlimConfigOverlay = (targetConfigDirectory: string, workingDirectory?: string): boolean => {
  const slim = resolveSlimConfig(workingDirectory);
  const staleTargets = SLIM_CONFIG_FILE_NAMES.map((fileName) => path.join(targetConfigDirectory, fileName));
  if (!slim.pluginEnabled || !slim.userConfigPath) {
    return staleTargets.reduce((changed, target) => removeFileIfPresent(target) || changed, false);
  }

  const targetPath = path.join(targetConfigDirectory, path.basename(slim.userConfigPath));
  const desiredContent = fs.readFileSync(slim.userConfigPath, 'utf8');
  let currentContent: string | null = null;
  try {
    currentContent = fs.readFileSync(targetPath, 'utf8');
  } catch {
    currentContent = null;
  }

  let changed = false;
  if (currentContent !== desiredContent) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, desiredContent, 'utf8');
    changed = true;
  }

  for (const staleTarget of staleTargets) {
    if (staleTarget === targetPath) {
      continue;
    }
    changed = removeFileIfPresent(staleTarget) || changed;
  }

  return changed;
};

export const syncRuntimeAgentOverlays = (
  workingDirectory?: string,
  options: { hiddenSkills?: unknown[] } = {},
): {
  changed: boolean;
  targetConfigDirectory: string | null;
  written: string[];
  updated: string[];
  removed: string[];
} => {
  if (!workingDirectory) {
    return { changed: false, targetConfigDirectory: null, written: [], updated: [], removed: [] };
  }

  const projectKey = hashRuntimeOverlayKey(workingDirectory);
  const targetConfigDirectory = path.join(RUNTIME_AGENT_OVERLAY_ROOT, projectKey);
  const targetAgentDirectory = path.join(targetConfigDirectory, 'agents');
  const targetPluginDirectory = path.join(targetConfigDirectory, 'plugins');
  fs.mkdirSync(targetAgentDirectory, { recursive: true });

  const slim = resolveSlimConfig(workingDirectory);
  const baseAgentList = slim.wrapperPluginEnabled && !slim.slimAgentCatalogEnabled
    ? listDevRyanBaseConfigAgents(workingDirectory)
    : getBaseConfigAgents(workingDirectory);
  const baseAgents = new Map(baseAgentList.map((agent) => [agent.name, agent]));
  const overrides = listManagedRuntimeAgentModelOverrides(workingDirectory);
  const runtimeExternalDirectories = buildRuntimeExternalDirectories(workingDirectory);
  const hiddenSkills = Array.isArray(options.hiddenSkills)
    ? options.hiddenSkills.filter((skill): skill is { name?: unknown; path?: unknown } => (
      Boolean(skill) && typeof skill === 'object' && !Array.isArray(skill)
    ))
    : [];
  const skillPolicy = buildVisibleSkillPolicy({
    skills: discoverSkills(workingDirectory),
    hiddenSkills,
  });
  const packagedPlugins = listPackagedRuntimePlugins();
  const manifest = readRuntimeOverlayManifest();
  const projects = isPlainObject(manifest.projects) ? manifest.projects : {};
  const projectManifest = isPlainObject(projects[projectKey]) ? projects[projectKey] as Record<string, unknown> : {};
  const manifestAgents = isPlainObject(projectManifest.agents) ? projectManifest.agents as Record<string, unknown> : {};
  const nextManifestAgents: Record<string, unknown> = { ...manifestAgents };
  const desired = new Map<string, { content: string; hash: string }>();
  const result = { changed: false, targetConfigDirectory, written: [] as string[], updated: [] as string[], removed: [] as string[] };
  const targetConfigFile = path.join(targetConfigDirectory, 'opencode.json');
  const desiredRuntimeConfig = buildRuntimeConfigOverlay(workingDirectory, packagedPlugins.map((plugin) => plugin.spec));

  if (desiredRuntimeConfig) {
    const desiredContent = `${JSON.stringify(desiredRuntimeConfig, null, 2)}\n`;
    let currentContent: string | null = null;
    try {
      currentContent = fs.readFileSync(targetConfigFile, 'utf8');
    } catch {
      currentContent = null;
    }
    if (currentContent !== desiredContent) {
      fs.writeFileSync(targetConfigFile, desiredContent, 'utf8');
      result.changed = true;
    }
  } else {
    try {
      fs.unlinkSync(targetConfigFile);
      result.changed = true;
    } catch {
      // ignore missing stale config
    }
  }
  if (syncSlimConfigOverlay(targetConfigDirectory, workingDirectory)) {
    result.changed = true;
  }

  const desiredAgentNames = new Set([
    ...Object.keys(overrides),
    ...Array.from(baseAgents.values())
      .filter((agent) => (
        agent.scope === AGENT_SCOPE.PACKAGED
        || (
          agent.scope === AGENT_SCOPE.PROJECT
          && isPlainObject(agent.permission)
          && (
            agent.permission.skill === 'allow'
            || isPlainObject(agent.permission.skill)
          )
        )
        || (isPlainObject(agent.permission) && runtimeExternalDirectories.length > 0)
      ))
      .map((agent) => agent.name),
  ]);

  for (const agentName of desiredAgentNames) {
    const override = overrides[agentName];
    const baseAgent = baseAgents.get(agentName);
    if (!baseAgent) continue;
    const content = applyRuntimeAgentOverride(
      baseAgent,
      override,
      runtimeExternalDirectories,
      skillPolicy,
    );
    if (!content) continue;
    desired.set(agentName, {
      content,
      hash: crypto.createHash('sha256').update(content).digest('hex'),
    });
  }

  for (const [agentName, entry] of desired.entries()) {
    const targetPath = path.join(targetAgentDirectory, `${agentName}.md`);
    let current: string | null = null;
    try {
      current = fs.readFileSync(targetPath, 'utf8');
    } catch {
      current = null;
    }

    if (current !== entry.content) {
      fs.writeFileSync(targetPath, entry.content, 'utf8');
      result.changed = true;
      if (current === null) {
        result.written.push(agentName);
      } else {
        result.updated.push(agentName);
      }
    }
    nextManifestAgents[agentName] = { hash: entry.hash };
  }

  for (const agentName of Object.keys(manifestAgents)) {
    if (desired.has(agentName)) continue;
    try {
      fs.unlinkSync(path.join(targetAgentDirectory, `${agentName}.md`));
      result.removed.push(agentName);
      result.changed = true;
    } catch {
      // ignore missing stale files
    }
    delete nextManifestAgents[agentName];
  }

  const desiredPluginNames = new Set(packagedPlugins.map((plugin) => plugin.fileName));
  if (packagedPlugins.length > 0) {
    fs.mkdirSync(targetPluginDirectory, { recursive: true });
  }
  for (const plugin of packagedPlugins) {
    const targetPath = path.join(targetPluginDirectory, plugin.fileName);
    let current: string | null = null;
    try {
      current = fs.readFileSync(targetPath, 'utf8');
    } catch {
      current = null;
    }

    if (current !== plugin.content) {
      fs.writeFileSync(targetPath, plugin.content, 'utf8');
      result.changed = true;
    }
  }

  try {
    for (const entry of fs.readdirSync(targetPluginDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || desiredPluginNames.has(entry.name)) {
        continue;
      }
      if (isRuntimePluginFileName(entry.name) || entry.name.endsWith('.d.ts') || /(^|[.-])(test|spec)\./.test(entry.name)) {
        fs.unlinkSync(path.join(targetPluginDirectory, entry.name));
        result.changed = true;
      }
    }
  } catch {
    // ignore missing plugin directory
  }

  const nextManifest = {
    version: 1,
    projects: {
      ...projects,
      [projectKey]: {
        workingDirectory: path.resolve(workingDirectory),
        targetConfigDirectory,
        agents: Object.fromEntries(Object.entries(nextManifestAgents).sort(([a], [b]) => a.localeCompare(b))),
      },
    },
  };
  writeRuntimeOverlayManifest(nextManifest);

  result.written.sort((a, b) => a.localeCompare(b));
  result.updated.sort((a, b) => a.localeCompare(b));
  result.removed.sort((a, b) => a.localeCompare(b));

  return result;
};

export const writeAgentModelOverride = (agentName: string, rawOverride: unknown, workingDirectory?: string): AgentModelOverride => {
  const override = normalizeAgentModelOverride(rawOverride);
  const slimAgents = getSlimConfigAgents(workingDirectory);
  const slimRuntimeAgents = getSlimRuntimeModelAgents(workingDirectory);
  const slim = resolveSlimConfig(workingDirectory);
  const devRyanAgentExists = listDevRyanBaseConfigAgents(workingDirectory).some((agent) => agent.name === agentName);
  if (slimAgents[agentName] || slimRuntimeAgents[agentName] || (slim.pluginEnabled && devRyanAgentExists)) {
    return writeSlimAgentModelOverride(agentName, override);
  }

  assertKnownAgentName(agentName, workingDirectory);
  const config = readUserConfig();
  const openchamber = isPlainObject(config[OPENCHAMBER_CONFIG_KEY])
    ? { ...(config[OPENCHAMBER_CONFIG_KEY] as Record<string, unknown>) }
    : {};
  const overrides = getAgentOverridesContainer(config);

  writeUserConfig({
    ...config,
    [OPENCHAMBER_CONFIG_KEY]: {
      ...openchamber,
      [AGENT_OVERRIDES_CONFIG_KEY]: {
        ...overrides,
        [agentName]: override,
      },
    },
  });

  return override;
};

export const deleteAgentModelOverride = (agentName: string, workingDirectory?: string): boolean => {
  const slimAgents = getSlimConfigAgents(workingDirectory);
  const slimRuntimeAgents = getSlimRuntimeModelAgents(workingDirectory);
  const slim = resolveSlimConfig(workingDirectory);
  const devRyanAgentExists = listDevRyanBaseConfigAgents(workingDirectory).some((agent) => agent.name === agentName);
  if (slimAgents[agentName] || slimRuntimeAgents[agentName] || (slim.pluginEnabled && devRyanAgentExists)) {
    return deleteSlimAgentModelOverride(agentName);
  }

  const config = readUserConfig();
  const openchamber = isPlainObject(config[OPENCHAMBER_CONFIG_KEY])
    ? { ...(config[OPENCHAMBER_CONFIG_KEY] as Record<string, unknown>) }
    : {};
  const overrides = { ...getAgentOverridesContainer(config) };

  if (!Object.prototype.hasOwnProperty.call(overrides, agentName)) {
    return false;
  }

  delete overrides[agentName];
  writeUserConfig({
    ...config,
    [OPENCHAMBER_CONFIG_KEY]: {
      ...openchamber,
      [AGENT_OVERRIDES_CONFIG_KEY]: overrides,
    },
  });

  return true;
};

export const getAgentSources = (agentName: string, workingDirectory?: string): ConfigSources => {
  const slim = resolveSlimConfig(workingDirectory);
  const slimAgents = getSlimConfigAgents(workingDirectory);
  const slimAgent = slimAgents[agentName];
  if (slimAgent) {
    const mdPath = typeof slimAgent.__path === 'string' ? slimAgent.__path : null;
    const jsonPath = slim.projectConfigPath || slim.userConfigPath || null;
    return {
      md: {
        exists: Boolean(mdPath),
        path: mdPath,
        scope: mdPath ? AGENT_SCOPE.SLIM : null,
        fields: mdPath ? Object.keys(parseMdFile(mdPath).frontmatter) : [],
      },
      json: {
        exists: Boolean(jsonPath),
        path: jsonPath || '',
        scope: AGENT_SCOPE.SLIM,
        fields: ['model', 'variant'],
      },
      projectMd: { exists: false, path: null },
      packagedMd: { exists: false, path: null },
      userMd: { exists: false, path: null },
    };
  }

  const projectPath = workingDirectory ? getProjectAgentPath(workingDirectory, agentName) : null;
  const projectExists = projectPath ? fs.existsSync(projectPath) : false;
  const packagedAgent = listPackagedConfigAgents().find((agent) => agent.name === agentName);
  const packagedPath = typeof packagedAgent?.__path === 'string' ? packagedAgent.__path : null;
  const packagedExists = Boolean(packagedAgent);
  const mdPath = projectExists ? projectPath : packagedPath;
  const mdExists = !!mdPath;
  const mdScope = projectExists ? AGENT_SCOPE.PROJECT : (packagedExists ? AGENT_SCOPE.PACKAGED : null);

  const sources: ConfigSources = {
    md: { exists: mdExists, path: mdPath, scope: mdScope, fields: [] },
    json: { exists: false, path: CONFIG_FILE, scope: null, fields: [] },
    projectMd: { exists: projectExists, path: projectPath },
    packagedMd: { exists: packagedExists, path: packagedPath },
    userMd: { exists: false, path: null }
  };

  if (mdExists && mdPath) {
    const { frontmatter, body } = parseMdFile(mdPath);
    sources.md.fields = Object.keys(frontmatter);
    if (body) sources.md.fields.push('prompt');
  }

  if (mdExists && slim.agents[agentName]) {
    sources.json = {
      exists: Boolean(slim.projectConfigPath || slim.userConfigPath),
      path: slim.projectConfigPath || slim.userConfigPath || '',
      scope: AGENT_SCOPE.SLIM,
      fields: ['model', 'variant'],
    };
  }

  if (!mdExists) {
    const slimRuntimeAgent = getSlimRuntimeModelAgents(workingDirectory)[agentName];
    if (slimRuntimeAgent) {
      const mdPath = typeof slimRuntimeAgent.__path === 'string' ? slimRuntimeAgent.__path : null;
      const jsonPath = slim.projectConfigPath || slim.userConfigPath || null;
      return {
        md: {
          exists: Boolean(mdPath),
          path: mdPath,
          scope: mdPath ? AGENT_SCOPE.SLIM : null,
          fields: mdPath ? Object.keys(parseMdFile(mdPath).frontmatter) : [],
        },
        json: {
          exists: Boolean(jsonPath),
          path: jsonPath || '',
          scope: AGENT_SCOPE.SLIM,
          fields: ['model', 'variant'],
        },
        projectMd: { exists: false, path: null },
        packagedMd: { exists: false, path: null },
        userMd: { exists: false, path: null },
      };
    }
  }

  return sources;
};

export const createAgent = (agentName: string, config: Record<string, unknown>, workingDirectory?: string, scope?: AgentScope) => {
  void agentName;
  void config;
  void workingDirectory;
  void scope;
  throw new Error(AGENT_WRITE_DISABLED_MESSAGE);
};

export const updateAgent = (agentName: string, updates: Record<string, unknown>, workingDirectory?: string) => {
  void agentName;
  void updates;
  void workingDirectory;
  throw new Error(AGENT_WRITE_DISABLED_MESSAGE);
};

export const deleteAgent = (agentName: string, workingDirectory?: string) => {
  void agentName;
  void workingDirectory;
  throw new Error(AGENT_WRITE_DISABLED_MESSAGE);
};

export const getCommandSources = (commandName: string, workingDirectory?: string): ConfigSources => {
  // Check project level first (takes precedence)
  const projectPath = workingDirectory ? getProjectCommandPath(workingDirectory, commandName) : null;
  const projectExists = projectPath ? fs.existsSync(projectPath) : false;
  
  // Then check user level
  const userPath = getUserCommandPath(commandName);
  const userExists = fs.existsSync(userPath);
  
  // Determine which md file to use (project takes precedence)
  const mdPath = projectExists ? projectPath : (userExists ? userPath : null);
  const mdExists = !!mdPath;
  const mdScope = projectExists ? COMMAND_SCOPE.PROJECT : (userExists ? COMMAND_SCOPE.USER : null);

  const layers = readConfigLayers(workingDirectory);
  const jsonSource = getJsonEntrySource(layers, 'command', commandName);
  const commandSection = jsonSource.section as Record<string, unknown> | undefined;
  const jsonPath = jsonSource.path || layers.paths.customPath || layers.paths.projectPath || layers.paths.userPath;
  const jsonScope = jsonSource.path === layers.paths.projectPath ? COMMAND_SCOPE.PROJECT : COMMAND_SCOPE.USER;

  const sources: ConfigSources = {
    md: { exists: mdExists, path: mdPath, scope: mdScope, fields: [] },
    json: { exists: jsonSource.exists, path: jsonPath || CONFIG_FILE, scope: jsonSource.exists ? jsonScope : null, fields: [] },
    projectMd: { exists: projectExists, path: projectPath },
    userMd: { exists: userExists, path: userPath }
  };

  if (mdExists && mdPath) {
    const { frontmatter, body } = parseMdFile(mdPath);
    sources.md.fields = Object.keys(frontmatter);
    if (body) sources.md.fields.push('template');
  }

  if (commandSection) {
    sources.json.fields = Object.keys(commandSection);
  }

  return sources;
};

export const createCommand = (commandName: string, config: Record<string, unknown>, workingDirectory?: string, scope?: CommandScope) => {
  ensureDirs();

  // Check if command already exists at either level
  const projectPath = workingDirectory ? getProjectCommandPath(workingDirectory, commandName) : null;
  const userPath = getUserCommandPath(commandName);
  
  if (projectPath && fs.existsSync(projectPath)) {
    throw new Error(`Command ${commandName} already exists as project-level .md file`);
  }
  
  if (fs.existsSync(userPath)) {
    throw new Error(`Command ${commandName} already exists as user-level .md file`);
  }

  const layers = readConfigLayers(workingDirectory);
  const jsonSource = getJsonEntrySource(layers, 'command', commandName);
  if (jsonSource.exists) throw new Error(`Command ${commandName} already exists in opencode.json`);

  // Determine target path based on requested scope
  let targetPath: string;
  
  if (scope === COMMAND_SCOPE.PROJECT && workingDirectory) {
    ensureProjectCommandDir(workingDirectory);
    targetPath = projectPath!;
  } else {
    targetPath = userPath;
  }

  // Extract scope from config - it's only used for path determination, not written to file
  const { template, scope: _ignored, ...frontmatter } = config as Record<string, unknown> & { template?: unknown; scope?: unknown };
  void _ignored; // Scope is only used for path determination
  writeMdFile(targetPath, frontmatter, typeof template === 'string' ? template : '');
};

export const updateCommand = (commandName: string, updates: Record<string, unknown>, workingDirectory?: string) => {
  ensureDirs();

  // Determine correct path: project level takes precedence
  const { path: mdPath } = getCommandWritePath(commandName, workingDirectory);
  const mdExists = mdPath ? fs.existsSync(mdPath) : false;

  const layers = readConfigLayers(workingDirectory);
  const jsonSource = getJsonEntrySource(layers, 'command', commandName);
  const jsonSection = jsonSource.section as Record<string, unknown> | undefined;
  const hasJsonFields = Boolean(jsonSource.exists && jsonSection && Object.keys(jsonSection).length > 0);
  const jsonTarget = jsonSource.exists
    ? { config: jsonSource.config, path: jsonSource.path }
    : getJsonWriteTarget(layers, workingDirectory ? COMMAND_SCOPE.PROJECT : COMMAND_SCOPE.USER);
  const config = (jsonTarget.config || {}) as Record<string, unknown>;

  // Only create a new md file for built-in overrides (no md + no json)
  const isBuiltinOverride = !mdExists && !hasJsonFields;

  let targetPath = mdPath;
  if (!mdExists && isBuiltinOverride) {
    // Built-in command override - create at user level
    targetPath = getUserCommandPath(commandName);
  }

  const mdData = mdExists && mdPath ? parseMdFile(mdPath) : (isBuiltinOverride ? { frontmatter: {} as Record<string, unknown>, body: '' } : null);

  let mdModified = false;
  let jsonModified = false;
  const creatingNewMd = isBuiltinOverride;

  for (const [field, value] of Object.entries(updates || {})) {
    if (field === 'template') {
      const normalizedValue = typeof value === 'string' ? value : value == null ? '' : String(value);

      if (mdExists || creatingNewMd) {
        if (mdData) {
          mdData.body = normalizedValue;
          mdModified = true;
        }
        continue;
      }

      if (isPromptFileReference(jsonSection?.template)) {
        const templateFilePath = resolvePromptFilePath(jsonSection.template);
        if (!templateFilePath) throw new Error(`Invalid template file reference for command ${commandName}`);
        writePromptFile(templateFilePath, normalizedValue);
        continue;
      }

      // For JSON-only commands, store template inline in JSON
      if (!config.command) config.command = {};
      const current = ((config.command as Record<string, unknown>)[commandName] as Record<string, unknown> | undefined) ?? {};
      (config.command as Record<string, unknown>)[commandName] = { ...current, template: normalizedValue };
      jsonModified = true;
      continue;
    }

    const hasMdField = Boolean(mdData?.frontmatter?.[field] !== undefined);
    const hasJsonField = Boolean(jsonSection?.[field] !== undefined);

    // JSON takes precedence over md, so update JSON first if field exists there
    if (hasJsonField) {
      if (!config.command) config.command = {};
      const current = ((config.command as Record<string, unknown>)[commandName] as Record<string, unknown> | undefined) ?? {};
      (config.command as Record<string, unknown>)[commandName] = { ...current, [field]: value };
      jsonModified = true;
      continue;
    }

    if (hasMdField || creatingNewMd) {
      if (mdData) {
        mdData.frontmatter[field] = value;
        mdModified = true;
      }
      continue;
    }

    // New field - add to appropriate location based on command source
    if ((mdExists || creatingNewMd) && mdData) {
      mdData.frontmatter[field] = value;
      mdModified = true;
    } else {
      if (!config.command) config.command = {};
      const current = ((config.command as Record<string, unknown>)[commandName] as Record<string, unknown> | undefined) ?? {};
      (config.command as Record<string, unknown>)[commandName] = { ...current, [field]: value };
      jsonModified = true;
    }
  }

  if (mdModified && mdData && targetPath) {
    writeMdFile(targetPath, mdData.frontmatter, mdData.body);
  }

  if (jsonModified) {
    writeConfig(config, jsonTarget.path || CONFIG_FILE);
  }
};

export const getProviderSources = (providerId: string, workingDirectory?: string) => {
  const layers = readConfigLayers(workingDirectory);
  const normalizedProviderId = typeof providerId === 'string' ? providerId.trim().toLowerCase() : '';
  const providerLookupIds = ANTHROPIC_OAUTH_PROVIDER_IDS.has(normalizedProviderId)
    ? [normalizedProviderId, ANTHROPIC_OAUTH_CONFIG_PROVIDER_ID]
    : [normalizedProviderId];
  const customProviders = isPlainObject((layers.customConfig as Record<string, unknown>)?.provider)
    ? (layers.customConfig as Record<string, unknown>).provider as Record<string, unknown>
    : {};
  const customProvidersAlias = isPlainObject((layers.customConfig as Record<string, unknown>)?.providers)
    ? (layers.customConfig as Record<string, unknown>).providers as Record<string, unknown>
    : {};
  const projectProviders = isPlainObject((layers.projectConfig as Record<string, unknown>)?.provider)
    ? (layers.projectConfig as Record<string, unknown>).provider as Record<string, unknown>
    : {};
  const projectProvidersAlias = isPlainObject((layers.projectConfig as Record<string, unknown>)?.providers)
    ? (layers.projectConfig as Record<string, unknown>).providers as Record<string, unknown>
    : {};
  const userProviders = isPlainObject((layers.userConfig as Record<string, unknown>)?.provider)
    ? (layers.userConfig as Record<string, unknown>).provider as Record<string, unknown>
    : {};
  const userProvidersAlias = isPlainObject((layers.userConfig as Record<string, unknown>)?.providers)
    ? (layers.userConfig as Record<string, unknown>).providers as Record<string, unknown>
    : {};

  const hasAnyProviderConfig = (providers: Record<string, unknown>, providersAlias: Record<string, unknown>) => (
    providerLookupIds.some((id) => (
      Object.prototype.hasOwnProperty.call(providers, id) ||
      Object.prototype.hasOwnProperty.call(providersAlias, id)
    ))
  );
  const hasAnthropicOAuthPlugin = (config: unknown) => {
    const plugins = Array.isArray((config as Record<string, unknown> | null)?.plugin)
      ? (config as Record<string, unknown>).plugin as unknown[]
      : [];
    return plugins.some(isAnthropicOAuthPluginSpec);
  };
  const hasAnthropicOAuthOptions = (config: unknown) => {
    const providers = isPlainObject((config as Record<string, unknown> | null)?.provider)
      ? (config as Record<string, unknown>).provider as Record<string, unknown>
      : {};
    const anthropic = isPlainObject(providers[ANTHROPIC_OAUTH_CONFIG_PROVIDER_ID])
      ? providers[ANTHROPIC_OAUTH_CONFIG_PROVIDER_ID] as Record<string, unknown>
      : null;
    const options = isPlainObject(anthropic?.options) ? anthropic.options as Record<string, unknown> : {};
    if (options.apiKey !== 'dummy' || typeof options.baseURL !== 'string') return false;
    try {
      const url = new URL(options.baseURL);
      return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && Boolean(url.port);
    } catch {
      return false;
    }
  };
  const hasAnthropicOAuthConfig = (config: unknown) => (
    ANTHROPIC_OAUTH_PROVIDER_IDS.has(normalizedProviderId) &&
    hasAnthropicOAuthPlugin(config) &&
    hasAnthropicOAuthOptions(config)
  );

  const customExists = hasAnyProviderConfig(customProviders, customProvidersAlias);
  const projectExists = hasAnyProviderConfig(projectProviders, projectProvidersAlias);
  const userExists = hasAnyProviderConfig(userProviders, userProvidersAlias);
  const customAnthropicOAuthExists = hasAnthropicOAuthConfig(layers.customConfig);
  const projectAnthropicOAuthExists = hasAnthropicOAuthConfig(layers.projectConfig);
  const userAnthropicOAuthExists = hasAnthropicOAuthConfig(layers.userConfig);

  return {
    auth: { exists: false },
    user: { exists: userExists, path: layers.paths.userPath },
    project: { exists: projectExists, path: layers.paths.projectPath ?? null },
    custom: { exists: customExists, path: layers.paths.customPath },
    anthropicOAuth: {
      exists: userAnthropicOAuthExists || projectAnthropicOAuthExists || customAnthropicOAuthExists,
      path: userAnthropicOAuthExists
        ? layers.paths.userPath
        : projectAnthropicOAuthExists
          ? layers.paths.projectPath ?? null
          : customAnthropicOAuthExists
            ? layers.paths.customPath
            : null,
    },
  };
};

export const ensureAnthropicOAuthProviderConfig = ({
  workingDirectory,
  baseURL = ANTHROPIC_OAUTH_DEFAULT_BASE_URL,
}: {
  workingDirectory?: string;
  baseURL?: string;
} = {}) => {
  const layers = readConfigLayers(workingDirectory);
  const targetPath = workingDirectory ? layers.paths.projectPath : layers.paths.userPath;
  const targetConfig = workingDirectory ? layers.projectConfig : layers.userConfig;
  const plugin = Array.isArray((targetConfig as Record<string, unknown>).plugin)
    ? [...(targetConfig as Record<string, unknown>).plugin as unknown[]]
    : [];
  const hadPlugin = plugin.some(isAnthropicOAuthPluginSpec);
  const nextPlugin = reconcileAnthropicOAuthPluginSpecs(plugin);
  const provider = isPlainObject((targetConfig as Record<string, unknown>).provider)
    ? (targetConfig as Record<string, unknown>).provider as Record<string, unknown>
    : {};
  const existingAnthropic = isPlainObject(provider[ANTHROPIC_OAUTH_CONFIG_PROVIDER_ID])
    ? provider[ANTHROPIC_OAUTH_CONFIG_PROVIDER_ID] as Record<string, unknown>
    : {};
  const existingOptions = isPlainObject(existingAnthropic.options)
    ? existingAnthropic.options as Record<string, unknown>
    : {};
  const changed =
    !hadPlugin ||
    plugin.length !== nextPlugin.length ||
    plugin.some((entry, index) => entry !== nextPlugin[index]) ||
    !isPlainObject((targetConfig as Record<string, unknown>).provider) ||
    !isPlainObject(provider[ANTHROPIC_OAUTH_CONFIG_PROVIDER_ID]) ||
    !isPlainObject(existingAnthropic.options) ||
    existingOptions.baseURL !== baseURL ||
    existingOptions.apiKey !== 'dummy';

  if (!changed) {
    return { changed: false, path: targetPath };
  }

  const nextConfig = {
    ...(targetConfig as Record<string, unknown>),
    plugin: nextPlugin,
    provider: {
      ...provider,
      [ANTHROPIC_OAUTH_CONFIG_PROVIDER_ID]: {
        ...existingAnthropic,
        options: {
          ...existingOptions,
          baseURL,
          apiKey: 'dummy',
        },
      },
    },
  };
  writeConfig(nextConfig, targetPath || CONFIG_FILE);
  return { changed: true, path: targetPath };
};

const resolveDefaultCursorAcpUserConfigPath = (): string => {
  if (fs.existsSync(OFFICIAL_USER_CONFIG_FILE)) {
    return OFFICIAL_USER_CONFIG_FILE;
  }
  if (fs.existsSync(CONFIG_FILE)) {
    return CONFIG_FILE;
  }
  return OFFICIAL_USER_CONFIG_FILE;
};

export const ensureDefaultCursorAcpProviderConfig = (): { changed: boolean; path: string; config: Record<string, unknown> } => {
  const targetPath = resolveDefaultCursorAcpUserConfigPath();
  const targetConfig = readConfigFile(targetPath);
  return { changed: false, path: targetPath, config: targetConfig };
};

export const removeProviderConfig = (providerId: string, workingDirectory?: string, scope: 'user' | 'project' | 'custom' = 'user') => {
  if (!providerId) throw new Error('Provider ID is required');

  const layers = readConfigLayers(workingDirectory);
  let targetPath: string | null | undefined = layers.paths.userPath;

  if (scope === 'project') {
    if (!workingDirectory) {
      throw new Error('Working directory is required for project scope');
    }
    targetPath = layers.paths.projectPath ?? targetPath;
  }

  if (scope === 'custom') {
    if (!layers.paths.customPath) {
      return false;
    }
    targetPath = layers.paths.customPath;
  }

  const targetConfig = getConfigForPath(layers, targetPath);
  const providerConfig = isPlainObject((targetConfig as Record<string, unknown>).provider)
    ? (targetConfig as Record<string, unknown>).provider as Record<string, unknown>
    : {};
  const providersConfig = isPlainObject((targetConfig as Record<string, unknown>).providers)
    ? (targetConfig as Record<string, unknown>).providers as Record<string, unknown>
    : {};

  const removedProvider = Object.prototype.hasOwnProperty.call(providerConfig, providerId);
  const removedProviders = Object.prototype.hasOwnProperty.call(providersConfig, providerId);

  if (!removedProvider && !removedProviders) {
    return false;
  }

  if (removedProvider) {
    delete providerConfig[providerId];
    if (Object.keys(providerConfig).length === 0) {
      delete (targetConfig as Record<string, unknown>).provider;
    } else {
      (targetConfig as Record<string, unknown>).provider = providerConfig;
    }
  }

  if (removedProviders) {
    delete providersConfig[providerId];
    if (Object.keys(providersConfig).length === 0) {
      delete (targetConfig as Record<string, unknown>).providers;
    } else {
      (targetConfig as Record<string, unknown>).providers = providersConfig;
    }
  }

  writeConfig(targetConfig as Record<string, unknown>, targetPath || CONFIG_FILE);
  return true;
};

export const deleteCommand = (commandName: string, workingDirectory?: string) => {
  let deleted = false;

  // Check project level first (takes precedence)
  if (workingDirectory) {
    const projectPath = getProjectCommandPath(workingDirectory, commandName);
    if (fs.existsSync(projectPath)) {
      fs.unlinkSync(projectPath);
      deleted = true;
    }
  }

  // Then check user level
  const userPath = getUserCommandPath(commandName);
  if (fs.existsSync(userPath)) {
    fs.unlinkSync(userPath);
    deleted = true;
  }

  // Also check json config (highest precedence entry only)
  const layers = readConfigLayers(workingDirectory);
  const jsonSource = getJsonEntrySource(layers, 'command', commandName);
  if (jsonSource.exists && jsonSource.config && jsonSource.path) {
    const targetConfig = jsonSource.config as Record<string, unknown>;
    const commandMap = (targetConfig.command as Record<string, unknown> | undefined) ?? {};
    delete commandMap[commandName];
    targetConfig.command = commandMap;
    writeConfig(targetConfig, jsonSource.path);
    deleted = true;
  }

  if (!deleted) {
    throw new Error(`Command "${commandName}" not found`);
  }
};

// ============== SKILL SCOPE HELPERS ==============

const SKILL_DIR = path.join(OPENCODE_CONFIG_DIR, 'skills');

export const SKILL_SCOPE = {
  USER: 'user',
  PROJECT: 'project'
} as const;

export type SkillScope = typeof SKILL_SCOPE[keyof typeof SKILL_SCOPE];
export type SkillSource = 'opencode' | 'claude' | 'agents';

export type SupportingFile = {
  name: string;
  path: string;
  fullPath: string;
};

export type SkillConfigSources = {
  md: {
    exists: boolean;
    path: string | null;
    dir: string | null;
    fields: string[];
    scope?: SkillScope | null;
    source?: SkillSource | null;
    supportingFiles: SupportingFile[];
  };
  projectMd?: { exists: boolean; path: string | null };
  claudeMd?: { exists: boolean; path: string | null };
  userMd?: { exists: boolean; path: string | null };
};

export type DiscoveredSkill = {
  name: string;
  path: string;
  scope: SkillScope;
  source: SkillSource;
  description?: string;
};

const addSkillFromMdFile = (
  skillsMap: Map<string, DiscoveredSkill>,
  skillMdPath: string,
  scope: SkillScope,
  source: SkillSource
) => {
  try {
    const parsed = parseMdFile(skillMdPath);
    const name = typeof parsed.frontmatter?.name === 'string'
      ? parsed.frontmatter.name.trim()
      : '';
    const description = typeof parsed.frontmatter?.description === 'string'
      ? parsed.frontmatter.description
      : '';

    if (!name) {
      return;
    }

    const resolved = path.resolve(skillMdPath);
    let identity = resolved;
    try {
      identity = fs.realpathSync(resolved);
    } catch {
      identity = resolved;
    }

    skillsMap.set(identity, {
      name,
      path: skillMdPath,
      scope,
      source,
      description,
    });
  } catch {
    // Ignore invalid SKILL.md entries.
  }
};

const ensureSkillDirs = () => {
  if (!fs.existsSync(SKILL_DIR)) {
    fs.mkdirSync(SKILL_DIR, { recursive: true });
  }
};

const getUserSkillDir = (skillName: string): string => {
  const pluralPath = path.join(SKILL_DIR, skillName);
  const legacyPath = path.join(OPENCODE_CONFIG_DIR, 'skill', skillName);
  if (fs.existsSync(legacyPath) && !fs.existsSync(pluralPath)) return legacyPath;
  return pluralPath;
};

const getUserSkillPath = (skillName: string): string => {
  const pluralPath = path.join(SKILL_DIR, skillName, 'SKILL.md');
  const legacyPath = path.join(OPENCODE_CONFIG_DIR, 'skill', skillName, 'SKILL.md');
  if (fs.existsSync(legacyPath) && !fs.existsSync(pluralPath)) return legacyPath;
  return pluralPath;
};

const isExistingFile = (filePath: unknown): filePath is string => {
  try {
    return typeof filePath === 'string' && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
};

const getProjectSkillDir = (workingDirectory: string, skillName: string): string => {
  const pluralPath = path.join(workingDirectory, '.opencode', 'skills', skillName);
  const legacyPath = path.join(workingDirectory, '.opencode', 'skill', skillName);
  if (fs.existsSync(legacyPath) && !fs.existsSync(pluralPath)) return legacyPath;
  return pluralPath;
};

const getProjectSkillPath = (workingDirectory: string, skillName: string): string => {
  const pluralPath = path.join(workingDirectory, '.opencode', 'skills', skillName, 'SKILL.md');
  const legacyPath = path.join(workingDirectory, '.opencode', 'skill', skillName, 'SKILL.md');
  if (fs.existsSync(legacyPath) && !fs.existsSync(pluralPath)) return legacyPath;
  return pluralPath;
};

const getUserAgentsSkillDir = (skillName: string): string => {
  return path.join(os.homedir(), '.agents', 'skills', skillName);
};

const getProjectAgentsSkillDir = (workingDirectory: string, skillName: string): string => {
  return path.join(workingDirectory, '.agents', 'skills', skillName);
};

export const getSkillScope = (skillName: string, workingDirectory?: string): { 
  scope: SkillScope | null; 
  path: string | null; 
  source: SkillSource | null;
} => {
  const discovered = discoverSkills(workingDirectory).find((skill) => skill.name === skillName);
  if (discovered?.path) {
    return { scope: discovered.scope, path: discovered.path, source: discovered.source };
  }

  if (workingDirectory) {
    // Check .opencode/skill first
    const projectPath = getProjectSkillPath(workingDirectory, skillName);
    if (fs.existsSync(projectPath)) {
      return { scope: SKILL_SCOPE.PROJECT, path: projectPath, source: 'opencode' };
    }
    
  }
  
  const userPath = getUserSkillPath(skillName);
  if (fs.existsSync(userPath)) {
    return { scope: SKILL_SCOPE.USER, path: userPath, source: 'opencode' };
  }
  
  return { scope: null, path: null, source: null };
};

const listSupportingFiles = (skillDir: string): SupportingFile[] => {
  if (!fs.existsSync(skillDir)) return [];
  
  const files: SupportingFile[] = [];
  
  const walkDir = (dir: string, relativePath: string = '') => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relativePath ? path.join(relativePath, entry.name) : entry.name;
      
      if (entry.isDirectory()) {
        walkDir(fullPath, relPath);
      } else if (entry.name !== 'SKILL.md') {
        files.push({
          name: entry.name,
          path: relPath,
          fullPath
        });
      }
    }
  };
  
  walkDir(skillDir);
  return files;
};

export const discoverSkills = (workingDirectory?: string): DiscoveredSkill[] => {
  const skills = new Map<string, DiscoveredSkill>();

  // 1) External global (.agents only; .claude is intentionally excluded)
  const userAgentsRoot = path.join(os.homedir(), '.agents', 'skills');
  for (const skillMdPath of walkSkillMdFiles(userAgentsRoot)) {
    addSkillFromMdFile(skills, skillMdPath, SKILL_SCOPE.USER, 'agents');
  }

  // 2) External project ancestors (.agents only)
  if (workingDirectory) {
    const worktreeRoot = findWorktreeRoot(workingDirectory) || path.resolve(workingDirectory);
    const ancestors = getAncestors(workingDirectory, worktreeRoot);
    for (const ancestor of ancestors) {
      const externalSkillsRoot = path.join(ancestor, '.agents', 'skills');
      for (const skillMdPath of walkSkillMdFiles(externalSkillsRoot)) {
        addSkillFromMdFile(skills, skillMdPath, SKILL_SCOPE.PROJECT, 'agents');
      }
    }
  }

  // 3) Config directories: {skill,skills}/**/SKILL.md
  const configDirectories = resolveSkillSearchDirectories(workingDirectory);
  const homeOpencodeDir = path.resolve(path.join(os.homedir(), '.opencode'));
  const customConfigDir = process.env.OPENCODE_CONFIG_DIR
    ? path.resolve(process.env.OPENCODE_CONFIG_DIR)
    : null;
  for (const dir of configDirectories) {
    for (const subDir of ['skill', 'skills']) {
      const root = path.join(dir, subDir);
      for (const skillMdPath of walkSkillMdFiles(root)) {
        const isUserConfigDir = dir === OPENCODE_CONFIG_DIR
          || dir === homeOpencodeDir
          || (customConfigDir && dir === customConfigDir);
        const scope = isUserConfigDir ? SKILL_SCOPE.USER : SKILL_SCOPE.PROJECT;
        addSkillFromMdFile(skills, skillMdPath, scope, 'opencode');
      }
    }
  }

  // 4) Additional config.skills.paths
  let configuredPaths: unknown[] = [];
  try {
    const config = readConfig(workingDirectory);
    const skillsConfig = isPlainObject(config.skills) ? config.skills : null;
    configuredPaths = Array.isArray(skillsConfig?.paths) ? skillsConfig.paths : [];
  } catch {
    configuredPaths = [];
  }
  for (const skillPath of configuredPaths) {
    if (typeof skillPath !== 'string' || !skillPath.trim()) continue;
    const expanded = skillPath.startsWith('~/')
      ? path.join(os.homedir(), skillPath.slice(2))
      : skillPath;
    const resolved = path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(workingDirectory || process.cwd(), expanded);
    for (const skillMdPath of walkSkillMdFiles(resolved)) {
      addSkillFromMdFile(skills, skillMdPath, SKILL_SCOPE.PROJECT, 'opencode');
    }
  }

  // 5) Cached skills from config.skills.urls pulls (best-effort, no network)
  const cacheCandidates: string[] = [];
  if (process.env.XDG_CACHE_HOME) {
    cacheCandidates.push(path.join(process.env.XDG_CACHE_HOME, 'opencode', 'skills'));
  }
  cacheCandidates.push(path.join(os.homedir(), '.cache', 'opencode', 'skills'));
  cacheCandidates.push(path.join(os.homedir(), 'Library', 'Caches', 'opencode', 'skills'));

  for (const cacheRoot of cacheCandidates) {
    if (!fs.existsSync(cacheRoot)) continue;
    const entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillRoot = path.join(cacheRoot, entry.name);
      for (const skillMdPath of walkSkillMdFiles(skillRoot)) {
        addSkillFromMdFile(skills, skillMdPath, SKILL_SCOPE.USER, 'opencode');
      }
    }
  }

  return Array.from(skills.values());
};

export const getSkillSources = (
  skillName: string,
  workingDirectory?: string,
  discoveredSkill?: DiscoveredSkill | null
): SkillConfigSources => {
  ensureSkillDirs();
  
  // Check all possible locations
  const projectPath = workingDirectory ? getProjectSkillPath(workingDirectory, skillName) : null;
  const projectExists = projectPath ? fs.existsSync(projectPath) : false;
  const projectDir = projectExists && workingDirectory ? getProjectSkillDir(workingDirectory, skillName) : null;
  
  const userPath = getUserSkillPath(skillName);
  const userExists = fs.existsSync(userPath);
  const userDir = userExists ? getUserSkillDir(skillName) : null;

  const matchedDiscovered = discoveredSkill?.name === skillName
    ? discoveredSkill
    : discoverSkills(workingDirectory).find((skill) => skill.name === skillName);
  
  // Prefer the exact discovered skill only when callers opt in. Settings can
  // show global skills while a same-name project skill exists, but legacy skill
  // edit routes still expect project > user name resolution.
  let mdPath: string | null = null;
  let mdScope: SkillScope | null = null;
  let mdSource: SkillSource | null = null;
  let mdDir: string | null = null;
  
  if (
    matchedDiscovered?.path
    && (matchedDiscovered as DiscoveredSkill & { preferDiscoveredPath?: boolean }).preferDiscoveredPath
    && isExistingFile(matchedDiscovered.path)
  ) {
    mdPath = matchedDiscovered.path;
    mdScope = matchedDiscovered.scope;
    mdSource = matchedDiscovered.source;
    mdDir = path.dirname(matchedDiscovered.path);
  } else if (projectExists) {
    mdPath = projectPath;
    mdScope = SKILL_SCOPE.PROJECT;
    mdSource = 'opencode';
    mdDir = projectDir;
  } else if (userExists) {
    mdPath = userPath;
    mdScope = SKILL_SCOPE.USER;
    mdSource = 'opencode';
    mdDir = userDir;
  }
  
  const mdExists = !!mdPath;
  let mdFields: string[] = [];
  let supportingFiles: SupportingFile[] = [];
  
  if (mdExists && mdPath) {
    const { frontmatter, body } = parseMdFile(mdPath);
    mdFields = Object.keys(frontmatter);
    if (body) mdFields.push('instructions');
    if (mdDir) {
      supportingFiles = listSupportingFiles(mdDir);
    }
  }
  
  return {
    md: {
      exists: mdExists,
      path: mdPath,
      dir: mdDir,
      fields: mdFields,
      scope: mdScope,
      source: mdSource,
      supportingFiles
    },
    projectMd: { exists: projectExists, path: projectPath },
    claudeMd: { exists: false, path: null },
    userMd: { exists: userExists, path: userPath }
  };
};

export const readSkillSupportingFile = (skillDir: string, relativePath: string): string | null => {
  const fullPath = path.join(skillDir, relativePath);
  if (!fs.existsSync(fullPath)) return null;
  return fs.readFileSync(fullPath, 'utf8');
};

export const writeSkillSupportingFile = (skillDir: string, relativePath: string, content: string): void => {
  const fullPath = path.join(skillDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
};

export const deleteSkillSupportingFile = (skillDir: string, relativePath: string): void => {
  const fullPath = path.join(skillDir, relativePath);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
    // Clean up empty parent directories
    let parentDir = path.dirname(fullPath);
    while (parentDir !== skillDir) {
      try {
        const entries = fs.readdirSync(parentDir);
        if (entries.length === 0) {
          fs.rmdirSync(parentDir);
          parentDir = path.dirname(parentDir);
        } else {
          break;
        }
      } catch {
        break;
      }
    }
  }
};

const validateSkillName = (skillName: string): void => {
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(skillName) || skillName.length > 64) {
    throw new Error(`Invalid skill name "${skillName}". Must be 1-64 lowercase alphanumeric characters with hyphens, cannot start or end with hyphen.`);
  }
};

export const createSkill = (skillName: string, config: Record<string, unknown>, workingDirectory?: string, scope?: SkillScope): void => {
  ensureSkillDirs();
  validateSkillName(skillName);
  
  // Check if skill already exists
  const existing = getSkillScope(skillName, workingDirectory);
  if (existing.path) {
    throw new Error(`Skill ${skillName} already exists at ${existing.path}`);
  }
  
  // Determine target directory
  let targetDir: string;
  
  const requestedScope = scope || (workingDirectory ? SKILL_SCOPE.PROJECT : SKILL_SCOPE.USER);
  const requestedSource: SkillSource = config.source === 'agents' ? 'agents' : 'opencode';

  if (requestedScope === SKILL_SCOPE.PROJECT && workingDirectory) {
    targetDir = requestedSource === 'agents'
      ? getProjectAgentsSkillDir(workingDirectory, skillName)
      : getProjectSkillDir(workingDirectory, skillName);
  } else {
    targetDir = requestedSource === 'agents'
      ? getUserAgentsSkillDir(skillName)
      : getUserSkillDir(skillName);
  }
  
  fs.mkdirSync(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, 'SKILL.md');
  
  // Extract fields
  const { instructions, scope: _ignored, source: _sourceIgnored, supportingFiles: supportingFilesData, ...frontmatter } = config as Record<string, unknown> & { 
    instructions?: unknown; 
    scope?: unknown; 
    source?: unknown;
    supportingFiles?: Array<{ path: string; content: string }>;
  };
  void _ignored;
  void _sourceIgnored;
  
  // Ensure required fields
  if (!frontmatter.name) {
    frontmatter.name = skillName;
  }
  if (!frontmatter.description) {
    throw new Error('Skill description is required');
  }
  
  writeMdFile(targetPath, frontmatter, typeof instructions === 'string' ? instructions : '');
  
  // Write supporting files if provided
  if (supportingFilesData && Array.isArray(supportingFilesData)) {
    for (const file of supportingFilesData) {
      if (file.path && file.content !== undefined) {
        writeSkillSupportingFile(targetDir, file.path, file.content);
      }
    }
  }
};

export const updateSkill = (
  skillName: string,
  updates: Record<string, unknown>,
  workingDirectory?: string,
  discoveredSkill?: DiscoveredSkill | null,
): void => {
  const existing = discoveredSkill?.name === skillName && discoveredSkill.path
    ? { scope: discoveredSkill.scope, path: discoveredSkill.path, source: discoveredSkill.source }
    : getSkillScope(skillName, workingDirectory);
  if (!existing.path) {
    throw new Error(`Skill "${skillName}" not found`);
  }
  
  const mdPath = existing.path;
  const mdDir = path.dirname(mdPath);
  const mdData = parseMdFile(mdPath);
  let mdModified = false;
  
  for (const [field, value] of Object.entries(updates || {})) {
    if (field === 'scope') continue;
    
    if (field === 'instructions') {
      const normalizedValue = typeof value === 'string' ? value : value == null ? '' : String(value);
      mdData.body = normalizedValue;
      mdModified = true;
      continue;
    }
    
    if (field === 'supportingFiles' && Array.isArray(value)) {
      for (const file of value as Array<{ delete?: boolean; path?: string; content?: string }>) {
        if (file.delete && file.path) {
          deleteSkillSupportingFile(mdDir, file.path);
        } else if (file.path && file.content !== undefined) {
          writeSkillSupportingFile(mdDir, file.path, file.content);
        }
      }
      continue;
    }
    
    mdData.frontmatter[field] = value;
    mdModified = true;
  }
  
  if (mdModified) {
    writeMdFile(mdPath, mdData.frontmatter, mdData.body);
  }
};

export const deleteSkill = (skillName: string, workingDirectory?: string, discoveredSkill?: DiscoveredSkill | null): void => {
  const existing = discoveredSkill?.name === skillName && discoveredSkill.path
    ? discoveredSkill
    : getSkillScope(skillName, workingDirectory);

  if (
    !existing?.path
    || path.basename(existing.path).toLowerCase() !== 'skill.md'
    || !isExistingFile(existing.path)
  ) {
    throw new Error(`Skill "${skillName}" not found`);
  }

  fs.rmSync(path.dirname(existing.path), { recursive: true, force: true });
};
