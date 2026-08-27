const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAXIMUM_BYTES = 4 * 1024 * 1024;
const REVIEWED_PROVIDER_EGRESS_HOSTS = Object.freeze({
  openai: Object.freeze({
    api: Object.freeze(['api.openai.com:443']),
    oauth: Object.freeze(['auth.openai.com:443', 'chatgpt.com:443']),
  }),
});

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const safeLabel = (value, fallback) => {
  const label = typeof value === 'string' ? value.trim() : '';
  return label && label.length <= 160 ? label : fallback;
};

const safeEgressHosts = (value) => (
  Array.isArray(value)
    ? value.filter((host) => (
        typeof host === 'string'
        && host.length > 0
        && host.length <= 2_048
        && !/[\u0000-\u0020\u007f]/u.test(host)
      )).slice(0, 32)
    : []
);

const safeAuthType = (value) => {
  const authType = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ['api', 'oauth'].includes(authType) ? authType : null;
};

export const resolveReviewedBotModelEgressHosts = ({
  providerId,
  authType,
  catalogHosts,
} = {}) => {
  const explicit = safeEgressHosts(catalogHosts);
  if (explicit.length > 0) return Object.freeze(explicit);
  const provider = typeof providerId === 'string' ? providerId.trim().toLowerCase() : '';
  const kind = authType === 'api_key' ? 'api' : safeAuthType(authType);
  return REVIEWED_PROVIDER_EGRESS_HOSTS[provider]?.[kind]
    ?? Object.freeze([]);
};

const publicConnections = (providerId, providerName, authType) => (
  authType === 'oauth'
    ? Object.freeze([Object.freeze({
        id: `host:${providerId}`,
        label: `${providerName} account`,
        kind: 'oauth',
        status: 'active',
      })])
    : Object.freeze([])
);

const publicVariants = (value) => {
  const entries = Array.isArray(value)
    ? value.map((variant) => (
        typeof variant === 'string'
          ? [variant, {}]
          : [variant?.id, variant]
      ))
    : (isRecord(value) ? Object.entries(value) : []);
  return entries.flatMap(([rawId, metadata]) => {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id || id.length > 120) return [];
    return [Object.freeze({
      id,
      name: safeLabel(metadata?.name, id),
      available: metadata?.available !== false && metadata?.enabled !== false,
    })];
  });
};

const publicModel = (providerId, authType, rawModelId, model) => {
  if (!isRecord(model)) return null;
  const modelId = safeLabel(model.id || model.modelId || model.modelID || rawModelId, '');
  if (!modelId) return null;
  const contextLimit = Number(model.contextLimit || model.limit?.context);
  const reviewedEgressHosts = resolveReviewedBotModelEgressHosts({
    providerId,
    authType,
    catalogHosts: model.egressHosts,
  });
  return Object.freeze({
    id: modelId,
    name: safeLabel(model.name, modelId),
    providerId,
    available: model.available !== false && model.enabled !== false,
    variants: Object.freeze(publicVariants(model.variants)),
    contextLimit: Number.isFinite(contextLimit) && contextLimit > 0 ? contextLimit : null,
    reviewedEgressHosts: Object.freeze(reviewedEgressHosts),
    egressReviewed: reviewedEgressHosts.length > 0,
  });
};

/**
 * Projects the live OpenCode provider catalog onto the small, secret-free
 * contract used by the Bot revision editor.
 */
export const sanitizeBotModelOptions = (catalog, {
  resolveAuthType = (_providerId, provider) => provider?.authType,
} = {}) => {
  if (typeof resolveAuthType !== 'function') invalid('Bot model catalog resolver is invalid');
  const providers = [];
  const appendProvider = (rawProviderId, provider) => {
    if (!isRecord(provider)) return;
    const providerId = safeLabel(provider.id || provider.providerId || rawProviderId, '');
    if (!providerId) return;
    const authType = safeAuthType(resolveAuthType(providerId, provider));
    const modelEntries = Array.isArray(provider.models)
      ? provider.models.map((model) => [model?.id || model?.modelId || model?.modelID, model])
      : (isRecord(provider.models) ? Object.entries(provider.models) : []);
    const models = modelEntries
      .map(([modelId, model]) => publicModel(providerId, authType, modelId, model))
      .filter(Boolean);
    const name = safeLabel(provider.name, providerId);
    providers.push(Object.freeze({
      id: providerId,
      name,
      available: provider.available !== false && provider.enabled !== false,
      authType,
      connections: publicConnections(providerId, name, authType),
      models: Object.freeze(models),
    }));
  };

  if (isRecord(catalog) && Object.hasOwn(catalog, 'providers')) {
    if (!Array.isArray(catalog.providers)) invalid('Bot model catalog response is invalid');
    for (const provider of catalog.providers) appendProvider(provider?.id, provider);
  } else if (isRecord(catalog) && !Array.isArray(catalog.models)) {
    for (const [providerId, provider] of Object.entries(catalog)) {
      if (providerId === 'default') continue;
      appendProvider(providerId, provider);
    }
  } else if (Array.isArray(catalog)) {
    const grouped = new Map();
    for (const model of catalog) {
      const providerId = safeLabel(model?.providerId || model?.providerID, '');
      if (!providerId) continue;
      const provider = grouped.get(providerId) || { id: providerId, models: [] };
      provider.models.push(model);
      grouped.set(providerId, provider);
    }
    for (const [providerId, provider] of grouped) appendProvider(providerId, provider);
  } else {
    invalid('Bot model catalog response is invalid');
  }

  return Object.freeze({
    available: true,
    providers: Object.freeze(providers),
  });
};

export class BotModelCatalogError extends Error {
  constructor(message, code = 'bot_model_catalog_unavailable', statusCode = 503) {
    super(message);
    this.name = 'BotModelCatalogError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const invalid = (message) => {
  throw new BotModelCatalogError(message, 'bot_model_catalog_invalid', 503);
};

const readBounded = async (response, maximumBytes) => {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    invalid('Bot model catalog response is too large');
  }
  if (!response.body?.getReader) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > maximumBytes) invalid('Bot model catalog response is too large');
    return body;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel('Bot model catalog response limit exceeded').catch(() => undefined);
        invalid('Bot model catalog response is too large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
};

export function createBotModelCatalogLoader({
  fetchImpl = fetch,
  buildUrl,
  getAuthHeaders = () => ({}),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maximumBytes = DEFAULT_MAXIMUM_BYTES,
  createTimeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
} = {}) {
  if (typeof fetchImpl !== 'function' || typeof buildUrl !== 'function'
    || typeof getAuthHeaders !== 'function' || typeof createTimeoutSignal !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100
    || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1_024) {
    throw new TypeError('Bot model catalog loader is misconfigured');
  }

  return async function loadBotModelCatalog() {
    try {
      const response = await fetchImpl(buildUrl(), {
        headers: { accept: 'application/json', ...getAuthHeaders() },
        redirect: 'error',
        signal: createTimeoutSignal(timeoutMs),
      });
      if (!response?.ok) {
        throw new BotModelCatalogError('Bot model catalog request failed');
      }
      const bytes = await readBounded(response, maximumBytes);
      let parsed;
      try {
        parsed = JSON.parse(bytes.toString('utf8'));
      } catch {
        invalid('Bot model catalog response is invalid');
      }
      if (!parsed || typeof parsed !== 'object') {
        invalid('Bot model catalog response is invalid');
      }
      return parsed;
    } catch (error) {
      if (error instanceof BotModelCatalogError) throw error;
      throw new BotModelCatalogError('Bot model catalog request failed');
    }
  };
}
