const SESSION_COOKIE = 'devryan_runtime_service';
const MAX_BOOTSTRAP_TOKEN_LENGTH = 256;
const MAX_BROKER_TOKEN_LENGTH = 256;
const DESKTOP_HOST_LEASE_TTL_MS = 30_000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CAPABILITIES = new Set(['focus', 'notifications', 'browser_cdp']);

const isLoopbackAddress = (value) => {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  return normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1';
};

const parseCookies = (header) => {
  const result = new Map();
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && !result.has(name)) result.set(name, value);
  }
  return result;
};

const sessionFromRequest = (request) => parseCookies(request.headers?.cookie).get(SESSION_COOKIE) || '';

const hasCsrfHeader = (request) => (
  request.headers?.['x-devryan-csrf'] === '1'
  || request.get?.('x-devryan-csrf') === '1'
);

const exactObject = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const validUuid = (value) => (
  typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
);

const unauthorized = (res, code = 'runtime_service_session_required') => res.status(401).json({
  error: 'Runtime service session required',
  code,
});

const validateDesktopHostLease = (body) => {
  if (!exactObject(body, ['leaseId', 'brokerPort', 'brokerToken', 'capabilities'])
    || !validUuid(body.leaseId)
    || !Number.isSafeInteger(body.brokerPort)
    || body.brokerPort < 1
    || body.brokerPort > 65_535
    || typeof body.brokerToken !== 'string'
    || body.brokerToken.length < 32
    || body.brokerToken.length > MAX_BROKER_TOKEN_LENGTH
    || !Array.isArray(body.capabilities)
    || body.capabilities.length === 0
    || body.capabilities.length > CAPABILITIES.size
    || new Set(body.capabilities).size !== body.capabilities.length
    || body.capabilities.some((value) => !CAPABILITIES.has(value))) {
    return null;
  }
  return Object.freeze({
    leaseId: body.leaseId,
    brokerPort: body.brokerPort,
    brokerToken: body.brokerToken,
    capabilities: Object.freeze([...body.capabilities].sort()),
  });
};

