const warnCacheClearFailure = (log, label, error) => {
  try {
    log?.warn?.(`[electron] failed to clear ${label}:`, error);
  } catch {
  }
};

// The desktop runs two caches: the app session (defaultSession) and the
// persistent partition backing the in-app browser pane. Both are reported and
// cleared together so "clear cache" means the whole desktop runtime.
const collectSessions = ({ defaultSession, browserSession }) => {
  const targets = [];
  if (defaultSession) targets.push({ label: 'application', session: defaultSession });
  if (browserSession && browserSession !== defaultSession) {
    targets.push({ label: 'browser', session: browserSession });
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

export const getElectronRuntimeCacheInfo = async ({ defaultSession, browserSession } = {}) => {
  if (typeof defaultSession?.getCacheSize !== 'function') {
    throw new Error('Electron cache size API is unavailable');
  }

  const targets = collectSessions({ defaultSession, browserSession });
  let sizeBytes = 0;
  for (const { label, session } of targets) {
    sizeBytes += await readCacheSize(label, session);
  }

  return { sizeBytes };
};

export const clearElectronRuntimeCaches = async ({ defaultSession, browserSession, log } = {}) => {
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

  for (const { label, session } of collectSessions({ defaultSession, browserSession })) {
    await run(`${label} HTTP cache`, () => session?.clearCache?.());
    await run(`${label} code cache`, () => session?.clearCodeCaches?.({ urls: [] }));
  }

  return {
    ok: errors.length === 0,
    errors,
  };
};
