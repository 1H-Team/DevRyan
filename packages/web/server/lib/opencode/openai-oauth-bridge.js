import crypto from 'node:crypto';
import http from 'node:http';

// UI-driven auth writes in the managed child share the coordinator's mutation
// queue, including other providers because OpenCode persists a whole auth file.
// Direct clients of independently managed OpenCode are outside this contract.
export function registerManagedOAuthMutationGate(app, { coordinator, isManaged }) {
  app.use((req, res, next) => {
    const authWrite = ['PUT', 'DELETE'].includes(req.method) && /^\/api\/auth\/[^/]+\/?$/.test(req.path);
    const callback = req.method === 'POST' && /^\/api\/provider\/[^/]+\/oauth\/callback\/?$/.test(req.path);
    if (!isManaged() || (!authWrite && !callback)) return next();
    void coordinator.withAuthMutation(() => new Promise((resolve) => {
      if (res.destroyed) { resolve(); return; }
      res.once('finish', resolve);
      res.once('close', () => {
        // An interrupted auth write may still be finishing in the child. Keep
        // coordinated work unavailable until its plugin next initializes.
        if (!res.writableFinished) coordinator.markStopped();
        resolve();
      });
      next();
    })).catch(() => {
      if (!res.headersSent) res.status(503).json({ code: 'bot_oauth_coordinator_unavailable' });
    });
  });
}

// Separate from UI authentication. Only a managed OpenCode child receives this
// capability, and the endpoint cannot select a provider, account, or target URL.
export function createOpenAiOAuthBridge({ coordinator }) {
  let token = null;
  let address = null;
  let starting = null;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    const supplied = req.headers.authorization;
    const expected = `Bearer ${token}`;
    if (!token || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
      || req.headers.host !== new URL(address).host || req.headers.origin || req.headers.cookie
      || Object.keys(req.headers).some((name) => name.startsWith('x-forwarded-') || ['sec-fetch-site', 'sec-fetch-dest'].includes(name))
      || typeof supplied !== 'string' || supplied.length !== expected.length
      || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      res.writeHead(403).end('{"code":"bot_oauth_access_denied"}');
      return;
    }
    try {
      if (req.method !== 'POST' || !['/ready', '/access'].includes(req.url)
        || (req.headers['content-length'] && req.headers['content-length'] !== '0') || req.headers['transfer-encoding']) {
        res.writeHead(400).end('{"code":"bot_oauth_request_invalid"}');
        return;
      }
      if (req.url === '/ready') {
        const oauth = coordinator.usesOAuth();
        if (oauth) coordinator.markReady();
        else coordinator.markStopped();
        // This is state inspection, not a provider call or a token refresh.
        const authState = coordinator.getAuthState();
        res.end(JSON.stringify({ protocol: 1, authState, oauth }));
        return;
      }
      const result = await coordinator.access();
      if (`Bearer ${token}` !== supplied) {
        res.writeHead(403).end('{"code":"bot_oauth_access_denied"}');
        return;
      }
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(error.statusCode || 503).end(JSON.stringify({ code: error.code || 'bot_oauth_coordinator_unavailable' }));
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 5_000;
  server.maxHeadersCount = 16;
  return Object.freeze({
    async environment() {
      coordinator.markStopped();
      if (!address) {
        starting ||= new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            token = crypto.randomBytes(32).toString('base64url');
            address = `http://127.0.0.1:${server.address().port}`;
            server.unref();
            resolve();
          });
        }).finally(() => { starting = null; });
        await starting;
      }
      // Every managed launch receives a new capability; previous processes
      // cannot keep readiness alive or use the bridge after replacement.
      token = crypto.randomBytes(32).toString('base64url');
      return { DEVRYAN_OPENAI_OAUTH_URL: address, DEVRYAN_OPENAI_OAUTH_TOKEN: token };
    },
    async close() {
      coordinator.markStopped();
      token = null;
      address = null;
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  });
}
