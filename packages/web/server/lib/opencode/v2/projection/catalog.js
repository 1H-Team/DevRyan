// ---------------------------------------------------------------------------
// Gen 2 (OpenCode 2.x) catalog reads -> the v1 shapes DevRyan consumers read.
//
// Inputs are the unwrapped `data` of the v2 routes (the caller strips the
// `{location, data}` envelope): /api/agent, /api/provider, /api/model,
// /api/model/default, /api/command, /api/skill, /api/mcp, /api/config (an
// entry list, no envelope), /api/location, /api/project and /api/vcs.
//
//   agents     Agent.Info -> v1 Agent: name = id, model Ref -> {modelID,
//              providerID} + variant, system -> prompt, permissions ->
//              permission [{permission, pattern, action}] with v1 tool names.
//   providers  Provider.Info + Model.Info[] + default -> `{providers, default}`
//              (/config/providers: usable providers, enabled models) and
//              `{all, default, connected}` (/provider).
//   models     Model.Info -> v1 Model: capabilities as v1 booleans, variants
//              array -> record, cost array -> base + tiers, package -> v1 npm.
//   config     Config.Entry[] (low -> high) deep-merged, then v1 key names.
//   others     commands, skills, MCP status map, path, project, vcs.
//
// Credentials never pass through: credential-like keys (apiKey, tokens,
// secrets, Authorization) are dropped from every settings/options/headers/
// environment map, because v2 returns provider settings with raw keys and the
// browser reads these views. Everything here is pure.
// ---------------------------------------------------------------------------

import { toV1ToolName } from './tools.js';

const EMPTY_RECORD = Object.freeze({});

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const listOf = (value) => (Array.isArray(value) ? value.filter(isRecord) : []);

// Matches keys such as key, apiKey, api_key, x-api-key, token, accessToken,
// secret, client_secret, password, authorization, proxy-authorization, cookie
// and credentials.
const SECRET_KEY_PATTERN = /^(?:key|.*api[-_]?key|.*token|.*secret|.*password|.*authorization|cookie|credentials?)$/i;

/**
 * Drops credential-like keys from a settings/options/headers map, recursively
 * for nested records. Returns the same reference when nothing is dropped.
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export const redactCredentials = (value) => {
  if (!isRecord(value)) return {};
  let changed = false;
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      changed = true;
      continue;
    }
    if (isRecord(entry)) {
      const nested = redactCredentials(entry);
      if (nested !== entry) changed = true;
      result[key] = nested;
      continue;
    }
    result[key] = entry;
  }
  return changed ? result : value;
};

// v1 npm package <- v2 package, the inverse of OpenCode 2.0.20's legacy package
// migration table (core/dist/chunks/credential-sknxvkc8.js `PACKAGES`).
const V2_TO_V1_PACKAGES = new Map([
  ['@opencode/ai/providers/amazon-bedrock', '@ai-sdk/amazon-bedrock'],
  ['@opencode/ai/providers/amazon-bedrock/mantle', '@ai-sdk/amazon-bedrock/mantle'],
  ['@opencode/ai/providers/alibaba/chat', '@ai-sdk/alibaba'],
  ['@opencode/ai/providers/anthropic', '@ai-sdk/anthropic'],
  ['@opencode/ai/providers/azure/responses', '@ai-sdk/azure'],
  ['@opencode/ai/providers/azure/chat', '@ai-sdk/azure'],
  ['@opencode/ai/providers/cerebras', '@ai-sdk/cerebras'],
  ['@opencode/ai/providers/deepinfra', '@ai-sdk/deepinfra'],
  ['@opencode/ai/providers/google', '@ai-sdk/google'],
  ['@opencode/ai/providers/google-vertex', '@ai-sdk/google-vertex'],
  ['@opencode/ai/providers/google-vertex/messages', '@ai-sdk/google-vertex/anthropic'],
  ['@opencode/ai/providers/groq', '@ai-sdk/groq'],
  ['@opencode/ai/providers/mistral', '@ai-sdk/mistral'],
  ['@opencode/ai/providers/openai', '@ai-sdk/openai'],
  ['@opencode/ai/providers/openai-compatible', '@ai-sdk/openai-compatible'],
  ['@opencode/ai/providers/togetherai', '@ai-sdk/togetherai'],
  ['@opencode/ai/providers/xai', '@ai-sdk/xai'],
  ['@opencode/ai/providers/openrouter', '@openrouter/ai-sdk-provider'],
  ['@opencode/ai/providers/cloudflare-ai-gateway', 'ai-gateway-provider'],
]);

// Host-specific v2 packages encode the v1 protocol as a suffix (`protocols()`
// in the same core chunk).
const V2_PROTOCOL_SUFFIX_TO_V1 = [
  ['/chat', '@ai-sdk/openai-compatible'],
  ['/messages', '@ai-sdk/anthropic'],
  ['/responses', '@ai-sdk/openai'],
];

const V2_PROVIDER_PACKAGE_PREFIX = '@opencode/ai/providers/';

/**
 * The v1 npm package name for a v2 provider package. Host packages without a
 * protocol suffix (deepseek, baseten, fireworks, ...) were migrated from
 * `@ai-sdk/openai-compatible`. Non-OpenCode packages pass through.
 * @param {unknown} pkg
 * @returns {string}
 */
