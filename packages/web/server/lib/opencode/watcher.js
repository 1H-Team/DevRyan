import { createGlobalMessageStreamHub } from '../event-stream/global-hub.js';
import { resolveOpenCodeGeneration } from './opencode-generation.js';

// Canonical consumers receive projected events from the shared native hub.
// Standalone watchers own a private hub with the same projection and recovery.

export const createOpenCodeWatcherRuntime = (deps) => {
  const {
    waitForOpenCodePort,
    getOpenCodeAuthHeaders,
    onPayload,
    fetchImpl = fetch,
    upstreamReconnectDelayMs = 1000,
    generation2StallTimeoutMs,
    globalEventHub = null,
    openCodeClient = null,
    getOpenCodeRuntime = null,
    recordDiagnostic = null,
  } = deps;

  let abortController = null;
  let unsubscribeEvent = null;
  let unsubscribeStatus = null;
  let privateHub = null;

  const waitForRetryDelay = (signal) => new Promise((resolve) => {
    if (upstreamReconnectDelayMs <= 0 || signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, upstreamReconnectDelayMs);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });

  const unwrapGlobalEventPayload = (eventData) => {
    if (!eventData || typeof eventData !== 'object') {
      return null;
    }

    if (eventData.payload && typeof eventData.payload === 'object') {
      return eventData.payload;
    }

    return eventData;
  };

  const start = async () => {
    if (abortController) {
      return;
    }

    abortController = new AbortController();
    const signal = abortController.signal;

    while (!signal.aborted) {
      try {
        await waitForOpenCodePort();
      } catch (error) {
        if (signal.aborted) return;
        console.warn('[PushWatcher] OpenCode is not ready; retrying watcher startup', error?.message ?? error);
        await waitForRetryDelay(signal);
        continue;
      }
      try {
        const generation = globalEventHub ? globalEventHub.resolveGeneration?.() : resolveOpenCodeGeneration(openCodeClient);
        if (generation !== 2) throw new Error('Unsupported OpenCode runtime');
        break;
      } catch (error) {
        // Wait for explicit native runtime identity before subscribing.
        if (signal.aborted) return;
        console.warn('[PushWatcher] OpenCode runtime generation is unknown; retrying watcher startup', error?.message ?? error);
        await waitForRetryDelay(signal);
      }
    }
    if (signal.aborted) return;

    let hub = globalEventHub;
    if (!hub) {
      privateHub = createGlobalMessageStreamHub({
        getOpenCodeAuthHeaders,
        fetchImpl,
        upstreamReconnectDelayMs,
        generation2StallTimeoutMs,
        openCodeClient,
        getOpenCodeRuntime,
        recordDiagnostic,
      });
      hub = privateHub;
    }

    unsubscribeEvent = hub.subscribeEvent((event) => {
      if (event?.synthetic === true) {
        return;
      }
      const payload = unwrapGlobalEventPayload(event.payload);
      if (!payload || typeof payload !== 'object') {
        return;
      }
      onPayload(payload, typeof event.directory === 'string' && event.directory !== 'global' ? event.directory : null);
    });
    unsubscribeStatus = hub.subscribeStatus((status) => {
      if (signal.aborted) {
        return;
      }
      if (status.type === 'connect') {
        console.log('[PushWatcher] connected');
        return;
      }
      if (status.type === 'error' || status.type === 'initial-error') {
        console.warn('[PushWatcher] disconnected', status.error?.error?.message ?? status.error?.message ?? status.error);
      }
    });
    hub.start();
  };

  const stop = () => {
    if (!abortController) {
      return;
    }
    try {
      abortController.abort();
      unsubscribeEvent?.();
      unsubscribeStatus?.();
      privateHub?.stop();
    } catch {
    }
    privateHub = null;
    unsubscribeEvent = null;
    unsubscribeStatus = null;
    abortController = null;
  };

  return {
    start,
    stop,
  };
};
