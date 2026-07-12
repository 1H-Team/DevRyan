import crypto from 'node:crypto';
import http from 'node:http';

const DEFAULT_MAX_BODY_BYTES = 384 * 1024;
const LOOPBACK_ADDRESS = '127.0.0.1';

const writeJson = (response, statusCode, body) => {
  if (response.headersSent || response.destroyed) return;
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    connection: 'close',
    'content-length': Buffer.byteLength(serialized),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(serialized);
};

const isAuthorized = (header, token) => {
  const value = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice('Bearer '.length)
    : '';
  const expected = crypto.createHash('sha256').update(token).digest();
  const received = crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(expected, received);
};

const readBody = async (request, maxBodyBytes) => {
  const chunks = [];
  let byteLength = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    byteLength += chunk.byteLength;
    if (byteLength > maxBodyBytes) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    if (!tooLarge) chunks.push(chunk);
  }
  return {
    tooLarge,
    text: tooLarge ? '' : Buffer.concat(chunks, byteLength).toString('utf8'),
  };
};

const normalizeRequest = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('RPC body must be an object');
  }
  if (typeof value.method !== 'string' || !value.method.trim()) {
    throw new TypeError('RPC method is required');
  }
  if (
    value.params !== undefined
    && (!value.params || typeof value.params !== 'object' || Array.isArray(value.params))
  ) {
    throw new TypeError('RPC params must be an object');
  }
  return {
    method: value.method.trim(),
    params: value.params ?? {},
  };
};

export const createManagedOrchestrationPrivateHost = (options = {}) => {
  if (typeof options.handleRpc !== 'function') {
    throw new TypeError('handleRpc is required');
  }
  const handleRpc = options.handleRpc;
  const createToken = options.createToken ?? (() => crypto.randomBytes(32).toString('base64url'));
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new RangeError('maxBodyBytes must be a positive safe integer');
  }

  let server = null;
  let environment = null;
  let startPromise = null;
  let stopPromise = null;
  let activeRequests = 0;
  const requestControllers = new Set();

  const start = () => {
    if (environment) return Promise.resolve(environment);
    if (startPromise) return startPromise;
    if (stopPromise) {
      return stopPromise.then(() => start());
    }

    startPromise = new Promise((resolve, reject) => {
      const token = createToken();
      const nextServer = http.createServer(async (request, response) => {
        if (request.method !== 'POST' || request.url !== '/rpc') {
          writeJson(response, 404, {
            ok: false,
            error: { code: 'not_found', message: 'Not found' },
          });
          return;
        }
        if (!isAuthorized(request.headers.authorization, token)) {
          writeJson(response, 401, {
            ok: false,
            error: { code: 'unauthorized', message: 'Unauthorized' },
          });
          return;
        }

        const declaredLength = Number.parseInt(request.headers['content-length'] ?? '', 10);
        if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
          request.resume();
          writeJson(response, 413, {
            ok: false,
            error: { code: 'body_too_large', message: 'RPC body is too large' },
          });
          return;
        }

        activeRequests += 1;
        const controller = new AbortController();
        requestControllers.add(controller);
        request.once('aborted', () => controller.abort(new Error('RPC request aborted')));
        try {
          const body = await readBody(request, maxBodyBytes);
          if (body.tooLarge) {
            writeJson(response, 413, {
              ok: false,
              error: { code: 'body_too_large', message: 'RPC body is too large' },
            });
            return;
          }

          let parsed;
          try {
            parsed = normalizeRequest(JSON.parse(body.text));
          } catch (error) {
            writeJson(response, 400, {
              ok: false,
              error: {
                code: 'invalid_request',
                message: error instanceof Error ? error.message : 'Invalid RPC request',
              },
            });
            return;
          }

          const result = await handleRpc(parsed, { signal: controller.signal });
          writeJson(response, 200, { ok: true, result: result ?? null });
        } catch (error) {
          const hasCode = typeof error?.code === 'string' && error.code.length > 0;
          const statusCode = Number.isSafeInteger(error?.statusCode)
            && error.statusCode >= 400
            && error.statusCode <= 599
            ? error.statusCode
            : (hasCode ? 400 : 500);
          writeJson(response, statusCode, {
            ok: false,
            error: {
              code: hasCode ? error.code : 'internal_error',
              message: hasCode && error instanceof Error
                ? error.message
                : 'Managed orchestration RPC failed',
            },
          });
        } finally {
          requestControllers.delete(controller);
          activeRequests -= 1;
        }
      });
      nextServer.requestTimeout = 30_000;
      nextServer.headersTimeout = 10_000;
      nextServer.once('error', reject);
      nextServer.listen(0, LOOPBACK_ADDRESS, () => {
        nextServer.off('error', reject);
        const address = nextServer.address();
        if (!address || typeof address === 'string') {
          nextServer.close();
          reject(new Error('Managed orchestration host did not expose a TCP address'));
          return;
        }
        server = nextServer;
        environment = Object.freeze({
          DEVRYAN_ORCHESTRATION_URL: `http://${LOOPBACK_ADDRESS}:${address.port}/rpc`,
          DEVRYAN_ORCHESTRATION_TOKEN: token,
        });
        resolve(environment);
      });
    }).finally(() => {
      startPromise = null;
    });
    return startPromise;
  };

  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (startPromise) await startPromise.catch(() => undefined);
      const activeServer = server;
      server = null;
      environment = null;
      for (const controller of requestControllers) {
        controller.abort(new Error('Managed orchestration host stopped'));
      }
      if (!activeServer) return;
      await new Promise((resolve) => {
        activeServer.close(resolve);
        activeServer.closeAllConnections?.();
      });
    })().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  };

  return {
    start,
    stop,
    getEnvironment() {
      return environment;
    },
    getDiagnostics() {
      const address = server?.address();
      return {
        started: Boolean(environment),
        address: address && typeof address === 'object' ? address.address : null,
        port: address && typeof address === 'object' ? address.port : null,
        activeRequests,
      };
    },
  };
};