export const toV1ProviderPackage = (pkg) => {
  if (!isNonEmptyString(pkg)) return '';
  const known = V2_TO_V1_PACKAGES.get(pkg);
  if (known) return known;
  if (!pkg.startsWith(V2_PROVIDER_PACKAGE_PREFIX)) return pkg;
  for (const [suffix, v1Package] of V2_PROTOCOL_SUFFIX_TO_V1) {
    if (pkg.endsWith(suffix)) return v1Package;
  }
  return '@ai-sdk/openai-compatible';
};

// ----------------------------------------------------------------- permissions

/**
 * v2 `Permission.Ruleset` -> v1 `PermissionRuleset` (`{permission, pattern,
 * action}`), with v2 tool actions renamed to v1 names.
 * @param {unknown} rules
 * @returns {{ permission: string, pattern: string, action: string }[]}
 */
export const toV1PermissionRuleset = (rules) => listOf(rules)
  .filter((rule) => typeof rule.action === 'string' && typeof rule.resource === 'string'
    && typeof rule.effect === 'string')
  .map((rule) => ({ permission: toV1ToolName(rule.action), pattern: rule.resource, action: rule.effect }));

/**
 * v2 ordered ruleset -> the v1 config object form `{key: action | {pattern: action}}`.
 * A `*` rule on a key without patterns stays a plain action string.
 * @param {unknown} rules
 * @returns {Record<string, string | Record<string, string>>}
 */
const toV1PermissionConfig = (rules) => {
  /** @type {Record<string, string | Record<string, string>>} */
  const config = {};
  for (const rule of toV1PermissionRuleset(rules)) {
    const current = config[rule.permission];
    if (current === undefined && rule.pattern === '*') {
      config[rule.permission] = rule.action;
      continue;
    }
    const patterns = typeof current === 'string' ? { '*': current } : { ...(current ?? {}) };
    patterns[rule.pattern] = rule.action;
    config[rule.permission] = patterns;
  }
  return config;
};

// ---------------------------------------------------------------------- agents

/**
 * A v2 `Agent.Info` as a v1 Agent. `native`, `temperature` and `topP` have no
 * v2 field; `temperature`/`topP` are read back from `request.body` where the
 * v1 migration puts them. Phase 4 refines this mapping.
 * @param {unknown} agent
 * @returns {Record<string, unknown> | null}
 */
export const toV1Agent = (agent) => {
  if (!isRecord(agent) || !isNonEmptyString(agent.id)) return null;
  const request = isRecord(agent.request) ? agent.request : EMPTY_RECORD;
  const body = isRecord(request.body) ? request.body : EMPTY_RECORD;
  /** @type {Record<string, unknown>} */
  const projected = {
    name: agent.id,
    mode: typeof agent.mode === 'string' ? agent.mode : 'primary',
    hidden: agent.hidden === true,
    permission: toV1PermissionRuleset(agent.permissions),
    options: redactCredentials(request.settings),
  };
  if (typeof agent.description === 'string') projected.description = agent.description;
  if (typeof agent.color === 'string') projected.color = agent.color;
  if (Number.isSafeInteger(agent.steps)) projected.steps = agent.steps;
  if (typeof agent.system === 'string') projected.prompt = agent.system;
  if (isFiniteNumber(body.temperature)) projected.temperature = body.temperature;
  if (isFiniteNumber(body.top_p)) projected.topP = body.top_p;
  const model = isRecord(agent.model) ? agent.model : null;
  if (model && isNonEmptyString(model.id) && isNonEmptyString(model.providerID)) {
    projected.model = { modelID: model.id, providerID: model.providerID };
    if (isNonEmptyString(model.variant)) projected.variant = model.variant;
  }
  return projected;
};

/**
 * @param {unknown} agents the `/api/agent` data
 * @returns {Record<string, unknown>[]}
 */
export const toV1Agents = (agents) => listOf(agents).map(toV1Agent).filter((agent) => agent !== null);

// ---------------------------------------------------------- providers / models

const MODALITIES = ['text', 'audio', 'image', 'video', 'pdf'];

