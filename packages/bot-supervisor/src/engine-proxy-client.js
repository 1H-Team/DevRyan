import http from 'node:http';

import { BotDockerError } from './docker.js';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_REQUEST_BYTES = 36 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 36 * 1024 * 1024;
const ROUTES = Object.freeze({
  ensureReasoning: Object.freeze({ method: 'POST', path: '/v1/ensure/reasoning' }),
  ensureComputer: Object.freeze({ method: 'POST', path: '/v1/ensure/computer' }),
  status: Object.freeze({ method: 'POST', path: '/v1/status' }),
  stop: Object.freeze({ method: 'POST', path: '/v1/stop' }),
  reset: Object.freeze({ method: 'POST', path: '/v1/reset' }),
  writeWorkspace: Object.freeze({ method: 'POST', path: '/v1/workspace/write' }),
  importSharedFile: Object.freeze({ method: 'POST', path: '/v1/shared/import' }),
  exportWorkspaceImage: Object.freeze({ method: 'POST', path: '/v1/workspace/export-image' }),
  listWorkspace: Object.freeze({ method: 'POST', path: '/v1/workspace/list' }),
  listFilesystem: Object.freeze({ method: 'POST', path: '/v1/filesystem/list' }),
  listOwned: Object.freeze({ method: 'GET', path: '/v1/owned' }),
});

const configurationError = (message) => new BotDockerError(
  message,
  'bot_engine_proxy_configuration_invalid',
  { statusCode: 500 },
);

const normalizeEndpoint = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw configurationError('Bot engine proxy URL is invalid');
  }
  const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'http:' || (!loopback && url.hostname !== 'engine-proxy')
    || !url.port || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash) {
    throw configurationError('Bot engine proxy URL is invalid');
  }
  return Object.freeze({ hostname: url.hostname, port: Number(url.port) });
};

export function createBotEngineProxyClient({
  endpoint,
  token,
  request = http.request,
  timeoutMs = 120_000,
} = {}) {
  const target = normalizeEndpoint(endpoint);
  if (!TOKEN_PATTERN.test(token || '') || typeof request !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw configurationError('Bot engine proxy client is invalid');
  }

  const call = (operation, input = null) => new Promise((resolve, reject) => {
    const route = ROUTES[operation];
    if (!route) {
      reject(configurationError('Bot engine proxy operation is invalid'));
      return;
    }
    let payload = null;
    if (route.method === 'POST') {
      try {
        payload = Buffer.from(JSON.stringify(input), 'utf8');
      } catch {
        reject(configurationError('Bot engine proxy request is invalid'));
        return;
      }
      if (payload.byteLength < 2 || payload.byteLength > MAX_REQUEST_BYTES) {
        reject(configurationError('Bot engine proxy request is too large'));
        return;
      }
    }
    const clientRequest = request({
      hostname: target.hostname,
      port: target.port,
      method: route.method,
      path: route.path,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'x-devryan-engine-proxy-version': '1',
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': String(payload.byteLength),
        } : {}),
      },
    }, (response) => {
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          response.destroy(Object.assign(new Error('Bot engine proxy response is too large'), {
            code: 'EOVERFLOW',
          }));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.once('error', (error) => reject(new BotDockerError(
        'Bot engine proxy response failed',
        'bot_supervisor_docker_unavailable',
        { statusCode: 503, cause: error },
      )));
      response.once('end', () => {
        let decoded;
        try {
          decoded = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          reject(new BotDockerError(
            'Bot engine proxy returned invalid JSON',
            'bot_supervisor_docker_api_error',
            { statusCode: 502 },
          ));
          return;
        }
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)
          || typeof decoded.ok !== 'boolean') {
          reject(new BotDockerError(
            'Bot engine proxy returned an invalid response',
            'bot_supervisor_docker_api_error',
            { statusCode: 502 },
          ));
          return;
        }
        if (response.statusCode !== 200 || decoded.ok !== true) {
          reject(new BotDockerError(
            typeof decoded.error?.message === 'string'
              ? decoded.error.message.slice(0, 500)
              : 'Bot engine proxy rejected the request',
            typeof decoded.error?.code === 'string'
              ? decoded.error.code.slice(0, 120)
              : 'bot_supervisor_docker_api_error',
            { statusCode: Number(response.statusCode) || 502 },
          ));
          return;
        }
        resolve(operation === 'listOwned' ? decoded.containers : decoded.result);
      });
    });
    clientRequest.setTimeout(timeoutMs, () => clientRequest.destroy(Object.assign(
      new Error('Bot engine proxy timed out'),
      { code: 'ETIMEDOUT' },
    )));
    clientRequest.once('error', (error) => reject(new BotDockerError(
      'Bot engine proxy is unavailable',
      'bot_supervisor_docker_unavailable',
      { statusCode: 503, cause: error },
    )));
    clientRequest.end(payload || undefined);
  });

  return Object.freeze(Object.fromEntries(Object.keys(ROUTES).map((operation) => [
    operation,
    operation === 'listOwned' ? () => call(operation) : (input) => call(operation, input),
  ])));
}
