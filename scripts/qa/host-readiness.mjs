const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export const projectQaStartupHealth = health => {
  const startup = health?.openCodeStartup;
  if (!startup || !['idle', 'starting', 'ready', 'failed'].includes(startup.state)
    || !Number.isSafeInteger(startup.attempt) || startup.attempt < 0) return null;
  return { state: startup.state, attempt: startup.attempt,
    code: typeof startup.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(startup.code) ? startup.code : null };
};

// Keep startup polling outside the renderer. A pending renderer fetch can hold
// Runtime.evaluate past its own deadline while the native owner warms up.
export async function waitForQaHostReady({ origin, debugPort, checkAlive = () => {}, timeoutMs = 120000,
  requestTimeoutMs = 5000, intervalMs = 200, onHealth }) {
  const deadline = Date.now() + timeoutMs;
  let resolvedOrigin = origin;
  while (Date.now() < deadline) {
    checkAlive();
    let health;
    try {
      if (!resolvedOrigin) {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(requestTimeoutMs) });
        if (response.ok) {
          const targets = await response.json();
          const page = targets.find(target => target.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+(?:\/|$)/.test(target.url));
          if (page) resolvedOrigin = new URL(page.url).origin;
        }
      }
      if (resolvedOrigin) {
        const response = await fetch(`${resolvedOrigin}/api/health`, { signal: AbortSignal.timeout(requestTimeoutMs) });
        if (response.ok) {
          health = await response.json();
        } else if (![502, 503].includes(response.status)) {
          throw new Error(`QA host readiness failed: HTTP ${response.status}`);
        }
      }
    } catch (error) {
      if (error.message.startsWith('QA host readiness failed:')) throw error;
      const refused = ['ECONNREFUSED', 'ConnectionRefused'].includes(error.code)
        || error.cause?.code === 'ECONNREFUSED';
      if (!refused && !['TimeoutError', 'AbortError', 'TypeError'].includes(error.name)) throw error;
    }
    if (health) {
      onHealth?.(health);
      const startup = projectQaStartupHealth(health);
      if (startup?.state === 'failed') {
        throw Object.assign(new Error(`QA host readiness failed: ${startup.code || 'OpenCode could not start'}`), {
          code: startup.code, attempt: startup.attempt,
        });
      }
      if (health.isOpenCodeReady) return { origin: resolvedOrigin, openCodeVersion: health.openCodeVersion };
    }
    await delay(intervalMs);
  }
  throw new Error('Timed out: initial OpenCode host readiness');
}