const toV1Modalities = (list) => {
  const present = new Set(Array.isArray(list) ? list : []);
  return Object.fromEntries(MODALITIES.map((modality) => [modality, present.has(modality)]));
};

const zeroCost = () => ({ input: 0, output: 0, cache: { read: 0, write: 0 } });

const toV1CostEntry = (cost) => {
  const cache = isRecord(cost.cache) ? cost.cache : EMPTY_RECORD;
  return {
    input: isFiniteNumber(cost.input) ? cost.input : 0,
    output: isFiniteNumber(cost.output) ? cost.output : 0,
    cache: {
      read: isFiniteNumber(cache.read) ? cache.read : 0,
      write: isFiniteNumber(cache.write) ? cache.write : 0,
    },
  };
};

/** v2 `cost: Cost[]` (untiered base plus context tiers) -> v1 `cost {…, tiers?}`. */
const toV1Cost = (costs) => {
  const entries = listOf(costs);
  const base = entries.find((entry) => !isRecord(entry.tier));
  const projected = base ? toV1CostEntry(base) : zeroCost();
  const tiers = entries
    .filter((entry) => isRecord(entry.tier) && Number.isSafeInteger(entry.tier.size))
    .map((entry) => ({ ...toV1CostEntry(entry), tier: { type: 'context', size: entry.tier.size } }));
  return tiers.length === 0 ? projected : { ...projected, tiers };
};

const toV1ReleaseDate = (time) => {
  const released = isRecord(time) ? time.released : undefined;
  if (!isFiniteNumber(released) || released <= 0) return '';
  const date = new Date(released);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
};

const toV1Variants = (variants) => Object.fromEntries(
  listOf(variants)
    .filter((variant) => isNonEmptyString(variant.id))
    .map((variant) => [variant.id, redactCredentials(variant.settings)]),
);

/** Model settings without the keys it inherited unchanged from its provider. */
const modelOwnSettings = (settings, providerSettings) => {
  const own = redactCredentials(settings);
  if (!isRecord(providerSettings)) return own;
  const entries = Object.entries(own).filter(([key, value]) => (
    !Object.hasOwn(providerSettings, key) || providerSettings[key] !== value
  ));
  return entries.length === Object.keys(own).length ? own : Object.fromEntries(entries);
};

/**
 * A v2 `Model.Info` as a v1 Model. `reasoning` is inferred (variants or a
 * reasoning field); `temperature` has no v2 capability and reads `true`.
 * @param {unknown} model
 * @param {unknown} [provider] the model's v2 `Provider.Info`, for `api.url` and
 *   to drop provider-level settings from the model options
 * @returns {Record<string, unknown> | null}
 */
export const toV1Model = (model, provider) => {
  if (!isRecord(model) || !isNonEmptyString(model.id) || !isNonEmptyString(model.providerID)) return null;
  const providerSettings = isRecord(provider) && isRecord(provider.settings) ? provider.settings : undefined;
  const settings = isRecord(model.settings) ? model.settings : EMPTY_RECORD;
  const capabilities = isRecord(model.capabilities) ? model.capabilities : EMPTY_RECORD;
  const compatibility = isRecord(model.compatibility) ? model.compatibility : EMPTY_RECORD;
  const input = toV1Modalities(capabilities.input);
  const variants = toV1Variants(model.variants);
  const reasoningField = isNonEmptyString(compatibility.reasoningField) ? compatibility.reasoningField : undefined;
  const baseURL = [settings.baseURL, providerSettings?.baseURL].find(isNonEmptyString) ?? '';
  const limit = isRecord(model.limit) ? model.limit : EMPTY_RECORD;
  /** @type {Record<string, unknown>} */
  const projected = {
    id: model.id,
    providerID: model.providerID,
    api: {
      id: isNonEmptyString(model.modelID) ? model.modelID : model.id,
      url: baseURL,
      npm: toV1ProviderPackage(model.package ?? (isRecord(provider) ? provider.package : undefined)),
    },
    name: isNonEmptyString(model.name) ? model.name : model.id,
    capabilities: {
      temperature: true,
      reasoning: Object.keys(variants).length > 0 || reasoningField !== undefined
        || compatibility.requireReasoning === true,
      attachment: Object.entries(input).some(([modality, present]) => modality !== 'text' && present),
      toolcall: capabilities.tools !== false,
      input,
      output: toV1Modalities(capabilities.output),
      interleaved: reasoningField === undefined ? false : { field: reasoningField },
    },
    cost: toV1Cost(model.cost),
    limit: {
      context: Number.isSafeInteger(limit.context) ? limit.context : 0,
      ...(Number.isSafeInteger(limit.input) ? { input: limit.input } : {}),
      output: Number.isSafeInteger(limit.output) ? limit.output : 0,
    },
    status: typeof model.status === 'string' ? model.status : 'active',
    options: modelOwnSettings(settings, providerSettings),
    headers: redactCredentials(model.headers),
    release_date: toV1ReleaseDate(model.time),
    variants,
  };
  if (isNonEmptyString(model.family)) projected.family = model.family;
  return projected;
};

