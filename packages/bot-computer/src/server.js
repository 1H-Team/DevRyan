import http from 'node:http';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createComputerAuthenticator, ComputerAuthError } from './auth.js';
import { createAccessibilityRefStore } from './refs.js';
import { createControlLeaseManager } from './control.js';
import { createScreencastBroker } from './screencast.js';
import { createProfileManager } from './profiles.js';
import { createWorkspaceGateway } from './workspace.js';
import { createBrowserController, launchChromiumDriver } from './browser.js';
import { createBrowserDiagnostics } from './browser-diagnostics.js';
import { startVirtualDisplay } from './display.js';
import { startBrowserEgressRelay } from './egress-proxy.js';
import { verifyManagedBrowserPolicy } from './managed-policy.js';

const DEFAULT_PORT = 43122;
const MAX_BODY_BYTES = 128 * 1024;
const STREAM_BOUNDARY = 'devryan-bot-jpeg';
const MAX_STREAM_BUFFER_BYTES = 4 * 1024 * 1024;
const GATEWAY_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,8192}$/;
const BROWSER_EGRESS_TOKEN_PATTERN = /^drb1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const serverSockets = new WeakMap();

class ComputerRequestError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name = 'ComputerRequestError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const requestFail = (message, code = 'DEVRYAN_BOT_COMPUTER_INPUT_INVALID', statusCode = 400) => {
  throw new ComputerRequestError(message, code, statusCode);
};

const readSingleHeader = (request, headerName) => {
  let value;
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() !== headerName) continue;
    count += 1;
    value = request.rawHeaders[index + 1];
  }
  return count === 1 ? value : undefined;
};

const readJson = async (request) => {
  if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    requestFail('Content-Type must be application/json', 'DEVRYAN_BOT_COMPUTER_CONTENT_TYPE_INVALID', 415);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      requestFail('Request body is too large', 'DEVRYAN_BOT_COMPUTER_INPUT_TOO_LARGE', 413);
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) requestFail('JSON object required');
    return value;
  } catch (error) {
    if (error instanceof ComputerRequestError) throw error;
    requestFail('Request body is invalid JSON');
  }
};

const sendJson = (response, statusCode, body, headers = {}) => {
  if (response.headersSent || response.destroyed) return;
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    ...headers,
  });
  response.end(payload);
};

const parseRoute = (request) => {
  let url;
  try {
    url = new URL(request.url, 'http://computer.invalid');
  } catch {
    requestFail('Request target is invalid');
  }
  if (url.search || url.hash) requestFail('Query parameters are not supported');
  return `${request.method} ${url.pathname}`;
};

const controlOwnerFromHeaders = (request) => ({
  actorId: readSingleHeader(request, 'x-devryan-actor-id'),
  actorType: readSingleHeader(request, 'x-devryan-actor-type'),
  leaseId: readSingleHeader(request, 'x-devryan-control-lease'),
});

const errorPayload = (error) => {
  if (error instanceof ComputerAuthError) {
    return { statusCode: 401, code: error.code, message: 'Authentication required' };
  }
  if (typeof error?.code === 'string' && error.code.startsWith('DEVRYAN_BOT_')) {
    return {
      statusCode: Number.isInteger(error.statusCode) ? error.statusCode : 500,
      code: error.code,
      message: typeof error.message === 'string' && error.message.length <= 512
        ? error.message
        : 'Computer request failed',
    };
  }
  return {
    statusCode: 500,
    code: 'DEVRYAN_BOT_COMPUTER_INTERNAL',
    message: 'Computer request failed',
  };
};

