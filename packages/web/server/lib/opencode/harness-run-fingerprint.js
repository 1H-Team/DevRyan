import crypto from 'node:crypto';
import path from 'node:path';
import { resolveHarnessPolicies, resolveNativeHarnessPolicies } from '@devryan/orchestration-runtime';
import { readDuplicatePluginInventory, qualifyDuplicateOutputs, resolveDuplicateOutputPolicy, createRuntimeDigestReader, createRuntimeIdentityReader, duplicatePolicyVector } from './harness-duplicate-qualification.js';
import { createHarnessToolManifestReader } from './harness-tool-manifest.js';
import { resolveGen2OpenCodeClient } from './opencode-client-seam.js';
import { describeAgentPromptTemplate, resolveAgentPromptPolicies } from './packaged-agents.js';
import { withPrimaryPlanModeInstructions } from './runtime-host/native-configuration-data.js';
import { parseMdFile } from './shared.js';
import { HARNESS_BEHAVIOUR_SWITCHES, normalizeBehaviourSwitch } from '@devryan/harness-runtime/lib/sanitizer.js';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value) => typeof value === 'string' && /^[a-zA-Z0-9@][a-zA-Z0-9_.@:/-]{0,255}$/.test(value)
  && !/^(?:https?:|file:|\/)|(?:token|password|secret|credential)=/i.test(value) ? value : null;
const hash = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const ordered = (value) => Array.isArray(value) ? value.map(ordered) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value;
const catalogAvailable = (toolManifest) => toolManifest?.availability?.catalog?.availability === 'available';
// A reviewed skill's ID hashes its location folder and file path
// (`runtime-host/reviewed-skills.js`), so identical skills get different IDs on hosts
// at different paths. Catalog hashes replace each ID with one placeholder; the skill
// tool lists every readable skill name beside its ID, so the skill set stays hashed.
const REVIEWED_SKILL_ID = /\bdevryan-[0-9a-f]{32}\b/g;
const hostNeutral = (value) => typeof value === 'string' ? value.replace(REVIEWED_SKILL_ID, 'devryan-<reviewed-skill>')
  : Array.isArray(value) ? value.map(hostNeutral)
    : object(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [hostNeutral(key), hostNeutral(item)])) : value;