const isUsableProvider = (provider) => provider.activation !== 'disabled';

const groupModelsByProvider = (models) => {
  /** @type {Map<string, Record<string, unknown>[]>} */
  const byProvider = new Map();
  for (const model of listOf(models)) {
    if (!isNonEmptyString(model.providerID) || !isNonEmptyString(model.id)) continue;
    const list = byProvider.get(model.providerID) ?? [];
    list.push(model);
    byProvider.set(model.providerID, list);
  }
  return byProvider;
};

/**
 * A v2 `Provider.Info` with its models as a v1 Provider. `source` is `api` for
 * providers backed by an integration, else `config`; `env` and `key` have no
 * v2 counterpart (the key is never exposed). `integrationID` is passed through
 * for the integration-based auth flow.
 * @param {unknown} provider
 * @param {unknown} models the provider's v2 `Model.Info` entries
 * @param {{ enabledOnly?: boolean }} [options]
 * @returns {Record<string, unknown> | null}
 */
export const toV1Provider = (provider, models, options = {}) => {
  if (!isRecord(provider) || !isNonEmptyString(provider.id)) return null;
  /** @type {Record<string, Record<string, unknown>>} */
  const v1Models = {};
  for (const model of listOf(models)) {
    if (model.providerID !== provider.id) continue;
    if (options.enabledOnly === true && model.enabled === false) continue;
    const projected = toV1Model(model, provider);
    if (projected) v1Models[/** @type {string} */ (projected.id)] = projected;
  }
  /** @type {Record<string, unknown>} */
  const projected = {
    id: provider.id,
    name: isNonEmptyString(provider.name) ? provider.name : provider.id,
    source: isNonEmptyString(provider.integrationID) ? 'api' : 'config',
    env: [],
    options: redactCredentials(provider.settings),
    models: v1Models,
  };
  if (isNonEmptyString(provider.integrationID)) projected.integrationID = provider.integrationID;
  return projected;
};

/**
 * v1 `default: {providerID: modelID}`. The v2 default model wins for its
 * provider; every other provider defaults to its first enabled model in list
 * order (v2 has a single default, v1 had one per provider).
 */
const defaultModelMap = (providerIds, byProvider, defaultModel) => {
  /** @type {Record<string, string>} */
  const defaults = {};
  for (const providerID of providerIds) {
    const first = (byProvider.get(providerID) ?? []).find((model) => model.enabled !== false);
    if (first) defaults[providerID] = /** @type {string} */ (first.id);
  }
  if (isRecord(defaultModel) && isNonEmptyString(defaultModel.providerID) && isNonEmptyString(defaultModel.id)
    && Object.hasOwn(defaults, defaultModel.providerID)) {
    defaults[defaultModel.providerID] = defaultModel.id;
  }
  return defaults;
};

/**
 * @typedef {object} V2ProviderCatalog
 * @property {unknown} providers `/api/provider` data
 * @property {unknown} models `/api/model` data
 * @property {unknown} [defaultModel] `/api/model/default` data (may be null)
 */

/**
 * The v1 `GET /config/providers` payload: usable providers (not disabled, at
 * least one enabled model) with their enabled models, and the default map.
 * @param {V2ProviderCatalog} catalog
 * @returns {{ providers: Record<string, unknown>[], default: Record<string, string> }}
 */
export const toV1ConfigProviders = ({ providers, models, defaultModel }) => {
  const byProvider = groupModelsByProvider(models);
  const projected = [];
  for (const provider of listOf(providers)) {
    if (!isUsableProvider(provider)) continue;
    const entry = toV1Provider(provider, byProvider.get(provider.id), { enabledOnly: true });
    if (entry && Object.keys(/** @type {Record<string, unknown>} */ (entry.models)).length > 0) projected.push(entry);
  }
  return {
    providers: projected,
    default: defaultModelMap(projected.map((provider) => provider.id), byProvider, defaultModel),
  };
};

/**
 * The v1 `GET /provider` payload: every listed provider with all its models,
 * the default map, and `connected` = the providers `/config/providers` lists.
 * @param {V2ProviderCatalog} catalog
 * @returns {{ all: Record<string, unknown>[], default: Record<string, string>, connected: string[] }}
 */
