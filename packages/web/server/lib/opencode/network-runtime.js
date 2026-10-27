import { probe, resolveManagedOpenCodeGeneration } from './readiness-probe.js';

export const createOpenCodeNetworkRuntime = (deps) => {
  const {
    state,
    getOpenCodeAuthHeaders,
    // Readiness of the runtime this server launched (DESIGN C.4): gen 1 asks
    // `/global/health`, gen 2 asks `/devryan/ready` and `/api/info`.
    probeOpenCodeReadiness = probe,
    resolveOpenCodeGeneration = () => resolveManagedOpenCodeGeneration(),
  } = deps;

  const normalizeApiPrefix = (prefix) => {
    if (!prefix) {
      return '';
    }

    if (prefix.includes('://')) {
      try {
        const parsed = new URL(prefix);
        return normalizeApiPrefix(parsed.pathname);
      } catch {
        return '';
      }
    }

    const trimmed = prefix.trim();
    if (!trimmed || trimmed === '/') {
      return '';
    }
    const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading;
  };

  const waitForReady = async (url, timeoutMs = 10000) => {
    const start = Date.now();
    const { generation } = resolveOpenCodeGeneration();
    while (Date.now() - start < timeoutMs) {
      try {
        const result = await probeOpenCodeReadiness({
          generation,
          baseUrl: url,
          headers: getOpenCodeAuthHeaders(),
          timeoutMs: 3000,
        });
        if (result.ready) {
          state.openCodeVersion = result.version;
          state.openCodeGeneration = result.generation;
          return true;
        }
        // An invalid generation never becomes ready; do not wait it out.
        if (result.reason === 'generation_invalid') return false;
      } catch {
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };

  const setDetectedOpenCodeApiPrefix = () => {
    state.openCodeApiPrefix = '';
    state.openCodeApiPrefixDetected = true;
    if (state.openCodeApiDetectionTimer) {
      clearTimeout(state.openCodeApiDetectionTimer);
      state.openCodeApiDetectionTimer = null;
    }
  };

  const buildOpenCodeUrl = (path, prefixOverride) => {
    if (!state.openCodePort) {
      const error = new Error('OpenCode port is not available');
      error.code = 'managed_runtime_unavailable';
      error.statusCode = 503;
      throw error;
    }
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const prefix = normalizeApiPrefix(prefixOverride !== undefined ? prefixOverride : '');
    const fullPath = `${prefix}${normalizedPath}`;
    const base = state.openCodeBaseUrl ?? `http://localhost:${state.openCodePort}`;
    return `${base}${fullPath}`;
  };

  const detectOpenCodeApiPrefix = () => {
    state.openCodeApiPrefixDetected = true;
    state.openCodeApiPrefix = '';
    return true;
  };

  const ensureOpenCodeApiPrefix = () => detectOpenCodeApiPrefix();

  const scheduleOpenCodeApiDetection = () => {
    return;
  };

  return {
    waitForReady,
    normalizeApiPrefix,
    setDetectedOpenCodeApiPrefix,
    buildOpenCodeUrl,
    ensureOpenCodeApiPrefix,
    scheduleOpenCodeApiDetection,
  };
};
