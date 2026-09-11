import crypto from 'node:crypto';
import path from 'node:path';
import { resolveHarnessPolicies } from '@openchamber/orchestration-runtime';
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

export const buildHarnessRunFingerprint = ({ runtimeVersion, selection = {}, agent, source, toolManifest,
  configuredPlugins, observedPlugins, policies = resolveHarnessPolicies() } = {}) => {
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
    runtimeVersion: identifier(runtimeVersion),
    selection: { providerID: identifier(selection.providerID), modelID: identifier(selection.modelID),
      agent: identifier(selection.agent), variant: identifier(selection.variant) },
    role: { source: ['packaged', 'project', 'user', 'custom', 'runtime'].includes(source?.scope) ? source.scope : 'unknown',
      sourceHash: typeof source?.path === 'string' ? hash(source.path) : null,
      contentHash: roleBody === null ? null : hash(roleBody), bytes: roleBody === null ? null : Buffer.byteLength(roleBody) },
    catalog: { contentHash: catalogAvailable ? hash(ordered((toolManifest.tools ?? []).map(({ id, description, parameters }) => ({ id, description, parameters })))) : null,
      idsHash: idsAvailable ? hash([...toolManifest.toolIds].sort()) : null,
      count: idsAvailable ? toolManifest.toolIds.length : null, availability: catalogAvailable ? 'available' : 'unavailable' },
    plugins: { configured: plugins, observed, observation: observed?.length ? 'factory_report' : 'unavailable' },
    policies: Object.fromEntries(['readOverlap', 'waitAny', 'compactResults', 'contextProjection'].map((key) => [key, policies[key] === true])),
  };
  return { ...value, configurationHash: hash(ordered(value)) };
};

export const createHarnessRunFingerprintReader = (options) => {
  const manifests = createHarnessToolManifestReader(options);
  const observations = new Map();
  const pending = new Map();
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
      return buildHarnessRunFingerprint({ runtimeVersion: health?.version, selection: context, agent, source, toolManifest,
        configuredPlugins: config?.plugin, observedPlugins: observations.get(context.directory),
        policies: resolveHarnessPolicies(options.environment ?? process.env) });
    })().finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  };
  return {
    read,
    observeContext(context = {}) {
      if (!identifier(context.sessionID) || typeof context.directory !== 'string') throw new TypeError('Invalid context observation scope');
      const payload = Object.fromEntries(['beforeBytes', 'projectedBytes', 'dynamicBytes'].map((key) => [key,
        Number.isSafeInteger(context[key]) && context[key] >= 0 ? context[key] : null]));
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