export const toV1ProviderList = ({ providers, models, defaultModel }) => {
  const byProvider = groupModelsByProvider(models);
  const all = [];
  for (const provider of listOf(providers)) {
    const entry = toV1Provider(provider, byProvider.get(provider.id));
    if (entry) all.push(entry);
  }
  const connected = toV1ConfigProviders({ providers, models, defaultModel }).providers
    .map((provider) => /** @type {string} */ (provider.id));
  return { all, default: defaultModelMap(connected, byProvider, defaultModel), connected };
};

// -------------------------------------------------------------------- commands

/**
 * v2 `Command.Info {name, description}` as v1 Commands. v2 drops template,
 * agent, model and subtask from the list; when a merged v1 config view is
 * given ({@link toV1Config}), its `command` entries fill them in.
 * @param {unknown} commands the `/api/command` data
 * @param {{ config?: unknown }} [options]
 * @returns {Record<string, unknown>[]}
 */
export const toV1Commands = (commands, options = {}) => {
  const configured = isRecord(options.config) && isRecord(options.config.command) ? options.config.command : EMPTY_RECORD;
  return listOf(commands)
    .filter((command) => isNonEmptyString(command.name))
    .map((command) => {
      const definition = isRecord(configured[command.name]) ? configured[command.name] : EMPTY_RECORD;
      /** @type {Record<string, unknown>} */
      const projected = {
        name: command.name,
        source: 'command',
        template: typeof definition.template === 'string' ? definition.template : '',
        hints: [],
      };
      const description = typeof command.description === 'string' ? command.description : definition.description;
      if (typeof description === 'string') projected.description = description;
      if (isNonEmptyString(definition.agent)) projected.agent = definition.agent;
      if (isNonEmptyString(definition.model)) projected.model = definition.model;
      if (typeof definition.subtask === 'boolean') projected.subtask = definition.subtask;
      return projected;
    });
};

// ---------------------------------------------------------------------- skills

/**
 * v2 `Skill.Info` as the v1 skill list entry `{name, description?, location,
 * content}`. The v2 `id` (directory name, the permission resource) is kept.
 * @param {unknown} skills the `/api/skill` data
 * @returns {Record<string, unknown>[]}
 */
export const toV1Skills = (skills) => listOf(skills)
  .filter((skill) => isNonEmptyString(skill.id) || isNonEmptyString(skill.name))
  .map((skill) => {
    /** @type {Record<string, unknown>} */
    const projected = {
      name: isNonEmptyString(skill.name) ? skill.name : skill.id,
      location: typeof skill.path === 'string' ? skill.path : '',
      content: typeof skill.content === 'string' ? skill.content : '',
      id: isNonEmptyString(skill.id) ? skill.id : skill.name,
    };
    if (typeof skill.description === 'string') projected.description = skill.description;
    if (typeof skill.autoinvoke === 'boolean') projected.autoinvoke = skill.autoinvoke;
    return projected;
  });

// ------------------------------------------------------------------------- mcp

/**
 * v2 `Mcp.Server[]` -> the v1 `GET /mcp` record `{name: {status, error?}}`.
 * v2 `pending` has no v1 status and passes through (it reads as neither
 * connected nor failed).
 * @param {unknown} servers the `/api/mcp` data
 * @returns {Record<string, { status: string, error?: string }>}
 */
export const toV1McpStatus = (servers) => {
  /** @type {Record<string, { status: string, error?: string }>} */
  const statuses = {};
  for (const server of listOf(servers)) {
    if (!isNonEmptyString(server.name) || !isRecord(server.status)) continue;
    const { status, error } = server.status;
    if (!isNonEmptyString(status)) continue;
    statuses[server.name] = typeof error === 'string' ? { status, error } : { status };
  }
  return statuses;
};

// ---------------------------------------------------------------------- config

// Ordered rule and directive lists accumulate across documents instead of
// replacing: v2 pushes every document's `permissions` onto the ruleset, and
// `plugins` are ordered enable/disable directives. Paths are key lists where
// `*` matches any key.
const CONCATENATED_PATHS = [['permissions'], ['plugins'], ['agents', '*', 'permissions']];

const isConcatenatedPath = (path) => CONCATENATED_PATHS.some((pattern) => (
  pattern.length === path.length && pattern.every((key, index) => key === '*' || key === path[index])
));

const deepMerge = (base, overlay, path = []) => {
  /** @type {Record<string, unknown>} */
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    const childPath = [...path, key];
    const current = merged[key];
    if (Array.isArray(value) && Array.isArray(current) && isConcatenatedPath(childPath)) {
      merged[key] = [...current, ...value];
    } else if (isRecord(value) && isRecord(current)) {
      merged[key] = deepMerge(current, value, childPath);
    } else {
      merged[key] = value;
    }
  }
  return merged;
};

