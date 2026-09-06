const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Keep startup polling outside the renderer. A pending renderer fetch can hold
// Runtime.evaluate past its own deadline while the native owner warms up.
export async function waitForQaHostReady({ origin, debugPort, checkAlive = () => {}, timeoutMs = 120000,
  requestTimeoutMs = 5000, intervalMs = 200 }) {
  const deadline = Date.now() + timeoutMs;
  let resolvedOrigin = origin;
  while (Date.now() < deadline) {
    checkAlive();
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
          const health = await response.json();
          if (health.isOpenCodeReady) return { origin: resolvedOrigin, openCodeVersion: health.openCodeVersion };
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
    await delay(intervalMs);
  }
  throw new Error('Timed out: initial OpenCode host readiness');
}