export const registerRuntimeServiceRoutes = (app, {
  controller,
  server,
  onDesktopHostLease,
  onDesktopHostRelease,
  botRuntimeControl,
  onDisableRuntimeService,
  onPrepareRuntimeServiceUpdate,
  now = () => new Date(),
} = {}) => {
  if (!controller
    || typeof controller.consumeBootstrap !== 'function'
    || typeof controller.authorizeSession !== 'function'
    || typeof controller.publicStatus !== 'function') {
    throw new Error('Runtime service route controller is invalid');
  }

  app.post('/auth/runtime-service-bootstrap', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!isLoopbackAddress(req.socket?.remoteAddress) || !hasCsrfHeader(req)) {
      return unauthorized(res, 'runtime_service_bootstrap_rejected');
    }
    const token = exactObject(req.body, ['token']) && typeof req.body.token === 'string'
      ? req.body.token
      : '';
    if (!token || token.length > MAX_BOOTSTRAP_TOKEN_LENGTH) {
      return unauthorized(res, 'runtime_service_bootstrap_rejected');
    }
    try {
      const session = await controller.consumeBootstrap(token);
      res.setHeader(
        'Set-Cookie',
        `${SESSION_COOKIE}=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`,
      );
      return res.status(204).end();
    } catch {
      return unauthorized(res, 'runtime_service_bootstrap_rejected');
    }
  });

  const requireRuntimeSession = (req, res, next) => {
    if (req.path === '/health' || req.path === '/api/health') return next();
    if (!controller.authorizeSession(sessionFromRequest(req))) return unauthorized(res);
    if (!SAFE_METHODS.has(String(req.method || '').toUpperCase()) && !hasCsrfHeader(req)) {
      return res.status(403).json({
        error: 'Missing CSRF request header',
        code: 'runtime_service_csrf_required',
      });
    }
    return next();
  };
  app.use(requireRuntimeSession);

  app.get('/api/runtime-service/handshake', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.json(controller.publicStatus());
  });

  app.post('/api/runtime-service/desktop-host', async (req, res) => {
    const lease = validateDesktopHostLease(req.body);
    if (!lease) {
      return res.status(400).json({
        error: 'Desktop host lease is invalid',
        code: 'desktop_host_lease_invalid',
      });
    }
    try {
      const expiresAt = new Date(now().getTime() + DESKTOP_HOST_LEASE_TTL_MS).toISOString();
      await onDesktopHostLease?.({ ...lease, expiresAt });
      await controller.update({
        desktopHost: {
          state: 'connected',
          leaseId: lease.leaseId,
          expiresAt,
          capabilities: lease.capabilities,
        },
      });
      return res.json(controller.publicStatus());
    } catch (error) {
      return res.status(503).json({
        error: 'Desktop host lease could not be registered',
        code: typeof error?.code === 'string' ? error.code : 'desktop_host_unavailable',
      });
    }
  });

  app.delete('/api/runtime-service/desktop-host/:leaseId', async (req, res) => {
    if (!validUuid(req.params?.leaseId)) {
      return res.status(400).json({ error: 'Desktop host lease is invalid', code: 'desktop_host_lease_invalid' });
    }
    try {
      await onDesktopHostRelease?.(req.params.leaseId);
      const current = controller.publicStatus()?.desktopHost;
      if (current?.leaseId === req.params.leaseId) {
        await controller.update({
          desktopHost: {
            state: 'unavailable',
            leaseId: null,
            expiresAt: null,
            capabilities: [],
          },
        });
      }
      return res.status(204).end();
    } catch {
      return res.status(503).json({
        error: 'Desktop host lease could not be released',
        code: 'desktop_host_unavailable',
      });
    }
  });

  const runtimeOperations = Object.freeze({
    status: { method: 'GET', handler: 'status' },
    operation: { method: 'GET', handler: 'operationStatus' },
    setup: { method: 'POST', handler: 'setup' },
    repair: { method: 'POST', handler: 'repair' },
    update: { method: 'POST', handler: 'update' },
    rollback: { method: 'POST', handler: 'rollback' },
  });
  for (const [operation, contract] of Object.entries(runtimeOperations)) {
    app[contract.method.toLowerCase()](`/api/runtime-service/bot-runtime/${operation}`, async (_req, res) => {
      const handler = botRuntimeControl?.[contract.handler];
      if (typeof handler !== 'function') {
        return res.status(503).json({
          error: 'Bot runtime control is unavailable',
          code: 'bot_runtime_unsupported_host',
        });
      }
      try {
        return res.json((await handler()) ?? null);
      } catch (error) {
        return res.status(503).json({
          error: 'Bot runtime operation failed',
          code: typeof error?.code === 'string' ? error.code : 'bot_runtime_operation_failed',
        });
      }
    });
  }

  app.post('/api/runtime-service/disable', async (_req, res) => {
    if (typeof onDisableRuntimeService !== 'function') {
      return res.status(503).json({
        error: 'Runtime service control is unavailable',
        code: 'runtime_service_control_unavailable',
      });
    }
    try {
      await onDisableRuntimeService();
      res.status(202).json({ state: 'stopping' });
      return undefined;
    } catch (error) {
      return res.status(503).json({
        error: 'Runtime service could not be stopped',
        code: typeof error?.code === 'string' ? error.code : 'runtime_service_shutdown_failed',
      });
    }
  });

  app.post('/api/runtime-service/prepare-update', async (_req, res) => {
    if (typeof onPrepareRuntimeServiceUpdate !== 'function') {
      return res.status(503).json({
        error: 'Runtime service update control is unavailable',
        code: 'runtime_service_control_unavailable',
      });
    }
    try {
      await onPrepareRuntimeServiceUpdate();
      res.status(202).json({ state: 'updating' });
      return undefined;
    } catch (error) {
      return res.status(503).json({
        error: 'Runtime service could not prepare for update',
        code: typeof error?.code === 'string' ? error.code : 'runtime_service_update_prepare_failed',
      });
    }
  });

  if (server && typeof server.prependListener === 'function') {
    server.prependListener('upgrade', (request, socket) => {
      if (controller.authorizeSession(sessionFromRequest(request))) return;
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
    });
  }

  return Object.freeze({ requireRuntimeSession });
};