/**
 * Deep-merges the `info` of every `document` entry in order (v2 lists layers
 * low -> high, so later documents win). Arrays replace, except the ordered
 * `permissions` rulesets (top level and per agent) and `plugins` directives,
 * which accumulate in layer order. Directory entries contribute no keys.
 * @param {unknown} entries the `/api/config` body
 * @returns {Record<string, unknown>}
 */
export const mergeV2ConfigEntries = (entries) => {
  let merged = {};
  for (const entry of listOf(entries)) {
    if (entry.type !== 'document' || !isRecord(entry.info)) continue;
    merged = deepMerge(merged, entry.info);
  }
  return merged;
};

/**
 * Directory layers of `/api/config`, in order (the v1 config directories).
 * @param {unknown} entries
 * @returns {string[]}
 */
export const configDirectories = (entries) => listOf(entries)
  .filter((entry) => entry.type === 'directory' && isNonEmptyString(entry.path))
  .map((entry) => /** @type {string} */ (entry.path));

/**
 * A v2 `ConfigModel.Selection` ('p/m#v' or {providerID, model, variant}) as the
 * v1 pair `{model: 'p/m', variant?}`. Returns `null` when unparseable.
 * @param {unknown} selection
 * @returns {{ model: string, variant?: string } | null}
 */
export const toV1ModelSelection = (selection) => {
  if (typeof selection === 'string') {
    const hash = selection.indexOf('#');
    const model = hash === -1 ? selection : selection.slice(0, hash);
    const variant = hash === -1 ? '' : selection.slice(hash + 1);
    if (model.indexOf('/') <= 0) return null;
    return variant ? { model, variant } : { model };
  }
  if (!isRecord(selection) || !isNonEmptyString(selection.providerID) || !isNonEmptyString(selection.model)) {
    return null;
  }
  const model = `${selection.providerID}/${selection.model}`;
  return isNonEmptyString(selection.variant) ? { model, variant: selection.variant } : { model };
};

const toV1ConfigAgent = (agent) => {
  /** @type {Record<string, unknown>} */
  const projected = {};
  const selection = toV1ModelSelection(agent.model);
  if (selection) {
    projected.model = selection.model;
    if (selection.variant) projected.variant = selection.variant;
  }
  if (typeof agent.system === 'string') projected.prompt = agent.system;
  for (const key of ['description', 'mode', 'hidden', 'color', 'steps']) {
    if (agent[key] !== undefined) projected[key] = agent[key];
  }
  if (agent.disabled === true) projected.disable = true;
  if (Array.isArray(agent.permissions)) projected.permission = toV1PermissionConfig(agent.permissions);
  const body = isRecord(agent.request) && isRecord(agent.request.body) ? agent.request.body : EMPTY_RECORD;
  if (isFiniteNumber(body.temperature)) projected.temperature = body.temperature;
  if (isFiniteNumber(body.top_p)) projected.top_p = body.top_p;
  return projected;
};

const toV1ConfigCommand = (command) => {
  /** @type {Record<string, unknown>} */
  const projected = {};
  if (typeof command.template === 'string') projected.template = command.template;
  if (typeof command.description === 'string') projected.description = command.description;
  if (isNonEmptyString(command.agent)) projected.agent = command.agent;
  const selection = toV1ModelSelection(command.model);
  if (selection) {
    projected.model = selection.model;
    if (selection.variant) projected.variant = selection.variant;
  }
  const subtask = command.subagent ?? command.subtask;
  if (typeof subtask === 'boolean') projected.subtask = subtask;
  return projected;
};

const toV1ConfigProviderModel = (model) => {
  /** @type {Record<string, unknown>} */
  const projected = {};
  for (const key of ['name', 'family', 'limit']) {
    if (model[key] !== undefined) projected[key] = model[key];
  }
  if (isNonEmptyString(model.modelID)) projected.id = model.modelID;
  if (isRecord(model.settings)) projected.options = redactCredentials(model.settings);
  if (isRecord(model.headers)) projected.headers = redactCredentials(model.headers);
  if (Array.isArray(model.variants)) projected.variants = toV1Variants(model.variants);
  return projected;
};

const toV1ConfigProvider = (provider) => {
  /** @type {Record<string, unknown>} */
  const projected = {};
  if (typeof provider.name === 'string') projected.name = provider.name;
  if (isNonEmptyString(provider.package)) projected.npm = toV1ProviderPackage(provider.package);
  if (Array.isArray(provider.env)) projected.env = provider.env;
  const options = redactCredentials(provider.settings);
  const headers = redactCredentials(provider.headers);
  if (Object.keys(headers).length > 0) {
    projected.options = { ...options, headers };
  } else if (isRecord(provider.settings)) {
    projected.options = options;
  }
  if (isRecord(provider.models)) {
    projected.models = Object.fromEntries(Object.entries(provider.models)
      .filter(([, model]) => isRecord(model))
      .map(([id, model]) => [id, toV1ConfigProviderModel(model)]));
  }
  return projected;
};