export function createComputerHttpServer({
  token,
  browser,
  control,
  screencast,
  rotateEgressToken = null,
  readiness = () => true,
} = {}) {
  if (!browser || typeof browser.execute !== 'function'
    || typeof browser.subscribeScreencast !== 'function' || !control || !screencast
    || (rotateEgressToken !== null && typeof rotateEgressToken !== 'function')
    || typeof readiness !== 'function') {
    throw new TypeError('Computer service dependencies are invalid');
  }
  const authenticate = createComputerAuthenticator({ token });
  const server = http.createServer(async (request, response) => {
    try {
      const route = parseRoute(request);
      if (route === 'GET /healthz') {
        const ready = readiness() === true;
        sendJson(response, ready ? 200 : 503, { ok: ready });
        return;
      }
      authenticate(readSingleHeader(request, 'authorization'));
      if (route === 'GET /v1/status') {
        sendJson(response, 200, {
          ok: true,
          browser: browser.status(),
          control: control.snapshot(),
          screencast: screencast.snapshot(),
        });
        return;
      }
      if (route === 'GET /v1/screencast') {
        let unsubscribe = null;
        let pendingFrame = null;
        let streaming = false;
        let cleaned = false;
        const writeFrame = ({ frame, width, height, deviceScaleFactor, capturedAt }) => {
          if (response.destroyed || response.writableEnded) return;
          if (response.writableLength > MAX_STREAM_BUFFER_BYTES) return;
          const header = Buffer.from(`--${STREAM_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.byteLength}\r\nX-DevRyan-Width: ${width || 0}\r\nX-DevRyan-Height: ${height || 0}\r\nX-DevRyan-Device-Scale-Factor: ${deviceScaleFactor || 0}\r\nX-DevRyan-Captured-At: ${capturedAt}\r\n\r\n`);
          response.write(Buffer.concat([header, frame, Buffer.from('\r\n')]));
        };
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          pendingFrame = null;
          const closeSubscription = unsubscribe;
          unsubscribe = null;
          void closeSubscription?.().catch(() => undefined);
        };
        request.once('aborted', cleanup);
        response.once('close', cleanup);
        unsubscribe = await browser.subscribeScreencast((event) => {
          if (cleaned) return;
          if (!streaming) {
            // Keep only the newest in-flight frame until multipart headers are
            // committed. This request-local handoff is cleared immediately and
            // is not a screencast cache.
            pendingFrame = event;
            return;
          }
          writeFrame(event);
        });
        if (cleaned || request.aborted || response.destroyed) {
          const closeSubscription = unsubscribe;
          unsubscribe = null;
          await closeSubscription?.().catch(() => undefined);
          return;
        }
        response.writeHead(200, {
          'cache-control': 'no-store, no-transform',
          connection: 'keep-alive',
          'content-type': `multipart/x-mixed-replace; boundary=${STREAM_BOUNDARY}`,
          'x-content-type-options': 'nosniff',
        });
        response.flushHeaders();
        streaming = true;
        if (pendingFrame) {
          const firstFrame = pendingFrame;
          pendingFrame = null;
          writeFrame(firstFrame);
        }
        return;
      }
      const routes = new Set([
        'POST /v1/command',
        'POST /v1/control/take',
        'POST /v1/control/heartbeat',
        'POST /v1/control/return',
        'POST /v1/control/command',
        'POST /v1/egress/rotate',
        'POST /v1/profile/reset',
      ]);
      if (!routes.has(route)) requestFail('Computer command was not found', 'DEVRYAN_BOT_COMPUTER_NOT_FOUND', 404);
      const body = await readJson(request);
      if (route === 'POST /v1/control/take') {
        sendJson(response, 200, { ok: true, lease: control.take(body) });
        return;
      }
      if (route === 'POST /v1/control/heartbeat') {
        sendJson(response, 200, { ok: true, lease: control.heartbeat(body) });
        return;
      }
      if (route === 'POST /v1/control/return') {
        sendJson(response, 200, { ok: true, result: await control.returnControl(body) });
        return;
      }
      if (route === 'POST /v1/profile/reset') {
        if (Object.keys(body).sort().join('\0') !== 'confirm' || body.confirm !== true) {
          requestFail('Profile reset requires explicit confirmation');
        }
        sendJson(response, 200, { ok: true, result: await browser.resetProfile() });
        return;
      }
      if (route === 'POST /v1/egress/rotate') {
        if (typeof rotateEgressToken !== 'function'
          || Object.keys(body).sort().join('\0') !== 'token'
          || !BROWSER_EGRESS_TOKEN_PATTERN.test(body.token || '')) {
          requestFail(
            'Browser egress capability rotation is invalid',
            'DEVRYAN_BOT_BROWSER_EGRESS_TOKEN_INVALID',
          );
        }
        rotateEgressToken(body.token);
        sendJson(response, 200, { ok: true, result: { rotated: true } });
        return;
      }
      if (route === 'POST /v1/control/command') {
        if (Object.keys(body).sort().join('\0') !== 'actorId\0actorType\0args\0command\0leaseId') {
          requestFail('Human browser command shape is invalid');
        }
        const owner = {
          actorId: body.actorId,
          actorType: body.actorType,
          leaseId: body.leaseId,
        };
        const assertAuthorized = () => control.assertOwner(owner);
        assertAuthorized();
        const gatewayToken = readSingleHeader(request, 'x-devryan-gateway-token');
        if (['upload', 'download'].includes(body.command) && !GATEWAY_TOKEN_PATTERN.test(gatewayToken || '')) {
          requestFail('Artifact gateway authorization is required', 'DEVRYAN_BOT_FILE_AUTH_INVALID', 401);
        }
        sendJson(response, 200, {
          ok: true,
          result: await browser.executeHuman(body.command, body.args, {
            gatewayToken: gatewayToken || null,
            assertAuthorized,
          }),
        });
        return;
      }
      if (Object.keys(body).sort().join('\0') !== 'args\0command') {
        requestFail('Agent browser command shape is invalid');
      }
      const abortController = new AbortController();
      request.once('aborted', () => abortController.abort());
      const gatewayToken = readSingleHeader(request, 'x-devryan-gateway-token');
      if (['upload', 'download'].includes(body.command) && !GATEWAY_TOKEN_PATTERN.test(gatewayToken || '')) {
        requestFail('Artifact gateway authorization is required', 'DEVRYAN_BOT_FILE_AUTH_INVALID', 401);
      }
      sendJson(response, 200, {
        ok: true,
        result: await browser.execute(body.command, body.args, {
          signal: abortController.signal,
          gatewayToken: gatewayToken || null,
        }),
      });
    } catch (error) {
      const failure = errorPayload(error);
      sendJson(response, failure.statusCode, {
        ok: false,
        error: { code: failure.code, message: failure.message },
      }, failure.statusCode === 401
        ? { 'www-authenticate': 'Bearer realm="devryan-bot-computer"' }
        : {});
    }
  });
  server.maxHeadersCount = 64;
  server.headersTimeout = 10_000;
  server.requestTimeout = 125_000;
  server.keepAliveTimeout = 5_000;
  const sockets = new Set();
  serverSockets.set(server, sockets);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return server;
}