const catalogEntry = ({ id, description, parameters }) => hostNeutral({ id, description, parameters });
const sourceIdentity = (spec) => {
  if (Array.isArray(spec)) spec = spec[0];
  if (typeof spec !== 'string') return null;
  const clean = spec.split(/[?#]/, 1)[0];
  return { name: identifier(path.basename(clean)), sourceHash: hash(clean) };
};

const POLICY_KEYS = ['readOverlap', 'waitAny', 'compactResults', 'contextProjection', 'duplicateOutputs', 'adaptiveDelegation'];
const POLICY_SOURCES = new Set(['runtime-projection', 'environment']);

/** Allowlisted behaviour switches as closed enum values; never raw environment text. */
export const captureBehaviourSwitches = (environment = {}) => Object.fromEntries(HARNESS_BEHAVIOUR_SWITCHES
  .map((name) => [name, normalizeBehaviourSwitch(typeof environment[name] === 'string' ? environment[name] : undefined)]));

export const buildHarnessRunFingerprint = ({ runtimeVersion, runtimeHash = null, selection = {}, agent, source, toolManifest,
  configuredPlugins, observedPlugins, pluginInventory = null, policies = resolveHarnessPolicies(), policySource = null,
  template = null, switches = null } = {}) => {
  const roleBody = typeof agent?.prompt === 'string' ? agent.prompt : null;
  const policyValues = Object.fromEntries(POLICY_KEYS.map((key) => [key, policies[key] === true]));
  // The host renders the unrendered role source for exactly these policies, then
  // applies what the native configuration appends for this agent (a primary
  // agent's Plan-mode instructions), so the attestation names its effective prompt.
  const derivation = describeAgentPromptTemplate(template, policyValues, (body) => withPrimaryPlanModeInstructions(body, {
    name: typeof agent?.name === 'string' ? agent.name : undefined, mode: agent?.mode, hidden: agent?.hidden === true,
    disabled: agent?.disabled === true || agent?.disable === true }));
  const catalogTools = catalogAvailable(toolManifest) && Array.isArray(toolManifest.tools) && toolManifest.tools.length <= 512
    ? toolManifest.tools.filter((tool) => object(tool) && typeof tool.id === 'string' && tool.id.length > 0 && tool.id.length <= 256)
      .map((tool) => ({ id: tool.id, contentHash: hash(ordered(catalogEntry(tool))) }))
      .sort((a, b) => a.id.localeCompare(b.id)) : null;
  const catalogIsAvailable = catalogAvailable(toolManifest);
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
    catalog: { contentHash: catalogIsAvailable ? hash(ordered((toolManifest.tools ?? []).map(catalogEntry))) : null,
      idsHash: idsAvailable ? hash([...toolManifest.toolIds].sort()) : null,
      count: idsAvailable ? toolManifest.toolIds.length : null, availability: catalogIsAvailable ? 'available' : 'unavailable',
      // Per-tool hashes let a comparison confine a schema delta to declared tools.
      tools: catalogTools },
    plugins: { configured: plugins, observed, inventory: pluginInventory, observation: observed?.length ? 'factory_report' : 'unavailable' },
    policies: policyValues,
    policySource: POLICY_SOURCES.has(policySource) ? policySource : 'unknown',
    switches: object(switches) ? Object.fromEntries(HARNESS_BEHAVIOUR_SWITCHES.map((name) => [name, normalizeBehaviourSwitch(
      typeof switches[name] === 'string' && switches[name] !== 'unset' ? switches[name] : undefined)])) : null,
  };
  // Rendered content stays checked evidence beside its derivation.
  Object.assign(value.role, derivation ?? { templateHash: null, rendererHash: null, rendererVersion: null, templatePolicies: null, attestedContentHash: null });
  return { ...value, configurationHash: hash(ordered(value)) };
};

export const createHarnessRunFingerprintReader = (options) => {
  const manifests = createHarnessToolManifestReader(options);
  const duplicateOutputs = resolveDuplicateOutputPolicy(options.environment ?? process.env, options.duplicateProfiles);
  const observations = new Map();
  const readRuntimeHash = createRuntimeDigestReader(options.getRuntimeBinary);
  const readRuntimeIdentity = createRuntimeIdentityReader(options.getRuntimeBinary, readRuntimeHash);
  let runtimeHash = null;
  let qualifiedRuntimeVersion = null;
  const pending = new Map();
  const inventories = new Map();
  const viaClient = async (load) => {
    try {
      const client = resolveGen2OpenCodeClient(options.openCodeClient);
      return { value: await load(client) };
    } catch { return { value: null }; }
  };
  /** `{healthy, version}` like `/global/health`; gen 2 reports the probed OpenCode version when ready. */
  const readHealth = async () => {
    const result = await viaClient(async (client) => {
      const probed = await client.health.probe({ timeoutMs: 5000 });
      return probed?.ready === true ? { healthy: true, version: probed.version } : null;
    });
    return result.value;
  };
  const readConfig = async (directory) => {
    const result = await viaClient((client) => client.catalog.config({ directory }, { timeoutMs: 5000 }));
    return result.value;
  };
  const readAgents = async (directory) => {
    const result = await viaClient((client) => client.catalog.agents({ directory }, { timeoutMs: 5000 }));
    return result.value;
  };
  // The unrendered role source the host attests renders against. Unknown or
  // unreadable sources stay null; they never borrow another role's template.
  const readTemplate = options.readAgentTemplate ?? ((source) => typeof source?.path === 'string' && path.isAbsolute(source.path)
    ? parseMdFile(source.path).body : null);
  // Prompts and this fingerprint share the runtime projection once it exists.
  const readPolicies = options.resolvePolicies ?? (() => {
    const resolved = resolveAgentPromptPolicies();
    return resolved.source === 'runtime-projection' ? resolved
      : { source: 'environment', policies: { ...resolveNativeHarnessPolicies(options.environment ?? process.env), duplicateOutputs } };
  });
  const read = async (context = {}) => {
    const key = JSON.stringify([context.directory, context.providerID, context.modelID, context.agent, context.variant]);
    if (pending.has(key)) return pending.get(key);
    const operation = (async () => {
      // Lazily read switches are captured at every read: run start and finish.
      const switches = captureBehaviourSwitches(options.environment ?? process.env);
      const [health, config, agents, toolManifest, currentRuntimeHash] = await Promise.all([
        readHealth(), readConfig(context.directory), readAgents(context.directory), manifests(context), readRuntimeHash(),
      ]);
      const agent = Array.isArray(agents) ? agents.find((entry) => entry?.name === context.agent) : null;
      let source, template = null;
      try { source = options.getAgentSource?.(context.agent, context.directory); } catch { /* unknown source */ }
      try { template = readTemplate(source); } catch { /* unreadable template stays unattested */ }
      const inventory = inventories.get(context.directory);
      const currentInventory = inventory && Array.isArray(config?.plugin)
        && inventory.configurationHash === hash(JSON.stringify(config.plugin))
        && inventory.providerHash === hash(JSON.stringify(ordered(config.provider ?? {}))) ? inventory : null;
      const resolved = readPolicies();
      return buildHarnessRunFingerprint({ runtimeVersion: health?.version,
        // The digest is re-validated against the binary's stat identity on
        // every read, so it names the artifact running now.
        runtimeHash: currentRuntimeHash ?? (health?.version === qualifiedRuntimeVersion ? runtimeHash : null),
        selection: context, agent, source, toolManifest, template, switches,
        configuredPlugins: config?.plugin, pluginInventory: currentInventory, observedPlugins: observations.get(context.directory),
        policies: resolved.policies, policySource: resolved.source });
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
      const [health, config, runtime] = await Promise.all([readHealth(), readConfig(context.directory), readRuntimeIdentity()]);
      runtimeHash = runtime.runtimeHash;
      qualifiedRuntimeVersion = health?.version ?? null;
      const inventory = await readDuplicatePluginInventory(config?.plugin, config?.provider);
      if (inventory) inventories.set(context.directory, inventory);
      else inventories.delete(context.directory);
      while (inventories.size > 64) inventories.delete(inventories.keys().next().value);
      let providerRoute;
      try { providerRoute = options.getDuplicateProviderRoute?.(context.providerID); } catch { /* Unavailable route cannot qualify. */ }
      const environment = options.environment ?? process.env;
      return qualifyDuplicateOutputs({ managed, enabled, runtimeVersion: health?.version, runtimeHash, companion: runtime.companion,
        policyVector: duplicatePolicyVector(environment), environment,
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