const toV1McpTimeout = (timeout) => (isRecord(timeout) && isFiniteNumber(timeout.execution) ? timeout.execution : undefined);

const toV1ConfigMcp = (mcp) => {
  const servers = isRecord(mcp.servers) ? mcp.servers : EMPTY_RECORD;
  const globalTimeout = toV1McpTimeout(mcp.timeout);
  /** @type {Record<string, Record<string, unknown>>} */
  const projected = {};
  for (const [name, server] of Object.entries(servers)) {
    if (!isRecord(server) || (server.type !== 'local' && server.type !== 'remote')) continue;
    /** @type {Record<string, unknown>} */
    const entry = { type: server.type, enabled: server.disabled !== true };
    if (server.type === 'local') {
      if (Array.isArray(server.command)) entry.command = server.command;
      if (isRecord(server.environment)) entry.environment = redactCredentials(server.environment);
    } else {
      if (typeof server.url === 'string') entry.url = server.url;
      if (isRecord(server.headers)) entry.headers = redactCredentials(server.headers);
      if (server.oauth === false) entry.oauth = false;
      if (isRecord(server.oauth)) {
        const { client_id: clientId, scope, redirect_uri: redirectUri } = server.oauth;
        entry.oauth = {
          ...(isNonEmptyString(clientId) ? { clientId } : {}),
          ...(isNonEmptyString(scope) ? { scope } : {}),
          ...(isNonEmptyString(redirectUri) ? { redirectUri } : {}),
        };
      }
    }
    const timeout = toV1McpTimeout(server.timeout) ?? globalTimeout;
    if (timeout !== undefined) entry.timeout = timeout;
    projected[name] = entry;
  }
  return projected;
};

const toV1Plugins = (plugins) => plugins
  .map((plugin) => {
    if (typeof plugin === 'string') return plugin;
    if (!isRecord(plugin) || !isNonEmptyString(plugin.package)) return null;
    return isRecord(plugin.options) ? [plugin.package, plugin.options] : plugin.package;
  })
  .filter((plugin) => plugin !== null);