export const closeComputerHttpServer = (server) => new Promise((resolve, reject) => {
  for (const socket of serverSockets.get(server) || []) socket.destroy();
  server.close((error) => (error ? reject(error) : resolve()));
  server.closeAllConnections?.();
});

export async function startComputerService({
  token,
  runId,
  scopeMode,
  gatewayUrl,
  profileDirectory = '/data/chromium',
  scratchDirectory = '/workspace',
  executablePath = '/usr/bin/chromium-browser',
  egressProxyUrl,
  egressToken,
  port = DEFAULT_PORT,
  host = '0.0.0.0',
  launchDriver,
  startDisplay = startVirtualDisplay,
  verifyPolicy = verifyManagedBrowserPolicy,
  diagnostics = createBrowserDiagnostics(),
  onControlEvent,
} = {}) {
  const egressRelay = await startBrowserEgressRelay({
    upstreamUrl: egressProxyUrl,
    token: egressToken,
    onDiagnostic: (event) => {
      if (event?.kind === 'egress_denied') diagnostics.recordEgressDenied(event);
    },
  });
  const profiles = createProfileManager({ profileDirectory, scratchDirectory, scopeMode });
  try {
    await profiles.initialize();
  } catch (error) {
    await egressRelay.close().catch(() => undefined);
    throw error;
  }
  let webCapabilities;
  let virtualDisplay;
  try {
    webCapabilities = await verifyPolicy();
    virtualDisplay = await startDisplay();
  } catch (error) {
    await egressRelay.close().catch(() => undefined);
    throw error;
  }
  const refs = createAccessibilityRefStore();
  const control = createControlLeaseManager({ onEvent: onControlEvent || (() => undefined) });
  const screencast = createScreencastBroker();
  const workspace = createWorkspaceGateway({
    scratchDirectory,
    gatewayUrl,
  });
  const browser = createBrowserController({
    launchDriver: launchDriver || (() => launchChromiumDriver({
      executablePath,
      profileDirectory,
      scratchDirectory,
      proxyUrl: egressRelay.proxyUrl,
      display: virtualDisplay.display,
      diagnostics,
    })),
    refs,
    control,
    workspace,
    profiles,
    screencast,
    diagnostics,
    environmentStatus: () => Object.freeze({
      mode: 'headed_virtual',
      engineVersion: null,
      displayReady: virtualDisplay.status().ready,
      webCapabilities,
    }),
  });
  virtualDisplay.onTerminated(() => {
    void browser.close().catch(() => undefined);
  });
  const server = createComputerHttpServer({
    token,
    browser,
    control,
    screencast,
    rotateEgressToken: (nextToken) => egressRelay.rotateToken(nextToken),
    readiness: () => (
      virtualDisplay.status().ready
      && webCapabilities.managedPolicy === 'enforced'
    ),
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    await browser.close().catch(() => undefined);
    await virtualDisplay.close().catch(() => undefined);
    await egressRelay.close().catch(() => undefined);
    throw error;
  }
  return Object.freeze({
    server,
    browser,
    control,
    screencast,
    egressRelay,
    virtualDisplay,
    address: server.address(),
    async close() {
      await browser.close();
      await virtualDisplay.close();
      await closeComputerHttpServer(server);
      await egressRelay.close();
    },
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  startComputerService({
    token: process.env.DEVRYAN_BOT_RUNTIME_TOKEN,
    runId: process.env.DEVRYAN_BOT_RUN_ID,
    scopeMode: process.env.DEVRYAN_BOT_SCOPE_MODE,
    gatewayUrl: process.env.DEVRYAN_BOT_GATEWAY_URL,
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser',
    egressProxyUrl: process.env.DEVRYAN_BROWSER_EGRESS_URL,
    egressToken: process.env.DEVRYAN_BROWSER_EGRESS_TOKEN,
    port: Number(process.env.DEVRYAN_BOT_COMPUTER_PORT || DEFAULT_PORT),
    onControlEvent: (event) => {
      console.log(`[bot-computer] control ${event.type} actor=${event.actorType}:${event.actorId}`);
    },
  }).then((runtime) => {
    const address = runtime.address;
    console.log(`[bot-computer] listening on port ${typeof address === 'object' ? address.port : DEFAULT_PORT}`);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await runtime.close().catch(() => undefined);
      process.exit(0);
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  }).catch((error) => {
    console.error(`[bot-computer] startup failed (${error?.code || 'unknown'})`);
    process.exitCode = 1;
  });
}
