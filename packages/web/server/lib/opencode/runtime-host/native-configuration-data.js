import {ConfigProvider} from '@opencode/schema/config/provider';
import {ConfigCompaction} from '@opencode/schema/config/compaction';
import {Schema} from 'effect';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => Object.assign(new Error(code), { code, status: 503 });

export function nativeModelSelection(model, variant, hasVariant = false) {
  let providerID, id;
  if (typeof model === 'string') { const split = model.indexOf('/'); providerID = model.slice(0, split); id = model.slice(split + 1); if (split < 1) throw fail('native_model_invalid'); }
  else if (record(model)) { providerID = model.providerID ?? model.providerId; id = model.modelID ?? model.modelId ?? model.model; }
  else throw fail('native_model_invalid');
  if (typeof providerID !== 'string' || !providerID || typeof id !== 'string' || !id) throw fail('native_model_invalid');
  const result = { providerID, model: id };
  if (hasVariant) {
    if (!(variant === null || typeof variant === 'string')) throw fail('native_variant_invalid');
    // Native persists the default variant under this exact ID. Explicit null
    // and empty saved aliases clear inheritance; omission keeps inheritance.
    result.variant = variant === null || variant === '' ? 'default' : variant;
  }
  return result;
}

export function nativePermissionRules(input) {
  if (Array.isArray(input)) return input.map(rule => {
    if (!record(rule)) throw fail('native_permissions_invalid');
    if ('permission' in rule) return { action: rule.permission, resource: rule.pattern, effect: rule.action };
    return { ...rule };
  });
  if (typeof input === 'string') return [{ action: '*', resource: '*', effect: input }];
  if (!record(input)) throw fail('native_permissions_invalid');
  return Object.entries(input).flatMap(([action, value]) => typeof value === 'string'
    ? [{ action, resource: '*', effect: value }]
    : record(value) ? Object.entries(value).map(([resource, effect]) => ({ action, resource, effect }))
      : (() => { throw fail('native_permissions_invalid'); })());
}

