import {
  createXaiToolCatalogCache,
  isXaiProviderID,
  listXaiModelIds,
} from '@openchamber/orchestration-runtime';

import { resolveGen2OpenCodeClient } from './opencode-client-seam.js';

// Re-warm just under the cache's 15-minute TTL so an active directory never
// falls back to the in-request cold-start wait. Directories decay out of the
// periodic set once nothing has used them for the active window.
const DEFAULT_PERIODIC_REFRESH_INTERVAL_MS = 12 * 60 * 1000;
const PERIODIC_REFRESH_ACTIVE_WINDOW_MS = 60 * 60 * 1000;
const MAX_PERIODIC_REFRESH_DIRECTORIES = 8;
const REFRESH_TIMEOUT_MS = 20_000;

const normalizeString = (value) => (typeof value === 'string' ? value.trim() : '');

// A caller can leave a shared refresh without cancelling it for other callers.
const waitForSignal = (job, signal) => {
  if (!signal) return job;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    job.then((value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
};

const createXaiToolCatalogRuntime = ({
  openCodeClient = null,
  cache = createXaiToolCatalogCache(),
  logger = console,
} = {}) => {
  const inflight = new Map();
  const ownedControllers = new Set();
  const directoryLastUse = new Map();
  let periodicTimer = null;
  let disposed = false;

  const noteDirectoryUse = (directory) => {
    if (disposed) return;
    directoryLastUse.set(normalizeString(directory), Date.now());
  };

  const readWithinDeadline = async (load, callerSignal) => {
    const controller = new AbortController();
    const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
    ownedControllers.add(controller);
    const timer = setTimeout(() => controller.abort(new DOMException('Grok tool catalog refresh timed out', 'TimeoutError')), REFRESH_TIMEOUT_MS);
    timer.unref?.();
    try {
      // Race the whole read, including headers and JSON parsing. Some injected
      // transports ignore abort; they must still release this job on time.
      return await waitForSignal(load(signal), signal);
    } finally {
      clearTimeout(timer);
      ownedControllers.delete(controller);
    }
  };

  const gen2 = () => resolveGen2OpenCodeClient(openCodeClient);

  // Async, so an unknown generation (gen2() throws) is a rejected refresh.
  const readModelCatalog = async (directory, providerID, modelID) => {
    const client = gen2();
    return readWithinDeadline(async (signal) => {
      const snapshot = await client.catalog.tools({
        directory: normalizeString(directory) || undefined,
        providerID: normalizeString(providerID),
        modelID,
      }, { signal });
      return snapshot?.definitions ?? null;
    });
  };

  const readProviderPayload = async (directory, callerSignal) => {
    const client = gen2();
    return readWithinDeadline((signal) => client.catalog.providers({ directory: normalizeString(directory) || undefined }, { signal }),
      callerSignal);
  };

  const refreshModel = ({ directory, providerID = 'xai', modelID, signal } = {}) => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const normalizedModelID = normalizeString(modelID);
    if (disposed || !normalizedModelID || !isXaiProviderID(providerID)) return Promise.resolve(null);
    const key = [normalizeString(directory), normalizeString(providerID).toLowerCase(), normalizedModelID].join('\n');
    const existing = inflight.get(key);
    if (existing) return waitForSignal(existing, signal);

    const job = readModelCatalog(directory, providerID, normalizedModelID)
      .then((catalog) => {
        if (disposed || !Array.isArray(catalog)) return null;
        return cache.remember({ directory, providerID, modelID: normalizedModelID, catalog }) ?? {};
      })
      .catch((error) => {
        if (!disposed) logger.warn?.('[XAI] Failed to refresh the Grok tool catalog:', error instanceof Error ? error.message : error);
        return null;
      })
      .finally(() => {
        if (inflight.get(key) === job) inflight.delete(key);
      });
    inflight.set(key, job);
    return waitForSignal(job, signal);
  };

  const refreshProviderPayload = async ({ directory, payload, signal } = {}) => {
    if (disposed || signal?.aborted) return false;
    const modelIDs = listXaiModelIds(payload);
    if (modelIDs.length === 0) return false;
    const results = await Promise.allSettled(modelIDs.map((modelID) => refreshModel({
      directory,
      providerID: 'xai',
      modelID,
      signal,
    })));
    return results.some((result) => result.status === 'fulfilled' && result.value !== null);
  };

  const refreshDirectory = async ({ directory, signal, trackUse = true } = {}) => {
    if (disposed || signal?.aborted) return false;
    // Periodic re-warms pass trackUse:false so they never extend a directory's
    // own active window — only real use (sends, explicit warms) does.
    if (trackUse) noteDirectoryUse(directory);
    try {
      // Discovery is private to this call, so its wait and transport may share
      // the caller's cancellation. The subsequent model jobs stay independent.
      const payload = await readProviderPayload(directory, signal);
      if (!payload || typeof payload !== 'object') return false;
      return refreshProviderPayload({ directory, payload, signal });
    } catch (error) {
      if (!disposed && !signal?.aborted) logger.warn?.('[XAI] Failed to discover Grok models for tool prewarm:', error instanceof Error ? error.message : error);
      return false;
    }
  };

  const startPeriodicRefresh = ({ intervalMs = DEFAULT_PERIODIC_REFRESH_INTERVAL_MS } = {}) => {
    if (disposed || periodicTimer) return;
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
    dispose() {
      disposed = true;
      stopPeriodicRefresh();
      directoryLastUse.clear();
      for (const controller of ownedControllers) controller.abort();
    },
  };
};

export { createXaiToolCatalogRuntime };
