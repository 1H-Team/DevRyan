import crypto from 'node:crypto';
import path from 'node:path';
import { resolveHarnessPolicies } from '@openchamber/orchestration-runtime';
import { readDuplicatePluginInventory, qualifyDuplicateOutputs, resolveDuplicateOutputPolicy, createRuntimeDigestReader } from './harness-duplicate-qualification.js';
import { createHarnessToolManifestReader } from './harness-tool-manifest.js';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value) => typeof value === 'string' && /^[a-zA-Z0-9@][a-zA-Z0-9_.@:/-]{0,255}$/.test(value)
  && !/^(?:https?:|file:|\/)|(?:token|password|secret|credential)=/i.test(value) ? value : null;
const hash = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const ordered = (value) => Array.isArray(value) ? value.map(ordered) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value;
const sourceIdentity = (spec) => {
  if (Array.isArray(spec)) spec = spec[0];
  if (typeof spec !== 'string') return null;
  const clean = spec.split(/[?#]/, 1)[0];
  return { name: identifier(path.basename(clean)), sourceHash: hash(clean) };
};

export const buildHarnessRunFingerprint = ({ runtimeVersion, runtimeHash = null, selection = {}, agent, source, toolManifest,
  configuredPlugins, observedPlugins, pluginInventory = null, policies = resolveHarnessPolicies() } = {}) => {
  const roleBody = typeof agent?.prompt === 'string' ? agent.prompt : null;
  const catalogAvailable = toolManifest?.availability?.catalog?.availability === 'available';
  const idsAvailable = toolManifest?.availability?.ids?.availability === 'available';
  const plugins = Array.isArray(configuredPlugins) ? configuredPlugins.map(sourceIdentity).filter(Boolean) : null;
  const observed = Array.isArray(observedPlugins) ? observedPlugins.slice(0, 128).filter((entry) => object(entry)
    && identifier(entry.name) && /^[a-f0-9]{64}$/.test(entry.contentHash ?? '')
    && Number.isSafeInteger(entry.factoryCalls) && entry.factoryCalls > 0).map((entry) => ({
    name: entry.name, contentHash: entry.contentHash, factoryCalls: entry.factoryCalls,
    ownership: ['managed', 'deferred', 'standalone'].includes(entry.ownership) ? entry.ownership : 'unknown',
  })).sort((a, b) => a.name.localeCompare(b.name)) : null;
  const value = {
    schemaVersion: 1,
    stage: 'resolved_runtime_configuration',
    runtimeVersion: identifier(runtimeVersion), runtimeHash: /^[a-f0-9]{64}$/.test(runtimeHash ?? '') ? runtimeHash : null,
    selection: { providerID: identifier(selection.providerID), modelID: identifier(selection.modelID),
      agent: identifier(selection.agent), variant: identifier(selection.variant) },
    role: { source: ['packaged', 'project', 'user', 'custom', 'runtime'].includes(source?.scope) ? source.scope : 'unknown',
      sourceHash: typeof source?.path === 'string' ? hash(source.path) : null,
      contentHash: roleBody === null ? null : hash(roleBody), bytes: roleBody === null ? null : Buffer.byteLength(roleBody) },
    catalog: { contentHash: catalogAvailable ? hash(ordered((toolManifest.tools ?? []).map(({ id, description, parameters }) => ({ id, description, parameters })))) : null,
      idsHash: idsAvailable ? hash([...toolManifest.toolIds].sort()) : null,
      count: idsAvailable ? toolManifest.toolIds.length : null, availability: catalogAvailable ? 'available' : 'unavailable' },
    plugins: { configured: plugins, observed, inventory: pluginInventory, observation: observed?.length ? 'factory_report' : 'unavailable' },
    policies: Object.fromEntries(['readOverlap', 'waitAny', 'compactResults', 'contextProjection', 'duplicateOutputs'].map((key) => [key, policies[key] === true])),
  };
  return { ...value, configurationHash: hash(ordered(value)) };
};

export const createHarnessRunFingerprintReader = (options) => {
  const manifests = createHarnessToolManifestReader(options);
  const duplicateOutputs = resolveDuplicateOutputPolicy(options.environment ?? process.env, options.duplicateProfiles);
  const observations = new Map();
  const readRuntimeHash = createRuntimeDigestReader(options.getRuntimeBinary);
  let runtimeHash = null;
  let qualifiedRuntimeVersion = null;
  const pending = new Map();
  const inventories = new Map();
  const request = async (pathname, directory) => {
    try {
      const url = new URL(options.buildOpenCodeUrl(pathname));
      if (directory) url.searchParams.set('directory', directory);
      const response = await options.fetchImpl(url, { headers: options.getOpenCodeAuthHeaders?.() ?? {}, signal: AbortSignal.timeout(5000) });
      if (!response.ok || !response.body) return null;
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 8 * 1024 * 1024) return null;
          chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } finally { await reader.cancel().catch(() => {}); }
    } catch { return null; }
  };
  const read = async (context = {}) => {
    const key = JSON.stringify([context.directory, context.providerID, context.modelID, context.agent, context.variant]);
    if (pending.has(key)) return pending.get(key);
    const operation = (async () => {
      const [health, config, agents, toolManifest] = await Promise.all([
        request('/global/health'), request('/config', context.directory), request('/agent', context.directory), manifests(context),
      ]);
      const agent = Array.isArray(agents) ? agents.find((entry) => entry?.name === context.agent) : null;
      let source;
      try { source = options.getAgentSource?.(context.agent, context.directory); } catch { /* unknown source */ }
      const inventory = inventories.get(context.directory);
      const currentInventory = inventory && Array.isArray(config?.plugin)
        && inventory.configurationHash === hash(JSON.stringify(config.plugin))
        && inventory.providerHash === hash(JSON.stringify(ordered(config.provider ?? {}))) ? inventory : null;
      return buildHarnessRunFingerprint({ runtimeVersion: health?.version,
        runtimeHash: health?.version === qualifiedRuntimeVersion ? runtimeHash : null, selection: context, agent, source, toolManifest,
        configuredPlugins: config?.plugin, pluginInventory: currentInventory, observedPlugins: observations.get(context.directory),
        policies: { ...resolveHarnessPolicies(options.environment ?? process.env), duplicateOutputs } });
    })().finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  };
  return {
    read,
    async qualifyDuplicates(context = {}) {
      const enabled = duplicateOutputs;
      const managed = options.isManaged?.() === true;
      if (!enabled || !managed || typeof context.directory !== 'string') return { qualified: false, reason: 'policy-or-runtime-unqualified' };
      const [health, config, binaryHash] = await Promise.all([request('/global/health'), request('/config', context.directory), readRuntimeHash()]);
      runtimeHash = binaryHash;
      qualifiedRuntimeVersion = health?.version ?? null;
      const inventory = await readDuplicatePluginInventory(config?.plugin, config?.provider);
      if (inventory) inventories.set(context.directory, inventory);
      else inventories.delete(context.directory);
      while (inventories.size > 64) inventories.delete(inventories.keys().next().value);
      let providerRoute;
      try { providerRoute = options.getDuplicateProviderRoute?.(context.providerID); } catch { /* Unavailable route cannot qualify. */ }
      return qualifyDuplicateOutputs({ managed, enabled, runtimeVersion: health?.version, runtimeHash,
        providerRoute,
        selection: { providerID: context.providerID, modelID: context.modelID, variant: context.variant ?? null },
        // Route qualification includes all configured options/models for the
        // selected provider. Unrelated provider settings are not this route's
        // release identity. The complete host/caller inventory must still agree.
        providerRouteHash: typeof context.providerID === 'string' && object(config?.provider?.[context.providerID])
          ? hash(JSON.stringify(ordered({ [context.providerID]: config.provider[context.providerID] }))) : null,
        inventory, callerInventory: context.inventory, profiles: options.duplicateProfiles });
    },
    observeContext(context = {}) {
      if (!identifier(context.sessionID) || typeof context.directory !== 'string') throw new TypeError('Invalid context observation scope');
      const payload = Object.fromEntries(['beforeBytes', 'projectedBytes', 'dynamicBytes', 'plannedReductions', 'appliedReductions', 'savedBytes'].map((key) => [key,
        Number.isSafeInteger(context[key]) && context[key] >= 0 ? context[key] : null]));
      payload.phase = ['hook-applied', 'summary-suppressed', 'checkpoint', 'checkpoint-unavailable'].includes(context.phase) ? context.phase : 'legacy-estimate';
      payload.reason = ['qualified', 'unqualified', 'canonical-state-unavailable', 'bridge-unavailable'].includes(context.reason) ? context.reason : null;
      payload.transformDurationMs = Number.isFinite(context.transformDurationMs) && context.transformDurationMs >= 0 ? context.transformDurationMs : null;
      // Hook RPCs cannot attest a final provider request. Only isolated wire
      // evidence records those sizes, outside the production journal.
      payload.finalRequestBytes = null;
      payload.sourceHash = /^[a-f0-9]{64}$/.test(context.sourceHash ?? '') ? context.sourceHash : null;
      options.recordDiagnostic?.({ type: 'lifecycle', event: 'harness_context_projected', sessionID: context.sessionID,
        directory: context.directory, payload });
      return { recorded: true };
    },
    async capture(context = {}) {
      if (!identifier(context.sessionID) || !identifier(context.messageID) || typeof context.directory !== 'string') {
        throw new TypeError('A scoped harness run identity is required');
      }
      // Observations describe factories that actually executed in the caller;
      // configured entries remain separate and cannot prove duplicate loading.
      if (Array.isArray(context.observedPlugins)) observations.set(context.directory, context.observedPlugins.slice(0, 128));
      while (observations.size > 64) observations.delete(observations.keys().next().value);
      const fingerprint = await read(context);
      options.recordDiagnostic?.({ type: 'lifecycle', event: 'harness_run_start', sessionID: context.sessionID,
        userMessageID: context.messageID, directory: context.directory, payload: { fingerprint } });
      return fingerprint;
    },
  };
};
