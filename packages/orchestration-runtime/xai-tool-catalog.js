const XAI_PROVIDER_IDS = new Set(['xai', 'grok', 'xai-oauth']);
const DEFAULT_CACHE_MAX_AGE_MS = 15 * 60 * 1000;
const DEFAULT_CACHE_MAX_ENTRIES = 64;
const DEFAULT_CACHE_MAX_BYTES = 1024 * 1024;
const MCP_TOOL_PREFIX = 'mcp__';

const normalizeString = (value) => (
  typeof value === 'string' ? value.trim() : ''
);

const normalizeProviderId = (value) => normalizeString(value).toLowerCase();
const isXaiProviderID = (value) => XAI_PROVIDER_IDS.has(normalizeProviderId(value));

const sortJsonValue = (value) => {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
};

const stableJson = (value) => {
  try {
    const encoded = JSON.stringify(sortJsonValue(value));
    return typeof encoded === 'string' ? encoded : '';
  } catch {
    return '';
  }
};

const normalizeDescription = (value) => normalizeString(value).replace(/\s+/g, ' ');

const parseMcpAlias = (toolId) => {
  const normalized = normalizeString(toolId);
  if (!normalized.startsWith(MCP_TOOL_PREFIX)) return null;
  const segments = normalized.split('__');
  if (segments.length < 3) return null;
  const canonicalId = segments.slice(2).join('__');
  return canonicalId ? { canonicalId, prefixedId: normalized } : null;
};

const haveEquivalentToolSchemas = (left, right) => (
  normalizeDescription(left?.description) === normalizeDescription(right?.description)
  && stableJson(left?.parameters) !== ''
  && stableJson(left?.parameters) === stableJson(right?.parameters)
);

const deriveXaiDuplicateToolOverrides = (catalog) => {
  if (!Array.isArray(catalog)) return null;
  const byId = new Map();
  for (const tool of catalog) {
    const id = normalizeString(tool?.id);
    if (!id || byId.has(id)) continue;
    byId.set(id, tool);
  }

  const overrides = {};
  for (const [toolId, tool] of byId) {
    const alias = parseMcpAlias(toolId);
    if (!alias) continue;
    const canonical = byId.get(alias.canonicalId);
    if (!canonical || !haveEquivalentToolSchemas(canonical, tool)) continue;
    overrides[alias.prefixedId] = false;
  }
  return Object.keys(overrides).length > 0 ? overrides : null;
};

const listXaiModelIds = (providerPayload) => {
  const providers = Array.isArray(providerPayload?.providers) ? providerPayload.providers : [];
  const ids = [];
  const seen = new Set();
  for (const provider of providers) {
    if (!XAI_PROVIDER_IDS.has(normalizeProviderId(provider?.id))) continue;
    const models = provider?.models && typeof provider.models === 'object' && !Array.isArray(provider.models)
      ? provider.models
      : {};
    for (const [modelKey, model] of Object.entries(models)) {
      const id = normalizeString(model?.id) || normalizeString(modelKey);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
};

const createXaiToolCatalogCache = ({
  now = () => Date.now(),
  maxAgeMs = DEFAULT_CACHE_MAX_AGE_MS,
  maxEntries = DEFAULT_CACHE_MAX_ENTRIES,
  maxBytes = DEFAULT_CACHE_MAX_BYTES,
} = {}) => {
  const entries = new Map();
  let cachedBytes = 0;
  const normalizedMaxAgeMs = Number.isFinite(maxAgeMs) && maxAgeMs >= 0
    ? Math.trunc(maxAgeMs)
    : DEFAULT_CACHE_MAX_AGE_MS;
  const normalizedMaxEntries = Number.isFinite(maxEntries) && maxEntries > 0
    ? Math.trunc(maxEntries)
    : DEFAULT_CACHE_MAX_ENTRIES;
  const normalizedMaxBytes = Number.isFinite(maxBytes) && maxBytes > 0
    ? Math.trunc(maxBytes)
    : DEFAULT_CACHE_MAX_BYTES;

  const keyFor = ({ directory, providerID, modelID }) => [
    normalizeString(directory),
    normalizeProviderId(providerID),
    normalizeString(modelID),
  ].join('\n');

  const remove = (key) => {
    const existing = entries.get(key);
    if (!existing) return;
    cachedBytes = Math.max(0, cachedBytes - existing.bytes);
    entries.delete(key);
  };

  const measureBytes = (key, fingerprint, overrides) => new TextEncoder().encode(
    `${key}\n${fingerprint}\n${stableJson(overrides)}`,
  ).byteLength;

  const trim = () => {
    while (entries.size > normalizedMaxEntries || cachedBytes > normalizedMaxBytes) {
      const oldestKey = entries.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      remove(oldestKey);
    }
  };

  return {
    remember({ directory, providerID, modelID, catalog }) {
      const normalizedProviderID = normalizeProviderId(providerID);
      const normalizedModelID = normalizeString(modelID);
      if (!XAI_PROVIDER_IDS.has(normalizedProviderID) || !normalizedModelID || !Array.isArray(catalog)) {
        return null;
      }
      const overrides = deriveXaiDuplicateToolOverrides(catalog);
      const key = keyFor({ directory, providerID: normalizedProviderID, modelID: normalizedModelID });
      const fingerprint = stableJson(catalog);
      const bytes = measureBytes(key, fingerprint, overrides);
      remove(key);
      if (bytes > normalizedMaxBytes) return overrides;
      entries.set(key, {
        at: now(),
        bytes,
        fingerprint,
        overrides,
      });
      cachedBytes += bytes;
      trim();
      return overrides;
    },

    get({ directory, providerID, modelID }) {
      const normalizedProviderID = normalizeProviderId(providerID);
      if (!isXaiProviderID(normalizedProviderID)) return null;
      const key = keyFor({ directory, providerID: normalizedProviderID, modelID });
      const entry = entries.get(key);
      if (!entry) return null;
      if (Math.max(0, now() - entry.at) > normalizedMaxAgeMs) {
        remove(key);
        return null;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.overrides ? { ...entry.overrides } : {};
    },

    clear() {
      entries.clear();
      cachedBytes = 0;
    },
  };
};

export {
  DEFAULT_CACHE_MAX_AGE_MS,
  DEFAULT_CACHE_MAX_BYTES,
  DEFAULT_CACHE_MAX_ENTRIES,
  XAI_PROVIDER_IDS,
  createXaiToolCatalogCache,
  deriveXaiDuplicateToolOverrides,
  haveEquivalentToolSchemas,
  isXaiProviderID,
  listXaiModelIds,
};
