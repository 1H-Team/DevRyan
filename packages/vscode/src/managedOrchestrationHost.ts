import crypto from 'node:crypto';
import http from 'node:http';

const DEFAULT_MAX_RPC_BODY_BYTES = 384 * 1024;
const LOOPBACK_ADDRESS = '127.0.0.1';

type RuntimeError = Error & { code?: string; statusCode?: number };

export type ManagedOrchestrationRpcRequest = {
  method: string;
  params?: Record<string, unknown>;
};

export type ManagedOrchestrationRpcContext = {
  signal?: AbortSignal;
  /** Set only by the runtime's own auto-resume attempt; never by the bridge. */
  autoResume?: boolean;
};

export type ManagedOrchestrationBridgeEnvironment = Readonly<{
  DEVRYAN_ORCHESTRATION_URL: string;
  DEVRYAN_ORCHESTRATION_TOKEN: string;
}>;

export type VsCodeManagedOrchestrationPrivateHost = {
  start(): Promise<ManagedOrchestrationBridgeEnvironment>;
  stop(): Promise<void>;
  getDiagnostics(): {
    started: boolean;
    address: string | null;
    port: number | null;
    activeRequests: number;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const writeJson = (response: http.ServerResponse, statusCode: number, body: unknown) => {
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

const isAuthorized = (header: string | undefined, token: string) => {
  const value = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice('Bearer '.length)
    : '';
  const expected = crypto.createHash('sha256').update(token).digest();
  const received = crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(expected, received);
};

const normalizeRpcRequest = (value: unknown): ManagedOrchestrationRpcRequest => {
  if (!isRecord(value)) throw new TypeError('RPC body must be an object');
  if (typeof value.method !== 'string' || !value.method.trim()) {
    throw new TypeError('RPC method is required');
  }
  if (value.params !== undefined && !isRecord(value.params)) {
    throw new TypeError('RPC params must be an object');
  }
  return { method: value.method.trim(), params: value.params ?? {} };
};

const readRequestBody = async (request: http.IncomingMessage, maxBodyBytes: number) => {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maxBodyBytes) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    if (!tooLarge) chunks.push(buffer);
  }
  return { tooLarge, text: tooLarge ? '' : Buffer.concat(chunks, byteLength).toString('utf8') };
};

export const createVsCodeManagedOrchestrationHost = (options: {
  handleRpc(
    request: ManagedOrchestrationRpcRequest,
    context: ManagedOrchestrationRpcContext,
  ): Promise<unknown>;
  createToken?: () => string;
  maxBodyBytes?: number;
}): VsCodeManagedOrchestrationPrivateHost => {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_RPC_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new RangeError('maxBodyBytes must be a positive safe integer');
  }
  const createToken = options.createToken ?? (() => crypto.randomBytes(32).toString('base64url'));
  let server: http.Server | null = null;
  let environment: ManagedOrchestrationBridgeEnvironment | null = null;
  let startPromise: Promise<ManagedOrchestrationBridgeEnvironment> | null = null;
  let stopPromise: Promise<void> | null = null;
  let activeRequests = 0;
  const requestControllers = new Set<AbortController>();

  const start = (): Promise<ManagedOrchestrationBridgeEnvironment> => {
    if (environment) return Promise.resolve(environment);
    if (startPromise) return startPromise;
    if (stopPromise) return stopPromise.then(start);
    const operation = new Promise<ManagedOrchestrationBridgeEnvironment>((resolve, reject) => {
      const token = createToken();
      const nextServer = http.createServer(async (request, response) => {
        if (request.method !== 'POST' || request.url !== '/rpc') {
          writeJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Not found' } });
          return;
        }
        if (!isAuthorized(request.headers.authorization, token)) {
          writeJson(response, 401, { ok: false, error: { code: 'unauthorized', message: 'Unauthorized' } });
          return;
        }
        const declaredLength = Number.parseInt(request.headers['content-length'] ?? '', 10);
        if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
          request.resume();
          writeJson(response, 413, { ok: false, error: { code: 'body_too_large', message: 'RPC body is too large' } });
          return;
        }

        activeRequests += 1;
        const controller = new AbortController();
        requestControllers.add(controller);
        request.once('aborted', () => controller.abort(new Error('RPC request aborted')));
        try {
          const body = await readRequestBody(request, maxBodyBytes);
          if (body.tooLarge) {
            writeJson(response, 413, { ok: false, error: { code: 'body_too_large', message: 'RPC body is too large' } });
            return;
          }
          let parsed: ManagedOrchestrationRpcRequest;
          try {
            parsed = normalizeRpcRequest(JSON.parse(body.text));
          } catch (error) {
            writeJson(response, 400, {
              ok: false,
              error: { code: 'invalid_request', message: errorMessage(error) },
            });
            return;
          }
          const result = await options.handleRpc(parsed, { signal: controller.signal });
          writeJson(response, 200, { ok: true, result: result ?? null });
        } catch (error) {
          const runtimeError = error as RuntimeError;
          const hasCode = typeof runtimeError?.code === 'string' && runtimeError.code.length > 0;
          const statusCode = Number.isSafeInteger(runtimeError?.statusCode)
            && Number(runtimeError.statusCode) >= 400
            && Number(runtimeError.statusCode) <= 599
            ? Number(runtimeError.statusCode)
            : (hasCode ? 400 : 500);
          writeJson(response, statusCode, {
            ok: false,
            error: {
              code: hasCode ? runtimeError.code : 'internal_error',
              message: hasCode ? errorMessage(error) : 'Managed orchestration RPC failed',
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
    }).finally(() => { startPromise = null; });
    startPromise = operation;
    return operation;
  };

  const stop = (): Promise<void> => {
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
      await new Promise<void>((resolve) => {
        activeServer.close(() => resolve());
        activeServer.closeAllConnections?.();
      });
    })().finally(() => { stopPromise = null; });
    return stopPromise;
  };

  return {
    start,
    stop,
    getDiagnostics: () => {
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