// Data-only mapping from pinned 2.0.20 ConfigMigrateV1.migrateProvider.
// The SDK migration entry imports the native runtime graph; a Node settings
// snapshot must not acquire that graph merely to translate provider data.
const aisdk = value => value.startsWith('aisdk:') ? value : `aisdk:${value}`;
const clone = value => value === undefined ? undefined : structuredClone(value);
const defined = value => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
const providerOptions = options => {
  if (!record(options)) throw fail('native_provider_options_invalid');
  const { headers, body, ...settings } = options;
  if (headers !== undefined && (!record(headers) || Object.values(headers).some(value => typeof value !== 'string'))) throw fail('native_provider_headers_invalid');
  if (body !== undefined && !record(body)) throw fail('native_provider_body_invalid');
  return defined({ settings: clone(settings), headers: clone(headers), body: clone(body) });
};
function providerModel(info) {
  if (!record(info)) throw fail('native_provider_model_invalid');
  const result = {};
  for (const key of ['family', 'name', 'headers']) if (info[key] !== undefined) result[key] = clone(info[key]);
  if (info.id !== undefined) result.modelID = info.id;
  if (info.options !== undefined) { if (!record(info.options)) throw fail('native_model_options_invalid'); result.settings = clone(info.options); }
  if (info.provider?.npm !== undefined) result.package = aisdk(info.provider.npm);
  if (info.provider?.api !== undefined) result.settings = { ...result.settings, baseURL: info.provider.api };
  const field = typeof info.interleaved === 'string' ? info.interleaved : info.interleaved?.field;
  if (typeof field === 'string') result.compatibility = { reasoningField: field };
  if (info.tool_call !== undefined || info.modalities?.input !== undefined || info.modalities?.output !== undefined) {
    result.capabilities = { tools: info.tool_call ?? true, input: clone(info.modalities?.input ?? ['text', 'image']), output: clone(info.modalities?.output ?? ['text']) };
  }
  if (info.variants !== undefined) {
    if (!record(info.variants)) throw fail('native_model_variants_invalid');
    result.variants = Object.entries(info.variants).map(([id, settings]) => {
      if (!record(settings)) throw fail('native_model_variant_invalid');
      return { id, settings: clone(settings) };
    });
  }
  if (info.cost !== undefined) {
    if (!record(info.cost)) throw fail('native_model_cost_invalid');
    const cost = value => defined({ input: value.input, output: value.output, cache: defined({ read: value.cache_read, write: value.cache_write }) });
    result.cost = [cost(info.cost)];
    if (info.cost.context_over_200k) result.cost.push({ ...cost(info.cost.context_over_200k), tier: { type: 'context', size: 200000 } });
  }
  if (info.status === 'deprecated') result.disabled = true;
  if (info.limit !== undefined) {
    if (!record(info.limit) || !Number.isFinite(info.limit.context) || !Number.isFinite(info.limit.output)) throw fail('native_model_limit_invalid');
    const int = value => Math.max(Number.MIN_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value)));
    result.limit = { context: int(info.limit.context), output: int(info.limit.output) };
    if (info.limit.input !== undefined) { if (!Number.isFinite(info.limit.input)) throw fail('native_model_limit_invalid'); result.limit.input = int(info.limit.input); }
  }
  return result;
}
export function nativeProviderConfigurations(input) {
  if (!record(input)) throw fail('native_providers_invalid');
  return Object.fromEntries(Object.entries(input).map(([id, provider]) => {
    if (!id || !record(provider)) throw fail('native_provider_invalid');
    const result = {};
    for (const key of ['name', 'env']) if (provider[key] !== undefined) result[key] = clone(provider[key]);
    if (provider.npm !== undefined) { if (typeof provider.npm !== 'string') throw fail('native_provider_package_invalid'); result.package = aisdk(provider.npm); }
    if (provider.options !== undefined) Object.assign(result, providerOptions(provider.options));
    if (provider.api !== undefined) result.settings = { ...result.settings, baseURL: provider.api };
    if (id === 'azure-cognitive-services') {
      result.canonical = 'azure';
      if (result.env !== undefined) result.env = result.env.filter(name => name !== 'AZURE_COGNITIVE_SERVICES_RESOURCE_NAME');
      if (provider.npm === '@ai-sdk/openai-compatible' && provider.api === undefined) result.settings = { ...result.settings, baseURL: 'https://${AZURE_COGNITIVE_SERVICES_RESOURCE_NAME}.cognitiveservices.azure.com/openai' };
    }
    if (provider.models !== undefined) {
      if (!record(provider.models)) throw fail('native_provider_models_invalid');
      result.models = Object.fromEntries(Object.entries(provider.models).map(([name, model]) => [name, providerModel(model)]));
    }
    if (id === 'google-vertex-anthropic') {
      result.canonical = 'google-vertex';
      const packageName = result.package ?? aisdk('@ai-sdk/google-vertex/anthropic');
      delete result.package;
      for (const model of Object.values(result.models ?? {})) model.package ??= packageName;
    }
    // Saved route IDs are compatibility identities. Preserve them rather than
    // applying the SDK whole-config migration's providerID alias collapse.
    return [id, Schema.encodeSync(ConfigProvider.Info)(Schema.decodeUnknownSync(ConfigProvider.Info)(result, {onExcessProperty: 'error'}))];
  }));
}

function nativeCompaction(input) {
  if (!record(input)) throw fail('native_compaction_invalid');
  if (input.keep !== undefined && !record(input.keep)) throw fail('native_compaction_invalid');
  const equivalent = (legacy, native) => {
    if (legacy !== undefined && native !== undefined && legacy !== native) throw fail('native_compaction_shapes_conflict');
    return native ?? legacy;
  };
  const tokens = equivalent(input.preserve_recent_tokens, input.keep?.tokens);
  const buffer = equivalent(input.reserved, input.buffer);
  // Pinned native Config.Compaction has no prune/tail_turns fields. The
  // authorized active inventory has neither setting, and the user prefers
  // native v2 retention. Preserve explicit legacy fields in compatibility.legacy
  // as data only; this translation does not claim their executable parity.
  const result = defined({auto: input.auto, keep: tokens === undefined ? undefined : {tokens}, buffer});
  return Schema.encodeSync(ConfigCompaction.Info)(Schema.decodeUnknownSync(ConfigCompaction.Info)(result, {onExcessProperty: 'error'}));
}