const toV1SkillSources = (skills) => {
  const urls = skills.filter((entry) => typeof entry === 'string' && /^https?:\/\//i.test(entry));
  const paths = skills.filter((entry) => typeof entry === 'string' && !/^https?:\/\//i.test(entry));
  return { ...(paths.length > 0 ? { paths } : {}), ...(urls.length > 0 ? { urls } : {}) };
};

const UPDATE_TO_AUTOUPDATE = new Map([['disable', false], ['auto', true], ['notify', 'notify']]);

// v2 keys whose value and meaning match v1 exactly.
const PASS_THROUGH_CONFIG_KEYS = [
  '$schema', 'shell', 'default_agent', 'share', 'username', 'enterprise', 'instructions',
  'formatter', 'lsp', 'tool_output', 'compaction', 'references', 'watcher',
];

/**
 * The merged v1 config view (`GET /config`) of a v2 `/api/config` entry list.
 * Keys are renamed to their v1 names (agents -> agent, commands -> command,
 * providers -> provider, permissions -> permission, snapshots -> snapshot,
 * update -> autoupdate, plugins -> plugin, skills [] -> {paths, urls}, the
 * title agent's model -> small_model). Credentials are dropped. Keys with no
 * v1 counterpart (experimental policies, media, warming, websearch, worktree)
 * are left out.
 * @param {unknown} entries the `/api/config` body
 * @returns {Record<string, unknown>}
 */
export const toV1Config = (entries) => {
  const info = mergeV2ConfigEntries(entries);
  /** @type {Record<string, unknown>} */
  const config = {};
  for (const key of PASS_THROUGH_CONFIG_KEYS) {
    if (info[key] !== undefined) config[key] = info[key];
  }
  const model = toV1ModelSelection(info.model);
  if (model) config.model = model.model;
  if (typeof info.snapshots === 'boolean') config.snapshot = info.snapshots;
  if (UPDATE_TO_AUTOUPDATE.has(info.update)) config.autoupdate = UPDATE_TO_AUTOUPDATE.get(info.update);
  if (Array.isArray(info.permissions)) config.permission = toV1PermissionConfig(info.permissions);
  if (Array.isArray(info.plugins)) config.plugin = toV1Plugins(info.plugins);
  if (Array.isArray(info.skills)) config.skills = toV1SkillSources(info.skills);
  if (isRecord(info.agents)) {
    config.agent = Object.fromEntries(Object.entries(info.agents)
      .filter(([, agent]) => isRecord(agent))
      .map(([id, agent]) => [id, toV1ConfigAgent(agent)]));
    const title = isRecord(info.agents.title) ? toV1ModelSelection(info.agents.title.model) : null;
    if (title) config.small_model = title.model;
  }
  if (isRecord(info.commands)) {
    config.command = Object.fromEntries(Object.entries(info.commands)
      .filter(([, command]) => isRecord(command))
      .map(([name, command]) => [name, toV1ConfigCommand(command)]));
  }
  if (isRecord(info.providers)) {
    config.provider = Object.fromEntries(Object.entries(info.providers)
      .filter(([, provider]) => isRecord(provider))
      .map(([id, provider]) => [id, toV1ConfigProvider(provider)]));
  }
  if (isRecord(info.mcp)) config.mcp = toV1ConfigMcp(info.mcp);
  return config;
};

// ------------------------------------------------------- path / project / vcs

/**
 * @typedef {object} HostPaths
 * @property {string} [home]
 * @property {string} [state]
 * @property {string} [config]
 */

/**
 * The v1 `GET /path` payload from a v2 `Location.PublicInfo`. v2 serves no
 * home/state/config paths; the host supplies them (empty strings otherwise).
 * `worktree` is the location's project directory (the current worktree root).
 * @param {unknown} location the `/api/location` body
 * @param {HostPaths} [paths]
 * @returns {{ home: string, state: string, config: string, worktree: string, directory: string } | null}
 */
export const toV1Path = (location, paths = {}) => {
  if (!isRecord(location) || !isNonEmptyString(location.directory)) return null;
  const project = isRecord(location.project) ? location.project : EMPTY_RECORD;
  return {
    home: isNonEmptyString(paths.home) ? paths.home : '',
    state: isNonEmptyString(paths.state) ? paths.state : '',
    config: isNonEmptyString(paths.config) ? paths.config : '',
    worktree: isNonEmptyString(project.directory) ? project.directory : location.directory,
    directory: location.directory,
  };
};

/**
 * A v2 `Project.Info` as a v1 Project (`worktree = canonical`; the v2-only
 * `time.active` is dropped).
 * @param {unknown} project
 * @returns {Record<string, unknown> | null}
 */
export const toV1Project = (project) => {
  if (!isRecord(project) || !isNonEmptyString(project.id) || !isNonEmptyString(project.canonical)) return null;
  const time = isRecord(project.time) ? project.time : EMPTY_RECORD;
  /** @type {Record<string, unknown>} */
  const projected = {
    id: project.id,
    worktree: project.canonical,
    time: {
      created: isFiniteNumber(time.created) ? time.created : 0,
      updated: isFiniteNumber(time.updated) ? time.updated : 0,
    },
    sandboxes: Array.isArray(project.sandboxes) ? project.sandboxes.filter((entry) => typeof entry === 'string') : [],
  };
  for (const key of ['vcs', 'name', 'icon', 'commands']) {
    if (project[key] !== undefined) projected[key] = project[key];
  }
  return projected;
};

/**
 * @param {unknown} projects the `/api/project` body
 * @returns {Record<string, unknown>[]}
 */
export const toV1Projects = (projects) => listOf(projects).map(toV1Project).filter((project) => project !== null);

/**
 * The v1 `GET /project/current` payload: the project of a v2 location, taken
 * from the project list when present, else built from the location alone.
 * @param {unknown} location the `/api/location` body
 * @param {unknown} [projects] the `/api/project` body
 * @returns {Record<string, unknown> | null}
 */
export const toV1CurrentProject = (location, projects) => {
  if (!isRecord(location) || !isRecord(location.project) || !isNonEmptyString(location.project.id)) return null;
  const { id, canonical } = location.project;
  const listed = listOf(projects).find((project) => project.id === id);
  if (listed) return toV1Project(listed);
  return toV1Project({ id, canonical, time: { created: 0, updated: 0 }, sandboxes: [] });
};

/**
 * v2 `Vcs.Info {provider?, branch: {current?, default?}}` -> v1 `VcsInfo {branch?, default_branch?}`.
 * @param {unknown} vcs the `/api/vcs` data
 * @returns {{ branch?: string, default_branch?: string }}
 */
export const toV1VcsInfo = (vcs) => {
  const branch = isRecord(vcs) && isRecord(vcs.branch) ? vcs.branch : EMPTY_RECORD;
  /** @type {{ branch?: string, default_branch?: string }} */
  const projected = {};
  if (isNonEmptyString(branch.current)) projected.branch = branch.current;
  if (isNonEmptyString(branch.default)) projected.default_branch = branch.default;
  return projected;
};
