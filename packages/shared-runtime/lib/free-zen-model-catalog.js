export const FREE_ZEN_MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
export const FREE_ZEN_MODEL_CATALOG_TIMEOUT_MS = 8_000;

const ZEN_MODELS_URL = 'https://opencode.ai/zen/v1/models';
const MODELS_DEV_URL = 'https://models.dev/api.json';

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizeFreeModels = (zenPayload, metadataPayload) => {
  const metadataModels = isRecord(metadataPayload?.opencode?.models)
    ? metadataPayload.opencode.models
    : {};
  const rows = Array.isArray(zenPayload?.data) ? zenPayload.data : [];
  const seen = new Set();
  const models = [];

  for (const row of rows) {
    const id = typeof row?.id === 'string' ? row.id.trim() : '';
    const cost = id && isRecord(metadataModels[id]?.cost) ? metadataModels[id].cost : null;
    if (!id || seen.has(id) || cost?.input !== 0 || cost?.output !== 0) continue;
    seen.add(id);
    const ownedBy = typeof row?.owned_by === 'string' && row.owned_by.trim()
      ? row.owned_by.trim()
      : undefined;
    models.push(ownedBy ? { id, owned_by: ownedBy } : { id });
  }

  return models;
};

export const createFreeZenModelCatalog = ({
  fetchImpl = fetch,
  now = () => Date.now(),
  ttlMs = FREE_ZEN_MODEL_CATALOG_TTL_MS,
  timeoutMs = FREE_ZEN_MODEL_CATALOG_TIMEOUT_MS,
} = {}) => {
  let cached = null;
  let refreshPromise = null;

  const getCachedModels = ({ allowStale = true } = {}) => {
    if (!cached) return [];
    const fresh = now() - cached.at < Math.max(1, Number(ttlMs) || FREE_ZEN_MODEL_CATALOG_TTL_MS);
    return fresh || allowStale ? cached.models : [];
  };

  const getSnapshot = () => {
    if (!cached) return null;
    return {
      models: cached.models,
      at: cached.at,
      fresh: now() - cached.at < Math.max(1, Number(ttlMs) || FREE_ZEN_MODEL_CATALOG_TTL_MS),
    };
  };

  const fetchModels = async ({ force = false } = {}) => {
    const fresh = getCachedModels({ allowStale: false });
    if (!force && fresh.length > 0) return fresh;
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.max(1, Number(timeoutMs) || FREE_ZEN_MODEL_CATALOG_TIMEOUT_MS),
      );
      try {
        const [zenResponse, metadataResponse] = await Promise.all([
          fetchImpl(ZEN_MODELS_URL, {
            headers: { Accept: 'application/json' },
            signal: controller.signal,
          }),
          fetchImpl(MODELS_DEV_URL, {
            headers: { Accept: 'application/json' },
            signal: controller.signal,
          }),
        ]);
        if (!zenResponse?.ok) {
          throw new Error(`zen/v1/models responded with status ${zenResponse?.status ?? 'unknown'}`);
        }
        if (!metadataResponse?.ok) {
          throw new Error(`models.dev responded with status ${metadataResponse?.status ?? 'unknown'}`);
        }

        const models = normalizeFreeModels(
          await zenResponse.json(),
          await metadataResponse.json(),
        );
        cached = { models, at: now() };
        return models;
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => {
      refreshPromise = null;
    });

    return refreshPromise;
  };

  const prewarm = () => {
    void fetchModels().catch(() => {});
  };

  return {
    fetchModels,
    getCachedModels,
    getSnapshot,
    prewarm,
  };
};

export { normalizeFreeModels as normalizeFreeZenModels };