/** Convert data shapes only. Provider transports and plugin authority have separate owners. */
export function translateNativeConfiguration({ legacy, agents, commands = {} }) {
  if (!record(legacy) || !record(agents) || !record(commands)) throw fail('native_configuration_invalid');
  const configuration = {};
  for (const key of ['$schema', 'shell', 'username', 'default_agent', 'formatter', 'lsp', 'watcher']) {
    if (legacy[key] !== undefined) configuration[key] = structuredClone(legacy[key]);
  }
  if (legacy.compaction !== undefined) configuration.compaction = nativeCompaction(legacy.compaction);
  if (legacy.model !== undefined) configuration.model = nativeModelSelection(legacy.model, legacy.variant, Object.hasOwn(legacy, 'variant'));
  if (legacy.provider !== undefined) configuration.providers = nativeProviderConfigurations(legacy.provider);
  if (legacy.providers !== undefined) {
    if (!record(legacy.providers) || legacy.provider !== undefined) throw fail('native_provider_shapes_conflict');
    configuration.providers = structuredClone(legacy.providers);
  }
  if (legacy.permission !== undefined) configuration.permissions = nativePermissionRules(legacy.permission);
  configuration.agents = Object.fromEntries(Object.entries(agents).map(([name, agent]) => {
    if (!record(agent)) throw fail('native_agent_invalid');
    const info = {};
    for (const key of ['description', 'mode', 'hidden', 'color']) if (agent[key] !== undefined) info[key] = agent[key];
    if (agent.disable !== undefined || agent.disabled !== undefined) info.disabled = agent.disabled ?? agent.disable;
    if (agent.steps !== undefined || agent.maxSteps !== undefined) info.steps = agent.steps ?? agent.maxSteps;
    if (agent.prompt !== undefined) { if (typeof agent.prompt !== 'string') throw fail('native_agent_prompt_invalid'); info.system = agent.prompt; }
    if (agent.model !== undefined) info.model = nativeModelSelection(agent.model, agent.variant, Object.hasOwn(agent, 'variant'));
    else if (Object.hasOwn(agent, 'variant')) {
      if (legacy.model === undefined) throw fail('native_variant_without_model');
      info.model = nativeModelSelection(legacy.model, agent.variant, true);
    }
    const body = { ...(record(agent.options) ? agent.options : {}) };
    for (const key of ['temperature', 'top_p', 'reasoningEffort', 'thinking']) if (agent[key] !== undefined) body[key] = agent[key];
    if (Object.keys(body).length) info.request = { body };
    if (agent.permission !== undefined) info.permissions = nativePermissionRules(agent.permission);
    if (agent.permissions !== undefined) info.permissions = nativePermissionRules(agent.permissions);
    return [name, info];
  }));
  configuration.commands = Object.fromEntries(Object.entries(commands).map(([name, command]) => {
    if (!record(command) || typeof command.template !== 'string') throw fail('native_command_invalid');
    const info = { template: command.template };
    for (const key of ['description', 'agent', 'subtask', 'subagent']) if (command[key] !== undefined) info[key] = command[key];
    if (command.model !== undefined) info.model = nativeModelSelection(command.model, command.variant, Object.hasOwn(command, 'variant'));
    else if (Object.hasOwn(command, 'variant')) {
      const model = agents[command.agent ?? legacy.default_agent]?.model ?? legacy.model;
      if (model === undefined) throw fail('native_variant_without_model');
      info.model = nativeModelSelection(model, command.variant, true);
    }
    return [name, info];
  }));
  return { ...configuration, snapshots: false, warming: false, update: 'disable', share: 'disabled', plugins: [] };
}
