const warnCacheClearFailure = (log, label, error) => {
  try {
    log?.warn?.(`[electron] failed to clear ${label}:`, error);
  } catch {
  }
};

// The desktop cache total spans the app session, the agent-browser partition,
// and every registered per-user manual Browser partition. All are reported and
// cleared together so "clear cache" means the whole desktop runtime.
const collectSessions = ({ defaultSession, browserSession, browserSessions = [] }) => {
  const targets = [];
  const seen = new Set();
  const add = (label, target) => {
    if (!target || seen.has(target)) return;
    seen.add(target);
    targets.push({ label, session: target });
  };
  add('application', defaultSession);
  add('browser', browserSession);
  for (const [index, target] of browserSessions.entries()) {
    add(`browser profile ${index + 1}`, target);
  }
  return targets;
};

const readCacheSize = async (label, target) => {
  if (typeof target?.getCacheSize !== 'function') {
    throw new Error('Electron cache size API is unavailable');
  }

  const sizeBytes = await target.getCacheSize();
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    throw new Error(`Electron returned an invalid cache size for the ${label} session`);
  }

  return Math.floor(sizeBytes);
};

export const getElectronRuntimeCacheInfo = async ({ defaultSession, browserSession, browserSessions } = {}) => {
  if (typeof defaultSession?.getCacheSize !== 'function') {
    throw new Error('Electron cache size API is unavailable');
  }

  const targets = collectSessions({ defaultSession, browserSession, browserSessions });
  let sizeBytes = 0;
  for (const { label, session } of targets) {
    sizeBytes += await readCacheSize(label, session);
  }

  return { sizeBytes };
};

export const clearElectronRuntimeCaches = async ({ defaultSession, browserSession, browserSessions, log } = {}) => {
  const errors = [];

  const run = async (label, action) => {
    if (typeof action !== 'function') return;
    try {
      await action();
    } catch (error) {
      errors.push(error);
      warnCacheClearFailure(log, label, error);
    }
  };

  for (const { label, session } of collectSessions({ defaultSession, browserSession, browserSessions })) {
    await run(`${label} HTTP cache`, () => session?.clearCache?.());
    await run(`${label} code cache`, () => session?.clearCodeCaches?.({ urls: [] }));
  }

  return {
    ok: errors.length === 0,
    errors,
  };
};
