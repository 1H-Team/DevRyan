import {
  createXaiToolCatalogCache,
  isXaiProviderID,
  listXaiModelIds,
} from '@openchamber/orchestration-runtime';

// Re-warm just under the cache's 15-minute TTL so an active directory never
// falls back to the in-request cold-start wait. Directories decay out of the
// periodic set once nothing has used them for the active window.
const DEFAULT_PERIODIC_REFRESH_INTERVAL_MS = 12 * 60 * 1000;
const PERIODIC_REFRESH_ACTIVE_WINDOW_MS = 60 * 60 * 1000;
const MAX_PERIODIC_REFRESH_DIRECTORIES = 8;

const normalizeString = (value) => (typeof value === 'string' ? value.trim() : '');

const createXaiToolCatalogRuntime = ({
  fetchImpl = fetch,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders = () => ({}),
  cache = createXaiToolCatalogCache(),
  logger = console,
} = {}) => {
  const inflight = new Map();
  const directoryLastUse = new Map();
  let periodicTimer = null;

  const noteDirectoryUse = (directory) => {
    directoryLastUse.set(normalizeString(directory), Date.now());
  };

  const buildUrl = (requestPath, directory, providerID, modelID) => {
    if (typeof buildOpenCodeUrl !== 'function') return null;
    const url = new URL(buildOpenCodeUrl(requestPath, ''));
    if (normalizeString(directory)) url.searchParams.set('directory', normalizeString(directory));
    if (normalizeString(providerID)) url.searchParams.set('provider', normalizeString(providerID));
    if (normalizeString(modelID)) url.searchParams.set('model', normalizeString(modelID));
    return url.toString();
  };

  const readJson = async (url, signal) => {
    if (!url) return null;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...await getOpenCodeAuthHeaders(),
      },
      signal,
    });
    if (!response?.ok) return null;
    return response.json().catch(() => null);
  };

  const refreshModel = ({ directory, providerID = 'xai', modelID, signal } = {}) => {
    const normalizedModelID = normalizeString(modelID);
    if (!normalizedModelID) return Promise.resolve(null);
    const key = [normalizeString(directory), normalizeString(providerID).toLowerCase(), normalizedModelID].join('\n');
    const existing = inflight.get(key);
    if (existing) return existing;

    const job = readJson(buildUrl('/experimental/tool', directory, providerID, normalizedModelID), signal)
      .then((catalog) => {
        if (!Array.isArray(catalog)) return null;
        return cache.remember({ directory, providerID, modelID: normalizedModelID, catalog });
      })
      .catch((error) => {
        logger.warn?.('[XAI] Failed to refresh the Grok tool catalog:', error instanceof Error ? error.message : error);
        return null;
      })
      .finally(() => {
        if (inflight.get(key) === job) inflight.delete(key);
      });
    inflight.set(key, job);
    return job;
  };

  const refreshProviderPayload = async ({ directory, payload, signal } = {}) => {
    const modelIDs = listXaiModelIds(payload);
    if (modelIDs.length === 0) return false;
    const results = await Promise.allSettled(modelIDs.map((modelID) => refreshModel({
      directory,
      providerID: 'xai',
      modelID,
      signal,
    })));
    return results.some((result) => result.status === 'fulfilled');
  };

  const refreshDirectory = async ({ directory, signal, trackUse = true } = {}) => {
    // Periodic re-warms pass trackUse:false so they never extend a directory's
    // own active window — only real use (sends, explicit warms) does.
    if (trackUse) noteDirectoryUse(directory);
    try {
      const payload = await readJson(buildUrl('/config/providers', directory), signal);
      if (!payload || typeof payload !== 'object') return false;
      return refreshProviderPayload({ directory, payload, signal });
    } catch (error) {
      logger.warn?.('[XAI] Failed to discover Grok models for tool prewarm:', error instanceof Error ? error.message : error);
      return false;
    }
  };

  const startPeriodicRefresh = ({ intervalMs = DEFAULT_PERIODIC_REFRESH_INTERVAL_MS } = {}) => {
    if (periodicTimer) return;
    periodicTimer = setInterval(() => {
      const cutoff = Date.now() - PERIODIC_REFRESH_ACTIVE_WINDOW_MS;
      const activeDirectories = [...directoryLastUse.entries()]
        .filter(([, lastUsedAt]) => lastUsedAt >= cutoff)
        .sort((left, right) => right[1] - left[1])
        .slice(0, MAX_PERIODIC_REFRESH_DIRECTORIES);
      for (const [directory] of activeDirectories) {
        void refreshDirectory({ directory, trackUse: false });
      }
      for (const [directory, lastUsedAt] of directoryLastUse) {
        if (lastUsedAt < cutoff) directoryLastUse.delete(directory);
      }
    }, intervalMs);
    periodicTimer.unref?.();
  };

  const stopPeriodicRefresh = () => {
    if (!periodicTimer) return;
    clearInterval(periodicTimer);
    periodicTimer = null;
  };

  return {
    supportsProvider: isXaiProviderID,
    getPromptToolOverrides(input = {}) {
      noteDirectoryUse(input.directory);
      return cache.get(input);
    },
    refreshDirectory,
    refreshModel,
    refreshProviderPayload,
    startPeriodicRefresh,
    stopPeriodicRefresh,
  };
};

export { createXaiToolCatalogRuntime };
